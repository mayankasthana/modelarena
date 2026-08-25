/**
 * Provider client — layer the HTTP shapes we speak onto one interface.
 *
 * Spoken shapes:
 *   - OpenAI-compatible `/v1/chat/completions` (DigitalOcean inference + every
 *     BYO endpoint that mirrors the protocol) — incl. SSE streaming with both
 *     `content` and `reasoning_content` (chain-of-thought) deltas.
 *   - Anthropic `/v1/messages` (optional alternate provider).
 *
 * Two behaviours earn their keep here: capturing the ROUTED model id (DO's
 * router answers under a different `model` than you called), and resilient
 * 429 handling (DO's gateway intermittently sheds load with 429 "Platform
 * overloaded" even when your account's rate limits are clean).
 */

const { providers } = require('./models');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errToMessage(e) {
  if (e && e.response) {
    const body = e.response.data || '';
    return `HTTP ${e.response.status}: ${JSON.stringify(body).slice(0, 500)}`;
  }
  return (e && e.message) || String(e);
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** fetch() that retries DO-style transient overload with backoff + jitter. */
async function retryableFetch(url, init, { maxAttempts = 4, baseMs = 400, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      lastErr = e;
      if (attempt + 1 >= maxAttempts) break;
      const w = baseMs * 2 ** attempt + Math.random() * 150;
      onRetry?.(attempt + 1, w);
      await sleep(w);
      continue;
    }
    if (!RETRYABLE.has(resp.status)) return resp; // 200/4xx -> pass through
    // Respect a Retry-After if present, else exponential backoff + jitter.
    const retryAfter = resp.headers.get('retry-after');
    const wait = retryAfter ? Number(retryAfter) * 1000 || baseMs : baseMs * 2 ** attempt + Math.random() * 150;
    if (attempt + 1 >= maxAttempts) return resp; // surface the final 429/5xx
    const capped = Math.min(wait, 8000);
    onRetry?.(attempt + 1, capped);
    await sleep(capped);
  }
  throw lastErr || new Error('request failed');
}

// ---------------------------------------------------------------------------
// Mock generator (used only when no DO token is configured)
// ---------------------------------------------------------------------------
function mockStream(model, { prompt }) {
  const lines = [
    `[${model.label}] Here is a deterministic mock answer to: "${String(prompt).slice(0, 80)}".`,
    'This simulates streaming output for local development when no inference token is set.',
    'Wire a DO_API_TOKEN to call the real DigitalOcean model.',
  ];
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Non-streamed completion (used for the moderator synthesis)
// ---------------------------------------------------------------------------
async function complete(model, { prompt, system, temperature = 0.7, maxTokens = 1024, onRetry } = {}) {
  const provider = providers[model.provider];
  if (!provider) throw new Error(`No provider configured for ${model.provider}`);
  if (!provider.apiKey) throw new Error(`Missing API key for provider "${model.provider}". Set it in your environment.`);
  if (provider.mock) {
    await sleep(120);
    return { text: mockStream(model, { prompt }), meta: { latencyMs: 120, retries: 0, tokens: { in: 0, out: 0 }, selectedModel: model.id } };
  }

  const started = Date.now();
  let retries = 0;
  const retry = (a, w) => { retries++; onRetry?.(a, w); };
  if (provider.type === 'anthropic') {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    if (prompt) messages.push({ role: 'user', content: prompt });
    const resp = await retryableFetch(`${provider.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model.id, max_tokens: maxTokens, temperature, messages: messages.filter((m) => m.content) }),
    }, { onRetry: retry });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
    const data = await resp.json();
    const content = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { text: content, meta: { latencyMs: Date.now() - started, retries, selectedModel: model.id, tokens: { in: data.usage?.input_tokens, out: data.usage?.output_tokens } } };
  }

  // OpenAI-compatible
  const resp = await retryableFetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: model.id,
      temperature,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...(prompt ? [{ role: 'user', content: prompt }] : []),
      ],
    }),
  }, { onRetry: retry });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  const data = await resp.json();
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    meta: {
      latencyMs: Date.now() - started,
      retries,
      selectedModel: data.model || model.id,
      tokens: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens },
    },
  };
}

// ---------------------------------------------------------------------------
// Streamed completion -> yields {token}|{reasoning}|{done, meta}
// ---------------------------------------------------------------------------
async function* streamComplete(model, { prompt, system, temperature = 0.7, maxTokens = 1024, onRetry } = {}) {
  const provider = providers[model.provider];
  if (!provider) throw new Error(`No provider configured for ${model.provider}`);
  if (!provider.apiKey) throw new Error(`Missing API key for provider "${model.provider}". Set it in your environment.`);

  if (provider.mock) {
    const full = mockStream(model, { prompt });
    for (const ch of full.match(/.{1,6}/gs) || []) {
      await sleep(40);
      yield { token: ch };
    }
    yield { done: true, meta: { latencyMs: 0, retries: 0, tokens: { in: 0, out: 0 }, selectedModel: model.id } };
    return;
  }

  const started = Date.now();
  let tokens = { in: 0, out: 0 };
  let reasoning = '';
  let content = '';
  let selectedModel = model.id;
  let sawFirst = false;
  let retries = 0;
  const retry = (a, w) => { retries++; onRetry?.(a, w); };

  const sse = async function* (resp) {
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          if (!sawFirst && chunk.model) selectedModel = chunk.model;
          sawFirst = true;
          const delta = chunk.choices?.[0]?.delta || {};
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            tokens.out += 1; // count chain-of-thought toward usage/cost
            yield { reasoning: delta.reasoning_content };
          }
          if (delta.content) {
            content += delta.content;
            tokens.out += 1;
            yield { token: delta.content };
          }
          if (chunk.usage) {
            tokens.in = chunk.usage.prompt_tokens;
            tokens.out = chunk.usage.completion_tokens;
          }
        } catch {
          /* ignore fragmented frames */
        }
      }
    }
  };

  if (provider.type === 'anthropic') {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    if (prompt) messages.push({ role: 'user', content: prompt });
    const resp = await retryableFetch(`${provider.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model.id, max_tokens: maxTokens, temperature, stream: true, messages: messages.filter((m) => m.content) }),
    }, { onRetry: retry });
    // Anthropic SSE differs; map content deltas only (no reasoning_content).
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            content += evt.delta.text;
            yield { token: evt.delta.text };
          }
          if (evt.type === 'message_start' && evt.message?.usage) {
            tokens.in = evt.message.usage.input_tokens;
            tokens.out = evt.message.usage.output_tokens;
            if (evt.message.model) selectedModel = evt.message.model;
          }
        } catch {
          /* ignore */
        }
      }
    }
    yield { done: true, meta: { latencyMs: Date.now() - started, retries, tokens, selectedModel, text: content, reasoning } };
    return;
  }

  // OpenAI-compatible streaming
  const resp = await retryableFetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: model.id,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...(prompt ? [{ role: 'user', content: prompt }] : []),
      ],
    }),
  }, { onRetry: retry });
  for await (const evt of sse(resp)) yield evt;
  yield { done: true, meta: { latencyMs: Date.now() - started, retries, tokens, selectedModel, text: content, reasoning } };
}

module.exports = { complete, streamComplete, errToMessage, sleep, retryableFetch };
