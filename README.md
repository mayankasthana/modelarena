# ModelArena

**Send one prompt to several LLMs in parallel — and see the combined view.** Built for the DigitalOcean Staff Software Engineer take-home to help customers beat **model FOMO**: stop guessing which model fits a prompt, and let evidence decide instead.

> 🟦 **Live** on DigitalOcean App Platform ⇒ [**model-arena-xfd94.ondigitalocean.app**](https://model-arena-xfd94.ondigitalocean.app) · runs on [DigitalOcean AI inference](https://inference.do-ai.run/v1)

| | |
|---|---|
| 🎨 **UX map** (interactive mockup) | [`design/ux-mockup.html`](design/ux-mockup.html) |
| 📐 **Design rationale & tradeoffs** | [`DESIGN.md`](DESIGN.md) |
| 🗺️ **Longer-term roadmap** | [`ROADMAP.md`](ROADMAP.md) |
| 🧪 **Tests** | `npm test` (21) · `npm run smoke` (real DO) |

---

## What it does

- Runs one prompt against a curated set of **verified-working** DigitalOcean-hosted models — `deepseek-v4-pro`, `deepseek-v4-flash-0731`, `llama-4-maverick`, `gemma-4-31B-it`, `mistral-3-14B`, `kimi-k3`, and `router:general` — **in parallel** over a single SSE stream.
- **Live-streams** each model's tokens (and chain-of-thought for reasoning models like `kimi-k3`) into per-model cards.
- Shows real per-model telemetry with on-hover explanations: **time-to-first-token, latency, tokens, estimated cost**.
- The **Auto-Router** card reveals which model DigitalOcean's own router chose for *your* prompt.
- The **Advisor** (toggleable, streamed, on DeepSeek Flash) synthesizes **Consensus → Divergences → Choosing a model → Not sure?** — the anti-FOMO read.
- Renders answers as **Markdown live while streaming** (headings, lists, bold, code blocks) — fully escaped, so untrusted model output can't inject markup.
- **Anti-abuse:** per-IP rate limits, per-run cost bounds, and a daily token budget guard.

> **Mock mode:** with no `DO_API_TOKEN` set, the app runs on deterministic local output (a "mock mode" badge shows) — no keys, no cost, works offline.

---

## Try it — 60-second demo

1. Open the [live app](https://model-arena-xfd94.ondigitalocean.app).
2. Add the **DO Auto-Router** and one **reasoning** model (e.g. `kimi-k3`) to the default selection.
3. Type a real prompt (or pick an example) and **Compare models**.
4. Watch every model **stream in parallel** with live latency/token counters.
5. Scroll to the **Advisor** (it streams at the top) for consensus, divergences, and a pick — and note the **Auto-Router** card revealing which model *it* chose.
6. Open **Cost at scale** to see what this workload would cost at 10k / 100k / 1M requests.

The same content lives **inside the app** under **“About this take-home POC”**, so the PoC is self-demonstrating for reviewers.

---

## Stack

- **Node + Express** — a single App Platform component serving the static UI + API (same-origin, no CORS). Zero runtime deps beyond `express`.
- **OpenAI-compatible provider adapter** over `inference.do-ai.run/v1` — one code path for every model, SSE streaming, `reasoning_content` capture, and 429 retry/backoff.
- **`node:test`** for unit + integration tests; a real-DO **smoke** contract check reused post-deploy.
- An interactive **UX mockup** covering every screen, transition, and error case.

---

## Local run

```bash
npm install
npm start                                  # mock mode (no token) -> http://localhost:8080
DO_API_TOKEN=dop_... npm start             # or with real DigitalOcean inference
```

Open http://localhost:8080, pick models, type a prompt, hit **Compare models**.

## Tests & smoke

```bash
npm test                          # 21 unit + integration tests (stubbed provider, offline, incl. XSS-safe markdown renderer)
DO_API_TOKEN=dop_... npm run smoke               # contract check against real DigitalOcean models
SMOKE_URL=https://<app>.ondigitalocean.app npm run smoke   # check a deployed app end-to-end
```

## Env vars

| Var | Purpose | Default |
|---|---|---|
| `DO_API_TOKEN` | Bearer for DO inference (set → live; unset → mock) | — |
| `DO_INFERENCE_BASE_URL` | Inference endpoint root | `https://inference.do-ai.run/v1` |
| `MAX_MODELS_PER_RUN` | Max models per run (anti-abuse) | `8` |
| `MAX_PROMPT_CHARS` / `MAX_MAX_TOKENS` | Input / output caps | `8000` / `4096` |
| `RUNS_PER_MIN` / `RUNS_PER_DAY` | Per-IP rate limits | `6` / `60` |
| `DAILY_TOKEN_BUDGET` | Server-side daily spend guard | `400000` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Optional extra providers | — |
| `LOG_LEVEL` | Structured-log minimum level | `info` |
| `LOG_HTTP` | Log each request (method/path/status/duration) | `true` |

## Observability

Single-line JSON logs to stdout. Every run is a **trace**: a request-context middleware sets `X-Request-Id` / `X-Trace-Id` (a client-supplied `X-Trace-Id` is honored), and each model emits `model.start` / `model.done` / `model.retry` spans. A privacy-safe `run.complete` **audit** records per-model status/latency/tokens/cost — **no prompt text**. See `DESIGN.md` §15–16 for the production evolution (OTel, managed logging/storage, SLOs, dashboards, alerting).

---

## Deploy on DigitalOcean

This repo deploys to App Platform via `deploy_on_push` (repo `mayankasthana/modelarena`, branch `main`, **Dockerfile** build, port 8080):

1. **Push to `main`** — App Platform auto-rebuilds and redeploys (~5 min).
2. **Secret:** set `DO_API_TOKEN` (Secret) + `DO_INFERENCE_BASE_URL` in the app's environment. `spec.yaml` deliberately leaves the token blank so no secret is committed.
3. **Verify:** `SMOKE_URL=<url> npm run smoke` once the build is **Active**.

> The `DO_API_TOKEN` (a DO PAT or a scoped inference key) lives **only** in the app's env — never in the repo or the browser.

## Repository layout

```
server.js         Express: static + /api/models + /api/run (SSE) + anti-abuse + observability
lib/models.js     env-driven providers + curated model catalog + mock detection
lib/providers.js  OpenAI-compatible SSE client; 429 retry/backoff; reasoning capture
lib/ratelimit.js  in-memory sliding-window per-IP limiter
lib/logger.js     structured JSON logging with per-request context
public/           index.html · app.js · markdown.js · styles.css (the comparison UI)
test/             node:test unit + integration + markdown renderer tests; smoke contract check
design/           interactive UX mockup (all screens/transitions/error cases)
spec.yaml         App Platform deploy spec
DESIGN.md         design rationale & tradeoffs   (assessment deliverable)
ROADMAP.md        longer-term roadmap            (assessment deliverable)
```

---

## Honest scoping notes

- **Cost figures are estimates.** Per-model rates are illustrative (flagged as approximate) pending confirmed DO plan pricing; the card cost + **Cost at scale** calculator reflect those rates.
- **In-memory rate/budget limiter is per-instance.** Correct at `instance_count: 1`; scale-out needs a shared store (Redis) — the fix is documented in `DESIGN.md`.
- **No multi-tenant auth.** The PoC is public by design for the take-home; per-caller auth + quotas are on the roadmap.
- **Catalog is curated to confirmed-working IDs.** Unknown IDs → `404`, tier-locked premium (GPT-5 / Claude) → `403`.

## Acknowledgments

A take-home build; all design decisions, tradeoffs, and the roadmap are documented in [`DESIGN.md`](DESIGN.md) and [`ROADMAP.md`](ROADMAP.md).
