/**
 * Model catalog + provider configuration.
 *
 * Every model is reached through an OpenAI-compatible `/v1/chat/completions`
 * endpoint (with SSE streaming), which is exactly what DigitalOcean's hosted
 * inference exposes at https://inference.do-ai.run/v1. That lets a single code
 * path compare a diverse set of models (frontier, fast/cheap, open-weight,
 * reasoning, and DO's auto-router).
 *
 * Configuration comes from environment variables (see .env.example):
 *   - DO_API_TOKEN            bearer token for inference (user's DO PAT or a
 *                             scoped key). Mock mode kicks in when absent.
 *   - DO_INFERENCE_BASE_URL   override endpoint root (default below).
 *   - OPENAI_API_KEY / ANTHROPIC_API_KEY   optional extra providers.
 */

const env = process.env;

const INFERENCE_BASE_URL = env.DO_INFERENCE_BASE_URL || 'https://inference.do-ai.run/v1';

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------
const providers = {
  digitalocean: {
    type: 'openai',
    label: 'DigitalOcean Inference',
    baseUrl: INFERENCE_BASE_URL,
    apiKey: env.DO_API_TOKEN || env.DO_INFERENCE_API_KEY || '',
  },
  openai: env.OPENAI_API_KEY
    ? { type: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: env.OPENAI_API_KEY }
    : undefined,
  anthropic: env.ANTHROPIC_API_KEY
    ? { type: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: env.ANTHROPIC_API_KEY }
    : undefined,
};
Object.keys(providers).forEach((k) => {
  if (providers[k] === undefined) delete providers[k];
});

// ---------------------------------------------------------------------------
// Model catalog — curated to IDs VERIFIED against the live DO endpoint.
// (unknown IDs -> 404, tier-locked premium -> 403; keep to confirmed set)
// ---------------------------------------------------------------------------
// `archetype` drives the frontend tag + which model a suggested prompt targets.
// `rate` = approx $/1k tokens (input, output), used only for the cost widget,
// configurable to your DO plan's published pricing.
// `reasoning` = streams chain-of-thought (`reasoning_content`) before the answer.
const MODELS = [
  {
    id: 'deepseek-v4-pro',
    provider: 'digitalocean',
    archetype: 'frontier',
    label: 'DeepSeek V4 Pro',
    family: 'DeepSeek',
    description: 'Frontier reasoning, highest quality on DO.',
    strengths: 'hard reasoning, long-form, math, coding',
    watch: 'slower + pricier than the flash tier',
    reasoning: true,
    rate: { in: 0.0035, out: 0.0069 },
  },
  {
    id: 'deepseek-v4-flash-0731',
    provider: 'digitalocean',
    archetype: 'fast',
    label: 'DeepSeek V4 Flash',
    family: 'DeepSeek',
    description: 'Fast + cheap, 1M context — the value pick.',
    strengths: 'general tasks, long context, low latency',
    watch: 'less depth than Pro on hard problems',
    reasoning: true,
    rate: { in: 0.0015, out: 0.003 },
  },
  {
    id: 'llama-4-maverick',
    provider: 'digitalocean',
    archetype: 'open',
    label: 'Llama 4 Maverick',
    family: 'Meta',
    description: 'Open-weight generalist, Meta.',
    strengths: 'balanced, instruction following, writing',
    watch: 'verbose; watch token spend',
    rate: { in: 0.002, out: 0.004 },
  },
  {
    id: 'gemma-4-31B-it',
    provider: 'digitalocean',
    archetype: 'open',
    label: 'Gemma 4 31B',
    family: 'Google',
    description: 'Compact Google open model.',
    strengths: 'efficient, tidy, low cost',
    watch: 'less capable on multi-step logic',
    rate: { in: 0.001, out: 0.002 },
  },
  {
    id: 'mistral-3-14B',
    provider: 'digitalocean',
    archetype: 'open',
    label: 'Mistral 3 14B',
    family: 'Mistral',
    description: 'Efficient European open model.',
    strengths: 'multilingual, concise, low latency',
    watch: 'smaller context of reasoning depth',
    rate: { in: 0.001, out: 0.002 },
  },
  {
    id: 'kimi-k3',
    provider: 'digitalocean',
    archetype: 'reasoning',
    label: 'Kimi K3',
    family: 'Moonshot',
    description: 'DO-hosted reasoning model.',
    strengths: 'chain-of-thought, complex tasks',
    watch: 'emits long thinking before the answer',
    reasoning: true,
    rate: { in: 0.002, out: 0.004 },
  },
  {
    id: 'router:general',
    provider: 'digitalocean',
    archetype: 'auto',
    label: 'DO Auto-Router',
    family: 'DigitalOcean',
    description: 'Lets DO pick the best model for this prompt (reveals its choice).',
    strengths: 'set-and-forget routing, no guesswork',
    watch: 'you delegate the choice to DO',
    rate: { in: 0, out: 0 },
  },
];

// Moderator: a reliable, capable open model that synthesizes the combined view.
const MODERATOR = {
  id: 'deepseek-v4-pro',
  system:
    'You are a neutral model-selection advisor at a company called ModelArena. ' +
    'The user asked several different LLMs the same question and showed you all of their answers. ' +
    'Your job is to reduce "model FOMO" and help the user pick the right model for THIS kind of prompt. ' +
    'Respond in Markdown with exactly four sections:\n' +
    '**Consensus** — what the models largely agree on.\n' +
    '**Divergences** — where and why they differ.\n' +
    '**Choosing a model** — concrete tradeoffs (quality, latency, cost, style) and which model you would pick for this prompt and why.\n' +
    '**Not sure?** — one sentence on when rerunning with a different prompt framing would help.',
};

// ---------------------------------------------------------------------------
// Mock mode — deterministic local text so the app demos with zero keys.
// ---------------------------------------------------------------------------
const IS_MOCK = !providers.digitalocean.apiKey;
if (IS_MOCK) {
  providers.digitalocean = {
    type: 'openai',
    label: 'DigitalOcean Inference (mock)',
    baseUrl: 'mock://',
    apiKey: 'mock',
    mock: true,
  };
  MODELS.forEach((m) => (m.mock = m.provider === 'digitalocean'));
}

function activeModels() {
  return MODELS.filter((m) => providers[m.provider]);
}

function getModel(id) {
  return MODELS.find((m) => m.id === id);
}

module.exports = { providers, MODELS, MODERATOR, activeModels, getModel, IS_MOCK, INFERENCE_BASE_URL };
