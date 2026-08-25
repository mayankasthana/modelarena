# ModelArena

**A DigitalOcean take-home PoC.** Send one prompt to multiple LLMs in parallel and get a **combined view** — side-by-side live-streaming responses with per-model telemetry (latency, tokens, cost), DigitalOcean's **Auto-Router** revealing the model it chose, and an **Advisor** panel that synthesizes consensus, divergences, and a pick.

Built on [DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform) + [DigitalOcean AI inference](https://inference.do-ai.run/v1).

---

## What it does

- Runs a user prompt against a curated set of **verified-working** DO-hosted models (`deepseek-v4-pro`, `deepseek-v4-flash-0731`, `llama-4-maverick`, `gemma-4-31B-it`, `mistral-3-14B`, `kimi-k3`, and `router:general`) **in parallel** via a single SSE stream.
- Live-streams each model's tokens (and chain-of-thought for reasoning models like `kimi-k3`) into per-model cards.
- Shows real telemetry per model: time-to-first-token, latency, token count, estimated cost.
- The **Auto-Router** card reveals which underlying model DO picked for your prompt.
- The **Advisor** (toggleable) runs a moderator model to produce **Consensus → Divergences → Choosing a model → Not sure?**.
- Renders each model's answer as **Markdown live while it streams** (headings, lists, bold, fenced code) — fully escaped, so untrusted model output can't inject markup.
- **Anti-abuse:** per-IP rate limits + per-run cost bounds + a daily token budget guard.

> **Mock mode:** if no `DO_API_TOKEN` is set, the app runs on deterministic local output so it demos with zero keys (a "mock mode" badge shows).

---

## Stack

- Node.js + Express (single component serving the static frontend + API), zero runtime deps beyond `express`.
- OpenAI-compatible provider adapter (SSE streaming + `reasoning_content`), with 429 retry/backoff.
- Tests use Node's built-in runner (`node --test`), no extra frameworks.

## Local run

```bash
npm install
npm start            # mock mode (no token) -> http://localhost:8080
# or with real inference:
DO_API_TOKEN=dop_... npm start
```

Open http://localhost:8080, pick models, type a prompt, hit **Run**.

## Tests & smoke

```bash
npm test                        # unit + integration (stubbed provider, offline)
DO_API_TOKEN=dop_... npm run smoke        # contract check against real DO
SMOKE_URL=https://<app>.ondigitalocean.app npm run smoke   # against a deployed app
```

## Env vars

| Var | Purpose | Default |
|---|---|---|
| `DO_API_TOKEN` | Bearer for DO inference (set → live mode; unset → mock) | — |
| `DO_INFERENCE_BASE_URL` | Inference endpoint root | `https://inference.do-ai.run/v1` |
| `MAX_MODELS_PER_RUN` | Max models per run (anti-abuse) | `8` |
| `MAX_PROMPT_CHARS` / `MAX_MAX_TOKENS` | Input/output caps | `8000` / `4096` |
| `RUNS_PER_MIN` / `RUNS_PER_DAY` | Per-IP rate limits | `6` / `60` |
| `DAILY_TOKEN_BUDGET` | Server-side daily spend guard | `400000` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Optional extra providers | — |
| `LOG_LEVEL` | Structured-log minimum level | `info` |
| `LOG_HTTP` | Log each request (method/path/status/duration) | `true` |

## Observability
Single-line JSON logs to stdout (parse with any JSON-log tooling). Every run
is a **trace**: the request-context middleware sets `X-Request-Id` /
`X-Trace-Id` (a client-supplied `X-Trace-Id` is honored for correlation), and
each model emits `model.start`/`model.done`/`model.retry` spans; a privacy-safe
`run.complete` **audit** records per-model status/latency/tokens/cost (no
prompt text). See `DESIGN.md` §15–16 for the production evolution (OTel,
managed logging/storage, SLOs, dashboards, alerting).

## Deploy on DigitalOcean

1. **Push to GitHub** (`git push origin main`) — the spec references `mayankasthana/modelarena`.
2. **Create the app** (two options):
   - Dashboard (recommended for the secret): *Create → Apps → link the GitHub repo*, then under the component's **Environment Variables** set `DO_API_TOKEN` as a **Secret** (and confirm `http_port: 8080`, health `/healthz`).
   - CLI: `doctl apps create --spec spec.yaml` (deploys in mock mode until the secret is set), then add the secret via the App dashboard or `doctl apps update`.
   - The committed `spec.yaml` deliberately leaves `DO_API_TOKEN` value blank so no secret is in the repo.
   - Note: `deploy_on_push: true` auto-redeploys on every push to `main`.
3. **Verify:** open the returned `https://modelarena-xxxx.ondigitalocean.app`, run a prompt, then `SMOKE_URL=<url> npm run smoke`.

> The `DO_API_TOKEN` can be your account PAT or a scoped inference key; it lives **only** in the app's env (secret), never in the repo or browser.

## Repository layout

```
server.js         Express: static + /api/models + /api/run (SSE) + anti-abuse
lib/models.js     env-driven providers + curated model catalog + mock detection
lib/providers.js  OpenAI-compatible SSE client; 429 retry; reasoning capture
lib/ratelimit.js  in-memory sliding-window per-IP limiter
public/           index.html / app.js / styles.css (the comparison UI)
test/             node --test unit + integration; smoke contract check
spec.yaml         App Platform deploy spec
DESIGN.md         design rationale & tradeoffs   (assessment deliverable)
ROADMAP.md        longer-term roadmap             (assessment deliverable)
```

## Notes & risks

- Catalog is **curated to confirmed-working** model IDs. Unknown IDs → `404`, tier-locked premium (GPT-5 / Claude) → `403`; new ones can be added in `lib/models.js`.
- DO's gateway intermittently returns `429 Platform overloaded` (transient load, not your quota) — the app retries with backoff per model; the UI shows a `retrying…` pill.
- The workspace has a daily token budget (~5M/day). `DAILY_TOKEN_BUDGET` lets you keep the PoC well under it.
- In-memory rate limiter = per-instance → keep `instance_count: 1`; scale-out needs a shared store (see DESIGN.md).
