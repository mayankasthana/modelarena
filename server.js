/**
 * ModelArena — single-process server.
 *
 * Serves the static frontend AND the multi-model comparison API:
 *   GET  /api/models  -> active model catalog + moderator + mock flag
 *   POST /api/run     -> SSE stream; fans out to N models in parallel, streams
 *                        each model's tokens (incl. reasoning), reports
 *                        per-model telemetry, then optionally runs the
 *                        moderator for a consensus synthesis.
 *
 * Anti-abuse: per-IP rate limits + per-run cost bounds + a server-side daily
 * token budget guard, sized under DO's gateway limits.
 */

const path = require('path');
const express = require('express');
const crypto = require('crypto');

const { providers, MODELS, MODERATOR, activeModels, getModel, IS_MOCK } = require('./lib/models');
const { streamComplete, complete, errToMessage } = require('./lib/providers');
const { createRateLimiter } = require('./lib/ratelimit');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Tunables (env-overridable; pickled to keep abuse + cost bounded)
// ---------------------------------------------------------------------------
const LIMITS = {
  MAX_MODELS_PER_RUN: Number(process.env.MAX_MODELS_PER_RUN || 8),
  MAX_PROMPT_CHARS: Number(process.env.MAX_PROMPT_CHARS || 8000),
  MAX_MAX_TOKENS: Number(process.env.MAX_MAX_TOKENS || 4096),
  // Daily token budget guard (DO workspace is ~5M/day; reserve a safe slice).
  DAILY_TOKEN_BUDGET: Number(process.env.DAILY_TOKEN_BUDGET || 400_000),
  RUNS_PER_MIN: Number(process.env.RUNS_PER_MIN || 6),
  RUNS_PER_DAY: Number(process.env.RUNS_PER_DAY || 60),
};

// In-process budget/usage counters (single instance — see DESIGN.md).
let spentTokens = 0;
const addBudget = (t) => { if (t?.out) spentTokens += t.out; };

// Per-IP limiters
const runPerMin = createRateLimiter({ windowMs: 60_000, max: LIMITS.RUNS_PER_MIN });
const runPerDay = createRateLimiter({ windowMs: 86_400_000, max: LIMITS.RUNS_PER_DAY });

// --- Health ----------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true, mock: IS_MOCK }));

// --- Catalog ---------------------------------------------------------------
app.get('/api/models', (_req, res) => {
  res.json({
    mock: IS_MOCK,
    providers: Object.fromEntries(Object.entries(providers).map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl }])),
    models: activeModels().map((m) => ({
      id: m.id,
      label: m.label,
      archetype: m.archetype,
      family: m.family,
      provider: m.provider,
      description: m.description,
      strengths: m.strengths,
      watch: m.watch,
      reasoning: !!m.reasoning,
      rate: m.rate,
    })),
    moderator: { id: MODERATOR.id },
    limits: {
      maxModelsPerRun: LIMITS.MAX_MODELS_PER_RUN,
      maxPromptChars: LIMITS.MAX_PROMPT_CHARS,
      maxTokens: LIMITS.MAX_MAX_TOKENS,
      dailyTokenBudget: LIMITS.DAILY_TOKEN_BUDGET,
      runsPerMin: LIMITS.RUNS_PER_MIN,
    },
  });
});

// --- Run (SSE) -------------------------------------------------------------
const ssEvent = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function moderatorPrompt(userPrompt, responses) {
  const parts = [`PROMPT: ${userPrompt}`, '', 'MODEL ANSWERS:'];
  for (const [id, r] of Object.entries(responses)) {
    parts.push(`\n--- ${id} (${r.selectedModel || id}) ---`);
    parts.push(r.text || '(no answer)');
  }
  return parts.join('\n');
}

app.post('/api/run', runPerDay, runPerMin, async (req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const { prompt = '', modelIds = [], options = {}, moderate = false } = req.body || {};

  // --- bounds --------------------------------------------------------------
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'A prompt is required.' });
  }
  if (prompt.length > LIMITS.MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'too_large', message: `Prompt exceeds ${LIMITS.MAX_PROMPT_CHARS} chars.` });
  }
  const active = activeModels().map((m) => m.id);
  const picks = [...new Set(modelIds)].filter((id) => active.includes(id));
  if (picks.length === 0) {
    return res.status(400).json({ error: 'bad_request', message: 'Select at least one available model.' });
  }
  if (picks.length > LIMITS.MAX_MODELS_PER_RUN) {
    return res.status(400).json({ error: 'too_many_models', message: `Max ${LIMITS.MAX_MODELS_PER_RUN} models per run.` });
  }
  const maxTokens = Math.min(Number(options.maxTokens) || 1024, LIMITS.MAX_MAX_TOKENS);
  const temperature = Math.min(Math.max(Number(options.temperature) ?? 0.7, 0), 2);

  if (spentTokens >= LIMITS.DAILY_TOKEN_BUDGET) {
    return res.status(429).json({ error: 'budget', message: 'Daily inference budget reached. Try again tomorrow.' });
  }

  // --- SSE --------------------------------------------------------------
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(ssEvent({ type: 'begin', requestId, modelIds: picks, mock: IS_MOCK }));

  const responses = {};
  const tasks = picks.map((id) =>
    (async () => {
      const model = getModel(id);
      try {
        res.write(ssEvent({ type: 'start', model: id }));
        for await (const evt of streamComplete(model, {
          prompt,
          system: '',
          temperature,
          maxTokens,
        })) {
          if (evt.token) res.write(ssEvent({ type: 'token', model: id, text: evt.token }));
          else if (evt.reasoning) res.write(ssEvent({ type: 'reasoning', model: id, text: evt.reasoning }));
          else if (evt.done) {
            addBudget(evt.meta.tokens);
            responses[id] = { text: evt.meta.text, reasoning: evt.meta.reasoning, selectedModel: evt.meta.selectedModel };
            res.write(ssEvent({ type: 'done', model: id, meta: evt.meta }));
          }
        }
      } catch (e) {
        res.write(ssEvent({ type: 'error', model: id, message: errToMessage(e) }));
      }
    })()
  );

  await Promise.allSettled(tasks);

  if (moderate && Object.keys(responses).length >= 1) {
    res.write(ssEvent({ type: 'consensus_start', count: Object.keys(responses).length }));
    try {
      const mod = getModel(MODERATOR.id);
      const { text, meta } = await complete(mod, {
        prompt: moderatorPrompt(prompt, responses),
        system: MODERATOR.system,
        temperature: 0.3,
        maxTokens: Math.min(2048, maxTokens),
      });
      addBudget(meta.tokens);
      res.write(ssEvent({ type: 'consensus', text, meta: { model: meta.selectedModel || MODERATOR.id } }));
    } catch (e) {
      res.write(ssEvent({ type: 'consensus_error', message: errToMessage(e) }));
    }
  }

  res.write(ssEvent({ type: 'end', spentTokens }));
  res.end();
});

// Busy-loop-free static fallback (SPA-ish single page)
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 8080;

if (require.main === module) {
  app.listen(PORT, () => console.log(`ModelArena listening on :${PORT} (mock=${IS_MOCK})`));
}

module.exports = app;
