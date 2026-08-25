/* ModelArena client: catalog, model chips, SSE streaming into cards, advisor. */
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
  };

  const DEFAULT_PICKS = ['deepseek-v4-pro', 'deepseek-v4-flash-0731', 'kimi-k3', 'router:general', 'gemma-4-31B-it'];

  // --- small markdown renderer (bold, h4, lists, code, paragraphs) ----------
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
      else if (code) { /* code fences left as-is in the block below */ close(); }
      else { close(); html += `<p>${inline(esc(line))}</p>`; }
    }
    close();
    return html;
    function inline(s) {
      return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    }
  }

  // --- cost estimate ---------------------------------------------------------
  function estCost(model, tokens) {
    if (!model.rate || tokens == null) return null;
    const inr = (tokens.in || 0) / 1000 * (model.rate.in || 0);
    const out = (tokens.out || 0) / 1000 * (model.rate.out || 0);
    return inr + out;
  }
  const fmtUsd = (n) => (n == null ? '—' : `$${n.toFixed(4)}`);
  const fmtMs = (n) => (n == null ? '—' : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`);

  // --- catalog + chips --------------------------------------------------------
  async function loadCatalog() {
    try {
      const r = await fetch('/api/models');
      const data = await r.json();
      state.catalog = data;
      renderChips();
      $('#mode-badge').hidden = false;
      $('#mode-badge').className = 'badge ' + (data.mock ? 'mock' : 'live');
      $('#mode-badge').textContent = data.mock ? '● mock mode (no DO token)' : '● live (DigitalOcean inference)';
      const l = data.limits || {};
      $('#limits-note').textContent = `limits: ${l.maxModelsPerRun} models/run · ${l.runsPerMin}/min per IP · ${l.dailyTokenBudget.toLocaleString()} tokens/day budget`;
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
      b.className = 'chip';
      b.dataset.id = m.id;
      b.title = `${m.label} — ${m.description}\nstrengths: ${m.strengths}\nwatch: ${m.watch}`;
      b.innerHTML = `${m.label}<span class="arche">${m.archetype}</span>`;
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

  // --- run --------------------------------------------------------------------
  function cardEl(m) {
    return `
      <article class="card${m.archetype === 'auto' ? ' is-auto' : ''}" data-id="${m.id}">
        <div class="card-head">
          <div class="card-title">${m.label}<span class="arche-tag">${m.archetype}</span>
            <span class="pill streaming" data-role="pill">streaming</span></div>
          <div class="card-sub">${m.family} · ${m.description}</div>
        </div>
        <div class="card-body" data-role="body"></div>
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
      body: el.querySelector('[data-role=body]'),
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

  async function run() {
    const prompt = $('#prompt').value.trim();
    if (!prompt) { $('#prompt').focus(); return; }
    if (state.selected.size === 0) { alert('Select at least one model.'); return; }
    if (state.running) return;
    state.running = true;
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

    const updateStatus = () => {
      const done = Object.values(cards).filter((c) => c.done).length;
      const total = Object.keys(cards).length;
      $('#status-text').textContent = `${done}/${total} complete`;
      const s = Math.floor((performance.now() - state.startedAt) / 1000);
      $('#status-elapsed').textContent = `· ${s}s`;
    };
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
            $('#status-text').textContent = `starting ${evt.modelIds.length} models…`;
            break;
          case 'token':
            if (c) {
              if (!state.firstTokenAt[evt.model]) state.firstTokenAt[evt.model] = performance.now();
              c.body.textContent += evt.text;
            }
            break;
          case 'reasoning':
            if (c) {
              let t = c.body.previousElementSibling;
              if (!t || !t.classList.contains('thinking')) {
                t = document.createElement('div');
                t.className = 'card-body thinking';
                c.body.before(t);
              }
              if (t.textContent === 'thinking…') t.textContent = '';
              t.textContent += evt.text;
            }
            break;
          case 'done': {
            if (!c) break;
            c.done = true;
            c.pill.textContent = 'done';
            c.pill.className = 'pill done';
            const m = state.catalog.models.find((x) => x.id === evt.model);
            const ttft = state.firstTokenAt[evt.model] ? Math.round(state.firstTokenAt[evt.model] - state.startedAt) : null;
            const tok = evt.meta.tokens || {};
            const cost = estCost(m, tok);
            if (m && m.archetype === 'auto' && evt.meta.selectedModel && evt.meta.selectedModel !== m.id) {
              c.routed.hidden = false;
              c.routed.textContent = `Auto-Router chose: ${evt.meta.selectedModel}`;
            }
            c.foot.innerHTML =
              `<span>TTFT <b>${fmtMs(ttft)}</b></span>` +
              `<span>latency <b>${fmtMs(evt.meta.latencyMs)}</b></span>` +
              `<span>tokens <b>${(tok.out || 0)}</b></span>` +
              `<span>cost <b>${fmtUsd(cost)}</b></span>`;
            updateStatus();
            break;
          }
          case 'error':
            if (c) {
              c.done = true;
              c.pill.textContent = 'error';
              c.pill.className = 'pill error';
              c.body.textContent = `⚠ ${evt.message}`;
              updateStatus();
            }
            break;
          case 'consensus_start':
            $('#advisor').hidden = false;
            $('#advisor-body').innerHTML = '<p class="muted">Synthesizing consensus…</p>';
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
      updateStatus();
      $('#status-elapsed').textContent += ' · done';
      state.running = false;
      $('#run').disabled = false;
    }
  }

  // --- wiring ------------------------------------------------------------------
  $$('.example').forEach((b) =>
    b.addEventListener('click', () => {
      $('#prompt').value = b.dataset.prompt;
      $$('.example').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    })
  );
  $('#temp').addEventListener('input', () => ($('#temp-out').textContent = $('#temp').value));
  $('#mtok').addEventListener('input', () => ($('#mtok-out').textContent = $('#mtok').value));
  $('#run').addEventListener('click', run);

  loadCatalog();
})();
