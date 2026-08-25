# ModelArena — Plan

## Product specification

### Problem / why
**Model FOMO** = anxiety + trust: "did I pick the right model for this prompt?" Cost of a wrong choice is a silently-medicore result. Users mistrust marketing, can't afford to manually run N models, and fear lock-in. The product converts intuition into evidence: run the **user's own prompt** across a diverse model set **in parallel** and show side-by-side responses + real telemetry + a neutral advisor synthesis (consensus / divergences / recommendation). You stop guessing, you start knowing. Usefulness: prompt-specific (not abstract benchmarks), fast, and de-risks adopting a cheaper/faster model by proving it's good enough on *your* inputs.

### User flow
1. Land → prompt box + pre-selected diverse model chips + temp/max-tokens + "advisor" toggle.
2. Type or pick an example prompt; choose models to race (or defaults).
3. **Run** → all models stream in parallel; each card fills live with text + time-to-first-token + running token/cost counters; header shows "3/6 complete".
4. DO Auto-Router card streams, then **reveals which underlying model DO's router chose**.
5. All done → **advisor panel**: Consensus → Divergences → Choosing a model (cost/latency/quality tradeoffs) → recommendation + "Not sure?" tip.
6. Rerun / adjust / compare again.

### Features
Parallel multi-model invocation · live SSE streaming into per-model cards · real per-model telemetry (TTFT, total latency, tokens, est. cost) · model metadata (owner, archetype, context window, benchmark hint) · DO Auto-Router card that reveals its choice · advisor/consensus synthesis (toggle) · mock mode (no keys) · responsive + accessible UI.

### Functional requirements
FR1 choose model subset · FR2 submit prompt+params · FR3 run selected models **concurrently**, stream · FR4 per-model output + telemetry · FR5 synthesize consensus + recommendation · FR6 isolate per-model failures · FR7 reveal router-chosen model · FR8 mock fallback when unconfigured · FR9 expose model catalog via API.

### Non-functional requirements
- **Perf:** parallel fan-out; streaming keeps perceived TTFT low; UI never blocks.
- **Reliability:** per-model timeouts; partial-failure isolation; graceful degradation on 403/404.
- **Security:** DO token **server-side only** (App Platform env var), never shipped to browser; input-size caps; no prompt persistence.
- **Cost/scale:** max-token caps, rate limiting, bounded concurrency.
- **Configurability:** env-driven providers/models (catalog changes w/o code).
- **Observability/usability:** request ids, per-model error surfacing, responsive clean UI.

### Business why
Reduce churn from doubt · **platform stickiness** (compare inside DO, stay in DO) · **upsell** frontier models used elsewhere · leans on DO moat: open-model catalog + routers = neutral place to evaluate (vs single-vendor lock-in).

---

## Design / UX phasing (collaborate-now, polish-after)
- **Now (before build):** settle the design architecture — IA/layout, streaming/telemetry UX patterns, theme/token baseline, responsive + a11y baseline. Direction (approved):
  - **Layout:** single view, three stacked zones — header (with mock/live badge) → control deck (prompt + example chips; temp/max-tokens sliders; model chips with archetype tags; Run; Advisor toggle) → results.
  - **Results:** responsive grid of model cards (header: label/family/context/archetype · live-streaming body with typing caret · footer telemetry: TTFT, latency, tokens, est. cost, status pill stream/done/retrying/error). Distinct **Auto-Router card** revealing its chosen model. **Advisor panel** below: Consensus → Divergences → Choosing a model → Not sure?. Run status bar ("3/6 complete", elapsed, cumulative cost).
  - **Theme:** clean + neutral, light/dark respecting `prefers-color-scheme` + toggle, minimal accent (CTA + router card), system font stack.
  - **UX patterns:** real-time streaming fill; `retrying…` pill on transient 429 (never fails the run); keyboard navigable; `aria-live` on streaming text; respects `prefers-reduced-motion`; responsive 1-col on mobile; semantic landmarks.
- **After it runs:** visual polish + iterate in the user's **Open Design** app (chosen: "collaborate on UX now, polish after").


A deployable **PoC** on DigitalOcean App Platform that lets a user send one prompt to **multiple LLMs in parallel** and see a **combined view**: side-by-side streaming responses with real per-model telemetry (latency, tokens, cost), plus a **consensus/moderator panel** that reduces "model FOMO" by recommending which model fits the prompt.

## Confirmed decisions
- **Backend:** Node.js + Express (single component: serves static frontend + API). Native SSE streaming.
- **Inference wiring:** OpenAI-compatible adapters hitting the real DO endpoint, auth via bearer token (see Auth section). **Mock fallback** when no key is set so it demos without credentials.
- **Combined view:** parallel streaming cards + moderator consensus synthesis.
- **429-resilience:** the DO gateway intermittently returns 429 "Platform overloaded" (verified transient, account rate-limits NOT exceeded). Backend must **retry with exponential backoff + jitter per model**, and surface a soft "overloaded — retrying…" state rather than failing the run.
- **Security posture:** the DO token lives **server-side only** (App Platform secret env), never in the repo/browser. Prefer a **scoped inference key** over the broad PAT if a quick test confirms it authenticates (see Auth + decision to resolve).

## VERIFIED against your live DO workspace (doctl + real calls)
- **Endpoint:** `https://inference.do-ai.run/v1` (OpenAI-compatible chat completions + SSE streaming, both confirmed).
- **Auth:** `Authorization: Bearer <DO_API_TOKEN>` — your personal access token works directly as the inference bearer (confirmed). No Gradient openai-key needed.
- **Working models (probed):** `deepseek-v4-pro`, `deepseek-v4-flash-0731`, `deepseek-4-flash`, `llama-4-maverick`, `gemma-4-31B-it`, `mistral-3-14B`, and **`router:general`** — DO's auto-router that picks the best model for the prompt and **reports which one it chose** in the response (perfect anti-FOMO artifact). Unknown IDs return 404; tier-locked premium (OpenAI GPT-5, Anthropic Claude) return 403, so the catalog is curated to confirmed-working models.
- **Usage:** response `usage.prompt_tokens` / `usage.completion_tokens` present (drives the cost widget).
- **Model catalog (final, all confirmed):**

| id | label | archetype |
|---|---|---|
| `deepseek-v4-pro` | DeepSeek V4 Pro | frontier reasoning, high quality |
| `deepseek-v4-flash-0731` | DeepSeek V4 Flash | fast + cheap, 1M ctx |
| `llama-4-maverick` | Llama 4 Maverick | open-weight generalist (Meta) |
| `gemma-4-31B-it` | Gemma 4 31B | compact Google open model |
| `mistral-3-14B` | Mistral 3 14B | efficient Euro open model |
| `kimi-k3` | Kimi K3 | DO-hosted reasoning model (streams `reasoning_content`) |
| `router:general` | DO Auto-Router | auto-picks best model + reveals choice |

## Architecture

```
digitalocean-multimodel/
  package.json          express only; npm start
  server.js             Express app: static hosting + /api/models + /api/run (SSE)
  .env.example          DO_INFERENCE_BASE_URL, DO_API_TOKEN, optional OPENAI/ANTHROPIC keys
  .env                  (gitignored) local keys
  spec.yaml             App Platform deploy spec
  Dockerfile            optional container path
  README.md             setup + deploy walkthrough
  DESIGN.md             design rationale + tradeoffs (deliverable)
  ROADMAP.md            longer-term roadmap (deliverable)
  lib/
    models.js           provider defs (env-driven), model catalog (per-model strengths/cost), moderator config, mock mode flag
    providers.js        OpenAI-compatible + Anthropic adapters; streamComplete() SSE generator; non-stream complete()
  public/
    index.html          layout: header, prompt, model toggles, telemetry, results grid, moderator panel
    app.js              client: fetch + SSE reader, per-card streaming, consensus render, cost calc
    styles.css          clean DO-ish theme, dark/light, responsive grid
```

## Backend behavior
- `GET /api/models` → active models (with strengths / cost / provider label) + moderator config + mock flag.
- `POST /api/run` body `{ prompt, system?, modelIds[], options:{temperature,maxTokens}, moderate:bool }`
  - Fans out to each selected model **in parallel** (no await between starts).
  - Streams each model's tokens over **one SSE channel**: `data: {"type":"token","model":id,"text":...}`, then `data: {"type":"done","model":id,"meta":{latencyMs,tokens,cost}}`.
  - After all models finish, if `moderate` is on, runs the **moderator** model with a fixed system prompt over collected responses → `{"type":"consensus","text":...}`, then `{"type":"end"}`.
  - Errors per-model are reported inline, not fatal to other models.
- **Mock mode:** deterministic per-model text generator + simulated latency so the UI is fully demonstrable offline (banner shows "mock mode").

## Frontend behavior
- Prompt textarea + example prompt chips; model toggle chips grouped by provider; sliders for temp/max-tokens; "moderate" toggle.
- Run → each model card streams live; cards show live latency/tokens and a running **cost estimate** (from per-model `rate`).
- **Consensus panel** renders the moderator's Markdown (Consensus / Divergences / Choosing a model / Not sure?).
- Responsive grid; smart-order so models that finish slot in; error states inline.

## Verification (local, before deploy)
1. `npm install` in the project dir.
2. `npm start` → open localhost:8080 → run a prompt in **mock mode** (no keys) → confirm streaming cards + consensus.
3. Optional: export a fake `DO_INFERENCE_BASE_URL`/`DO_API_TOKEN` pointed at e.g. OpenAI to confirm the real HTTP path end-to-end.

## Deploy on DigitalOcean (grounded in the real workspace)
Mirrors the team's existing pattern (verified from `url-shortener-app`): **one App Platform service** deployed from GitHub with `deploy_on_push` into the `blr` region.
1. **Single component:** Node buildpack detects `package.json` → `npm install` → `npm start`. Server binds `process.env.PORT || 8080`; spec sets `http_port: 8080`.
2. **Two jobs in one process:** serves the static frontend from `public/` AND the API. Same origin → no CORS, no separate static-site component.
3. **Source:** GitHub repo `mayankasthana/modelarena` (**private**, created) via `gh`; `deploy_on_push: true`. (`docker image in DO Container Registry` is the fallback if no GitHub repo is wanted.)
4. **Env (secrets):** `DO_API_TOKEN` set as a **secret** (`type: SECRET`, `scope: RUN_TIME`) in the spec / dashboard. Never in the repo or client.
5. **Result:** App Platform returns a public HTTPS URL `https://<app>-<hash>.ondigitalocean.app`, TLS auto, health check `/`.
6. **Region note:** app in `blr`; inference served from `tor1`/`ric1` — reached over the internet, negligible latency for a PoC.

### Authentication model (two layers)
- **Users → app (public):** no user login; anyone with the URL can run the PoC. Correct for a take-home; multi-tenant auth is a roadmap item.
- **App → DO inference:** backend calls `https://inference.do-ai.run/v1/chat/completions` with `Authorization: Bearer <token>`. The browser never sees the token — it only calls our backend (`/api/run`), which injects the bearer server-side and fans out.
- **Which token (DECISION PENDING):**
  - *PAT* (the `dop_…`, verified working): simplest, but broad personal-token scope → larger blast radius if the app env leaks.
  - *Scoped Gradient "OpenAI API key":* narrower audience, but must be tested to confirm it authenticates against `inference.do-ai.run` like the PAT does.
  - Plan: **test the scoped-key path**; prefer it if it works, keep the PAT as fallback; document the reasoning + "switch to a rollout/inference-scoped key + short-lived tokens" as the production answer.

## Anti-abuse / rate limiting (public PoC → protect DO budget)
The PoC is public (no login), so it must defend the shared DO token + token budget (5M/day) and the gateway rate limits (120 req/min). Hand-rolled **in-memory, sliding-window, per-client-IP limiter** (zero deps, ~30 lines, unit-testable) on the expensive endpoints:
- **`/api/run` (inference):** e.g. N runs / minute per IP + a small per-IP daily cap → returns client `429` with `Retry-After` + JSON body (distinct from DO's overloaded 429).
- **`/api/models`:** looser limit (cheap), still bounded.
- **Per-run cost bounds (protects budget even within limits):** max models per run, max prompt chars, max `maxTokens`, capped concurrency — so one request can't spike the DO bill.
- **Respect DO's ceiling:** client windows set comfortably under 120 req/min; total daily token budget guarded server-side (hard stop with a clear "daily budget reached" message before spending).
- **Honest caveat:** in-memory = per-instance. Keep `instance_count: 1` for the PoC so the limiter is meaningful; scale-out needs a shared store (Redis) — documented as a design/production note.

## Testing strategy
**Philosophy:** a PoC doesn't need a big suite, but it needs real seams around the two risky areas — (a) provider HTTP parsing + retry and (b) SSE fan-out/partial-failure — plus a thin contract check against the real DO endpoint. Use **Node's built-in `node --test`** (zero runtime deps, keeps the "express only" goal). Providers get an **injectable `fetch`** so tests stub the network with fixtures (no real calls, no cost).

Layers:
1. **Unit — `models.js`:** catalog filtering by provider availability, mock-flag detection, `getModel`.
2. **Unit — `providers.js`** (with injected fake fetch):
   - token parsing: `content` **and `reasoning_content`** (kimi/DeepSeek-style chain-of-thought), usage → tokens, `[DONE]`.
   - streaming: delta chunks → correct events.
   - error mapping: unknown model (404) vs tier-locked (403) vs overloaded (429).
   - **429 retry:** backoff + jitter, max attempts, success-then-continue, permanent-failure surface.
3. **Integration — server routes** (start express on an ephemeral port, stubbed provider via injected fetch): `/api/models`; `/api/run` SSE event sequence (`token`/`done`/`consensus`/`end`); **partial-failure isolation** (one model 500s, the rest still stream + complete); per-model timeout.
4. **Frontend — pure helpers** (`node --test`): SSE byte→event parser, cost/token formatter, consensus-markdown → section renderer. (Vanilla JS — test the logic, keep DOM interaction thin.)
5. **Contract/smoke vs real DO — `npm run smoke`:** for each curated model assert HTTP 200 + non-empty content (and streaming where relevant). Catches catalog-ID drift, new 403s/404s, latency regressions. Same script reused **post-deploy** against the live URL to confirm secrets + HTTPS + the real gateway.
6. **Manual/UX acceptance:** mock mode full flow (no keys) · real mode streaming cards + consensus render · a card visibly "retrying…" then completing under 429.

Risk mapping: 429 → layers 2–4 · reasoning chain-of-thought → layer 2 fixture · tier-lock/unknown-ID → layer 2 · mock mode → layer 3 · deployed secrets → layer 5.

**Deliberately thin:** no heavy visual/E2E-browser suite, no DB, no snapshot testing — appropriate for the PoC size; this is called out in DESIGN.md.

## Docs deliverables (part of the assessment)
- **DESIGN.md** — why OpenAI-compatible abstraction (one code path, DO + BYO), parallel fan-out vs sequential, SSE streaming vs polling, mock fallback, moderator-as-a-model vs rule-based synthesis, tradeoffs.
- **ROADMAP.md** — the "what's next after traction" question: evals/judge-based model picker, per-use-case routing (router model), cost/latency guardrails, OpenAI-compat gateway product, caching, benchmark-driven ranking, feedback loops, A/B model rollouts, enterprise policies.

## Notes / risks / decisions still open
- **GitHub repo (need user input):** code deploys from a GitHub repo the user owns. Same account as existing apps (`rsethi3950/DigitalOcean`)? A new repo? Public or private?
- **Scoped-vs-PAT token:** pending the quick test of a Gradient OpenAI API key as the inference bearer.
- **429 resilience:** verified intermittent gateway overload; retry/backoff is a hard requirement (account rate-limits clean, so it's pure load).
- **Daily token budget:** workspace limit ~5M tokens/day, ~500k observed remaining — enough for demo; keep prompts/tokens modest and note it in README.
- Catalog is curated to **confirmed-working** model IDs (unknown → 404, tier-locked premium → 403); documented in README.
- `kimi-k3` is a reasoning model → streaming parser must capture `reasoning_content` (chain-of-thought) in addition to `content`.
