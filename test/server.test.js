const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Integration: run the real Express app against a STUBBED provider (fake fetch).
process.env.DO_API_TOKEN = 'test-token'; // live (non-mock) path
const app = require('../server');

const ORIG_FETCH = global.fetch;
function stubFetch() {
  global.fetch = async (url, init) => {
    // Let the test's own calls to the local server go through the real fetch.
    if (String(url).startsWith('http://127.0.0.1') || String(url).startsWith('http://localhost')) {
      return ORIG_FETCH(url, init);
    }
    // Fake the provider's inference calls.
    const body = JSON.parse(init.body);
    if (body.stream && body.model === 'deepseek-v4-pro') return new Response('boom', { status: 500 }); // fail this one
    if (body.stream) {
      const frames = [
        { choices: [{ delta: { content: '', role: 'assistant' }, finish_reason: null, index: 0 }], model: body.model },
        { choices: [{ delta: { content: 'Hello ' }, index: 0 }], model: body.model },
        { choices: [{ delta: { content: 'World' }, index: 0 }], model: body.model },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], model: body.model },
      ];
      const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(sse, { status: 200 });
    }
    // moderator (non-stream)
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Consensus summary' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
  };
}

let server, base;
before(async () => {
  stubFetch();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { global.fetch = ORIG_FETCH; server.close(); });

test('GET /api/models returns catalog + limits', async () => {
  const r = await fetch(`${base}/api/models`);
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.mock, false);
  assert.ok(d.models.some((m) => m.id === 'router:general'));
  assert.ok(d.limits.maxModelsPerRun >= 1);
});

test('POST /api/run streams tokens then done; partial failure is isolated', async () => {
  const res = await fetch(`${base}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi', modelIds: ['deepseek-v4-flash-0731', 'deepseek-v4-pro'], options: { maxTokens: 32 }, moderate: false }),
  });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  const types = events.map((e) => e.type);
  assert.ok(types.includes('token'));
  assert.ok(types.includes('done'), `expected done: ${types}`);
  assert.ok(types.includes('error'), `expected one model to fail: ${types}`);
  assert.ok(types.includes('end'));
  const done = events.find((e) => e.type === 'done');
  assert.strictEqual(done.model, 'deepseek-v4-flash-0731', 'the healthy model completes');
  const err = events.find((e) => e.type === 'error');
  assert.ok(err && err.model === 'deepseek-v4-pro', 'the failing model surfaces an isolated error');
});

test('POST /api/run with moderate=true emits a consensus event', async () => {
  const res = await fetch(`${base}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi', modelIds: ['deepseek-v4-flash-0731'], options: {}, moderate: true }),
  });
  const text = await res.text();
  const events = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  assert.ok(events.some((e) => e.type === 'consensus_token'), `expected streamed consensus_token:\n${text}`);
  assert.ok(events.some((e) => e.type === 'consensus_done'), `expected consensus_done:\n${text}`);
});

test('validation: missing prompt -> 400', async () => {
  const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelIds: [] }) });
  assert.strictEqual(res.status, 400);
});
