const { test } = require('node:test');
const assert = require('node:assert');

// Force live (non-mock) so providers exercise the HTTP path with a fake fetch.
process.env.DO_API_TOKEN = 'test-token';
const { streamComplete, complete } = require('../lib/providers');

const ORIG_FETCH = global.fetch;
function withFetch(fn) {
  global.fetch = fn;
  return () => { global.fetch = ORIG_FETCH; };
}

const model = { id: 'deepseek-v4-flash-0731', provider: 'digitalocean', label: 'X' };

function openAIStreamResponse({ model: m = model.id, content = ['One', ' two'], reasoning = [], status = 200, usage } = {}) {
  const frames = [];
  frames.push(JSON.stringify({ choices: [{ delta: { content: '', role: 'assistant' }, finish_reason: null, index: 0 }], model: m, object: 'chat.completion.chunk' }));
  if (reasoning.length) frames.push(...reasoning.map((r) => JSON.stringify({ choices: [{ delta: { reasoning_content: r }, index: 0 }], model: m })));
  frames.push(...content.map((c) => JSON.stringify({ choices: [{ delta: { content: c }, index: 0 }], model: m })));
  frames.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], model: m }));
  if (usage) frames.push(JSON.stringify({ usage }));
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

test('streamComplete parses content, reasoning, tokens, and routed model', async () => {
  const reset = withFetch(async () => openAIStreamResponse({ model: 'deepseek-v4-pro', content: ['Hel', 'lo'], reasoning: ['think', 'ing'] }));
  try {
    const events = [];
    for await (const e of streamComplete(model, { prompt: 'p', maxTokens: 16 })) events.push(e);
    const text = events.filter((e) => e.token).map((e) => e.token).join('');
    const think = events.filter((e) => e.reasoning).map((e) => e.reasoning).join('');
    const done = events.find((e) => e.done);
    assert.ok(text.includes('Hello'), `got ${text}`);
    assert.strictEqual(think, 'thinking');
    assert.strictEqual(done.meta.selectedModel, 'deepseek-v4-pro'); // router reveal
    assert.ok(done.meta.latencyMs >= 0);
  } finally { reset(); }
});

test('complete() (non-stream) captures content, usage, and routed model', async () => {
  const reset = withFetch(async () => {
    const body = JSON.stringify({ model: 'deepseek-v4-pro', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    return new Response(body, { status: 200 });
  });
  try {
    const { text, meta } = await complete(model, { prompt: 'p', maxTokens: 8 });
    assert.strictEqual(text, 'OK');
    assert.strictEqual(meta.selectedModel, 'deepseek-v4-pro');
    assert.deepStrictEqual(meta.tokens, { in: 10, out: 2 });
  } finally { reset(); }
});

test('unknown model (404) and tier-locked (403) map to clear errors', async () => {
  const reset = withFetch(async (_u, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'nope') return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
    return new Response(JSON.stringify({ error: { message: 'tier locked' } }), { status: 403 });
  });
  try {
    await assert.rejects(() => complete({ ...model, id: 'nope' }, { prompt: 'p', maxTokens: 8 }), /404/);
    await assert.rejects(() => complete({ ...model, id: 'gpt-5' }, { prompt: 'p', maxTokens: 8 }), /403/);
  } finally { reset(); }
});

test('429 transient overload is retried with backoff, then succeeds', async () => {
  let calls = 0;
  const reset = withFetch(async (_u, init) => {
    calls++;
    if (calls < 3) return new Response(JSON.stringify({ error: { message: 'Platform overloaded' } }), { status: 429 });
    return new Response(JSON.stringify({ model: model.id, choices: [{ message: { content: 'recovered' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  });
  try {
    const { text } = await complete(model, { prompt: 'p', maxTokens: 8 });
    assert.strictEqual(text, 'recovered');
    assert.strictEqual(calls, 3, 'expected 2 retries then success');
  } finally { reset(); }
});

test('429 that never recovers surfaces the final 429 (bounded attempts)', async () => {
  let calls = 0;
  const reset = withFetch(async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Platform overloaded' } }), { status: 429 }); });
  try {
    await assert.rejects(() => complete(model, { prompt: 'p', maxTokens: 8 }), /429/);
    assert.ok(calls >= 2, `expected bounded retries, got ${calls}`);
  } finally { reset(); }
});
