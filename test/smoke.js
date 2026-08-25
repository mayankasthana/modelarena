#!/usr/bin/env node
/**
 * Smoke test — the thin contract check against the REAL DigitalOcean inference.
 *
 * Two modes:
 *   direct   (default) — calls inference.do-ai.run for each curated model and
 *             asserts 200 + non-empty. Needs DO_API_TOKEN. Catches catalog-ID
 *             drift, new 403/404s (tier locks), and gross endpoint failures.
 *   deployed — set SMOKE_URL=https://<app>.ondigitalocean.app to exercise the
 *             deployed server: checks /api/models and a small /api/run.
 *
 * Usage:  DO_API_TOKEN=... npm run smoke            # direct
 *         SMOKE_URL=... npm run smoke               # against deployed app
 */
const https = require('https');

const MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash-0731', 'llama-4-maverick', 'gemma-4-31B-it', 'mistral-3-14B', 'kimi-k3', 'router:general'];

function requestJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function smokeDeployed(base) {
  const cat = await requestJson(`${base}/api/models`);
  if (cat.status !== 200) throw new Error(`/api/models -> ${cat.status}`);
  const catalog = JSON.parse(cat.body);
  const ids = catalog.models.map((m) => m.id).slice(0, 2);
  const run = await requestJson(`${base}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'Say OK in one word.', modelIds: ids, options: { maxTokens: 16 }, moderate: false }),
  });
  if (run.status !== 200) throw new Error(`/api/run -> HTTP ${run.status}`);
  if (!run.body.includes('"type":"end"')) throw new Error('/api/run did not reach end event');
  console.log(`deployed smoke OK (${base}): ${ids.join(', ')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function smokeDirect() {
  const token = process.env.DO_API_TOKEN;
  if (!token) throw new Error('DO_API_TOKEN required for direct smoke (or set SMOKE_URL).');
  const base = process.env.DO_INFERENCE_BASE_URL || 'https://inference.do-ai.run/v1';
  let failed = 0;
  for (const id of MODELS) {
    // Retry transient gateway overload (429/5xx) — the app does the same.
    let r;
    for (let att = 0; att < 4; att++) {
      r = await requestJson(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Reply with the single word OK unless you cannot; then say NO.' }], max_tokens: 400 }),
      });
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
      if (att < 3) await sleep(500 * 2 ** att);
    }
    let ok = false;
    try {
      const d = JSON.parse(r.body);
      ok = r.status === 200 && (d.choices?.[0]?.message?.content || '').trim().length > 0;
    } catch { ok = false; }
    if (!ok) {
      failed++;
      console.error(`✗ ${id}: HTTP ${r.status} ${(r.body || '').slice(0, 160)}`);
    } else {
      console.log(`✓ ${id}`);
    }
  }
  if (failed) { console.error(`${failed} model(s) failed smoke`); process.exit(1); }
  console.log('all models OK');
}

(async () => {
  try { return process.env.SMOKE_URL ? await smokeDeployed(process.env.SMOKE_URL) : await smokeDirect(); }
  catch (e) { console.error('smoke failed:', e.message); process.exit(1); }
})();
