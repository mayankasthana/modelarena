/* ModelArena client: DigitalOcean theme (light/dark), catalog, model chips,
   SSE streaming into cards, advisor synthesis. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    catalog: { models: [], limits: null, mock: false },
    selected: new Set(),
    running: false,
    startedAt: 0,
    firstTokenAt: {},
    totalCost: 0,
  };

  const DEFAULT_PICKS = ['deepseek-v4-pro', 'deepseek-v4-flash-0731', 'kimi-k3', 'router:general', 'gemma-4-31B-it'];

  /* =====================================================================
     Theme (light / dark / system) — persisted, honors prefers-color-scheme
     ===================================================================== */
  const THEMES = ['light', 'system', 'dark'];
  function resolveTheme(pref) {
    if (pref === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return pref;
  }
  function applyTheme(pref) {
    const resolved = resolveTheme(pref);
    document.documentElement.setAttribute('data-theme', resolved);
    $$('.theme-opt').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.theme === pref))
    );
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1016' : '#f5f7fa');
    try { localStorage.setItem('arena-theme', pref); } catch (e) { /* ignore */ }
  }
  function initTheme() {
    let pref = 'system';
    try { pref = localStorage.getItem('arena-theme') || 'system'; } catch (e) { /* ignore */ }
    if (!THEMES.includes(pref)) pref = 'system';
    $$('.theme-opt').forEach((b) =>
      b.addEventListener('click', () => applyTheme(b.dataset.theme))
    );
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const pref = localStorage.getItem('arena-theme') || 'system';
      if (pref === 'system') applyTheme('system');
    });
    applyTheme(pref);
  }

  /* =====================================================================
     Small markdown renderer (bold, h4, lists, code, paragraphs)
     ===================================================================== */
  function renderMarkdown(md) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = String(md || '').split('\n');
    let html = '';
    let inList = false;
    const close = () => { if (inList) { html += '</ul>'; inList = false; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { close(); continue; }
      const h = line.match(/^\*\*(.+?)\*\*\s*$/);
      const b = line.match(/^[-*]\s+(.*)$/);
      const code = line.match(/^```/);
      if (h) { close(); html += `<h4>${esc(h[1])}</h4>`; }
      else if (b) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(esc(b[1]))}</li>`; }
      else if (code) { close(); }
      else { close(); html += `<p>${inline(esc(line))}</p>`; }
    }
    close();
    return html;
    function inline(s) {
      return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    }
  }

  /* =====================================================================
     Cost estimate & formatters
     ===================================================================== */
  function estCost(model, tokens) {
    if (!model.rate || tokens == null) return null;
    const inr = (tokens.in || 0) / 1000 * (model.rate.in || 0);
    const out = (tokens.out || 0) / 1000 * (model.rate.out || 0);
    return inr + out;
  }
  const fmtUsd = (n) => (n == null ? '—' : `$${n.toFixed(4)}`);
  const fmtMs = (n) => (n == null ? '—' : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`);

  /* =====================================================================
     Catalog + chips
     ===================================================================== */
  async function loadCatalog() {
    try {
      const r = await fetch('/api/models');
      const data = await r.json();
      state.catalog = data;
      renderChips();
      const badge = $('#mode-badge');
      badge.hidden = false;
      badge.className = 'badge ' + (data.mock ? 'mock' : 'live');
      badge.textContent = data.mock ? 'mock mode · no DO token' : 'live · DigitalOcean inference';
      const l = data.limits || {};
      $('#limits-note').textContent = `limits · ${l.maxModelsPerRun} models/run  ${l.runsPerMin}/min per IP  ${(l.dailyTokenBudget || 0).toLocaleString()} tok/day`;
    } catch (e) {
      $('#model-chips').innerHTML = '<span class="hint">Failed to load model catalog.</span>';
    }
  }

  function renderChips() {
    const wrap = $('#model-chips');
    wrap.innerHTML = '';
    for (const m of state.catalog.models) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-chip' + (m.archetype === 'auto' ? ' is-auto' : '');
      b.dataset.id = m.id;
      b.title = `${m.label} — ${m.description}\nstrengths: ${m.strengths}\nwatch: ${m.watch}`;
      b.innerHTML = `<span class="dot" aria-hidden="true"></span>${m.label}<span class="arch">${m.archetype}</span>`;
      const on = DEFAULT_PICKS.includes(m.id);
      if (on) state.selected.add(m.id);
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => toggleChip(b, m.id));
      wrap.appendChild(b);
    }
  }
  function toggleChip(btn, id) {
    if (state.running) return;
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    btn.setAttribute('aria-pressed', String(state.selected.has(id)));
  }

  /* =====================================================================
     Status helpers
     ===================================================================== */
  function setStatus(text, phase) {
    const el = $('#status-text');
    let dot = '';
    if (phase) dot = `<span class="pulse-dot ${phase}"></span>`;
    else if (state.running) dot = '<span class="pulse-dot"></span>';
    el.innerHTML = dot + text;
  }
  function updateStatus() {
    const cards = $$('#results .card:not(.empty)');
    const done = cards.filter((c) => c.dataset.done === '1').length;
    const total = cards.length;
    setStatus(`${done}/${total} complete`, done === total ? 'done' : '');
    const pct = total ? (done / total) * 100 : 0;
    const fill = $('#status-fill');
    if (fill) fill.style.width = pct + '%';
    const s = Math.floor((performance.now() - state.startedAt) / 1000);
    $('#status-elapsed').textContent = `· ${s}s`;
    $('#status-cost').textContent = state.totalCost > 0 ? `· ~${fmtUsd(state.totalCost)}` : '';
  }

  function renderEmpty() {
    $('#results').innerHTML =
      '<div class="card empty" data-od-id="empty-state">' +
        '<div class="empty-title">Ready to compare</div>' +
        '<div class="empty-sub">results stream in here, in parallel</div>' +
      '</div>';
  }

  /* =====================================================================
     Card rendering
     ===================================================================== */
  function cardEl(m) {
    return `
      <article class="card${m.archetype === 'auto' ? ' is-auto' : ''}" data-id="${m.id}">
        <div class="card-head">
          <div class="card-title">${m.label}<span class="arche-tag ${m.archetype}">${m.archetype}</span>
            <span class="pill streaming" data-role="pill">streaming</span></div>
        </div>
        <div class="card-sub">${m.family} · ${m.description}</div>
        <div class="card-body" data-role="body"></div>
        <div data-role="thinking"></div>
        <div data-role="routed" hidden></div>
        <div class="card-foot" data-role="foot"></div>
      </article>`;
  }

  function addCard(m) {
    const grid = $('#results');
    const tpl = document.createElement('template');
    tpl.innerHTML = cardEl(m).trim();
    const el = tpl.content.firstElementChild;
    grid.appendChild(el);
    return {
      el,
      body: el.querySelector('[data-role=body]'),
      thinking: el.querySelector('[data-role=thinking]'),
      pill: el.querySelector('[data-role=pill]'),
      foot: el.querySelector('[data-role=foot]'),
      routed: el.querySelector('[data-role=routed]'),
    };
  }

  function sseReader(res, onEvent) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    return (async function pump() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try { onEvent(JSON.parse(payload)); } catch { /* ignore */ }
        }
      }
    })();
  }

  /* =====================================================================
     Run — parallel fan-out over one SSE channel
     ===================================================================== */
  async function run() {
    const prompt = $('#prompt').value.trim();
    if (!prompt) { $('#prompt').focus(); return; }
    if (state.selected.size === 0) { alert('Select at least one model.'); return; }
    if (state.running) return;
    state.running = true;
    state.totalCost = 0;
    $('#run').disabled = true;
    $('#statusbar').hidden = false;
    $('#advisor').hidden = true;
    $('#results').innerHTML = '';
    state.startedAt = performance.now();
    state.firstTokenAt = {};

    const cards = {};
    for (const id of state.selected) {
      const m = state.catalog.models.find((x) => x.id === id);
      cards[id] = addCard(m);
    }

    updateStatus();

    const tick = setInterval(() => {
      const s = Math.floor((performance.now() - state.startedAt) / 1000);
      $('#status-elapsed').textContent = `· ${s}s`;
    }, 1000);

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt,
          modelIds: [...state.selected],
          options: { temperature: +$('#temp').value, maxTokens: +$('#mtok').value },
          moderate: $('#moderate').checked,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        $('#status-text').textContent = `error ${res.status}: ${j.message || j.error || res.statusText}`;
        return;
      }

      await sseReader(res, (evt) => {
        const c = cards[evt.model];
        switch (evt.type) {
          case 'begin':
            setStatus(`starting ${evt.modelIds.length} models…`);
            break;
          case 'token':
            if (c) {
              if (!state.firstTokenAt[evt.model]) state.firstTokenAt[evt.model] = performance.now();
              c.body.textContent += evt.text;
            }
            break;
          case 'reasoning': {
            if (!c) break;
            let holder = c.thinking;
            if (!holder.querySelector('.thinking')) {
              const wrap = document.createElement('div');
              wrap.className = 'card-body thinking';
              wrap.innerHTML = '<span class="reason-label">reasoning</span><span data-rbody></span>';
              holder.appendChild(wrap);
            }
            holder.querySelector('[data-rbody]').textContent += evt.text;
            break;
          }
          case 'done': {
            if (!c) break;
            c.done = true;
            c.el.dataset.done = '1';
            c.pill.textContent = 'done';
            c.pill.className = 'pill done';
            const m = state.catalog.models.find((x) => x.id === evt.model);
            const ttft = state.firstTokenAt[evt.model] ? Math.round(state.firstTokenAt[evt.model] - state.startedAt) : null;
            const tok = evt.meta.tokens || {};
            const cost = estCost(m, tok);
            if (cost != null) state.totalCost += cost;
            if (m && m.archetype === 'auto' && evt.meta.selectedModel && evt.meta.selectedModel !== m.id) {
              c.routed.hidden = false;
              c.routed.innerHTML = `Chose <b>${evt.meta.selectedModel}</b>`;
            }
            c.foot.innerHTML =
              `<span>TTFT <b>${fmtMs(ttft)}</b></span>` +
              `<span>latency <b>${fmtMs(evt.meta.latencyMs)}</b></span>` +
              `<span class="m">tokens <b>${(tok.out || 0)}</b></span>` +
              `<span class="m">cost <b class="cost">${fmtUsd(cost)}</b></span>`;
            updateStatus();
            break;
          }
          case 'error':
            if (c) {
              c.done = true;
              c.el.dataset.done = '1';
              c.pill.textContent = 'error';
              c.pill.className = 'pill error';
              c.body.textContent = evt.message;
              c.body.classList.add('card-error');
              updateStatus();
            }
            break;
          case 'consensus_start':
            $('#advisor').hidden = false;
            $('#advisor-body').innerHTML = '<div class="advisor-loading"><span class="spin"></span>Synthesizing consensus across models…</div>';
            break;
          case 'consensus':
            $('#advisor-body').innerHTML = renderMarkdown(evt.text);
            if (evt.meta?.model) $('#status-cost').textContent = `· advisor: ${evt.meta.model}`;
            break;
          case 'consensus_error':
            $('#advisor-body').innerHTML = `<p class="muted">Advisor unavailable: ${evt.message}</p>`;
            break;
          case 'end':
            break;
        }
      });
    } catch (e) {
      $('#status-text').textContent = `run failed: ${e.message}`;
    } finally {
      clearInterval(tick);
      const done = $$('#results .card[data-done="1"]').length;
      const total = $$('#results .card:not(.empty)').length;
      setStatus(total ? `${done}/${total} complete` : 'finished', 'done');
      $('#status-elapsed').textContent += ' · done';
      const fill = $('#status-fill');
      if (fill) fill.style.width = (done ? 100 : 0) + '%';
      state.running = false;
      $('#run').disabled = false;
    }
  }

  /* =====================================================================
     Wiring
     ===================================================================== */
  $$('.example').forEach((b) =>
    b.addEventListener('click', () => {
      $('#prompt').value = b.dataset.prompt;
      updateCharCount();
      $$('.example').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    })
  );
  function updateCharCount() {
    const n = $('#prompt').value.length;
    const el = $('#char-count');
    el.textContent = `${n} / 8000`;
    el.classList.toggle('over', n > 7900);
  }
  $('#prompt').addEventListener('input', updateCharCount);
  $('#temp').addEventListener('input', () => ($('#temp-out').textContent = $('#temp').value));
  $('#mtok').addEventListener('input', () => ($('#mtok-out').textContent = $('#mtok').value));
  $('#run').addEventListener('click', run);

  initTheme();
  renderEmpty();
  updateCharCount();
  loadCatalog();
})();
