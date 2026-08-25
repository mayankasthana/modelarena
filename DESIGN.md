# ModelArena — Design rationale & tradeoffs

This document explains the end-to-end design, why each choice was made, and
what it costs us. It answers the "design your best attempt" prompt explicitly.

---

## 1. Problem framing

Customers suffer **model FOMO**: "did I pick the right model for this prompt?"
The pain is anxiety + trust — vendor benchmarks can't be validated on *their*
input, and manually comparing models is slow. The chosen wedge: **turn
intuition into evidence** by running the user's own prompt across a diverse
model set *in parallel* and presenting the outputs with real telemetry plus a
neutral synthesis.

**Why this particular wedge:** it's prompt-specific (unlike static benchmark
scores), it de-risks moving to a cheaper/faster model (the #1 real customer
use case), and it creates a reason for the user to stay inside DigitalOcean's
model catalog + router, which is exactly the moat we want to reinforce.

## 2. Architecture — one component, two jobs

A single Express process serves the static frontend **and** the `/api` routes.
- **Why single component:** same-origin (no CORS), one thing to deploy and
  reason about, matches the team's existing App Platform pattern.
- **Tradeoff:** no independent scaling of UI vs. API; a long inference request
  consumes a connection on the same instance. Fine for a PoC; the roadmap
  splits them (static site + service) when traffic or p95 latency justifies it.

## 3. Provider abstraction: OpenAI-compatible as the lingua franca

Every model is reached through one adapter (`chat/completions`, SSE optional).
It turns out DigitalOcean's gateway *is* OpenAI-compatible
(`inference.do-ai.run/v1`), so this also means "the app talks to DO the way
the SDKs already do."
- **Why:** one code path for all models/providers; a new model is a catalog
  entry, not a new integration; works with BYO OpenAI/Anthropic endpoints too.
- **Tradeoff:** we can't use provider-specific features (function-calling
  differences, provider-native streaming options) without per-provider code.
  Acceptable: this PoC's feature is *content* + *reasoning* + telemetry, all
  on the common interface.

## 4. Parallel fan-out + SSE streaming (not polling, not sequential)

- **Parallel:** all selected model calls start before any is awaited — wall-clock
  is bound by the slowest model, not the sum.
- **SSE:** results stream straight to the cards as tokens arrive. `res.write`
  per SSE frame means interleaved streams are safe (each frame is atomic).
- **Why SSE over polling:** real-time fill with no extra request loop, no
  client-side state to reconcile, natural fit for "watch it happen."
- **Tradeoff:** one long-lived connection per run; needs buffering (`X-Accel-
  Buffering: no`) and disconnect handling. Polling would be more robust on
  very flaky networks but adds RPC complexity and latency — not worth it here.

**Live markdown rendering.** Card bodies are re-rendered as markdown on a short
debounce (render the *whole* accumulated buffer each tick — never incremental
HTML). This is deliberately XSS-safe: every token is escaped and we only emit
our own tags (headings, lists, bold/code, fenced `<pre>`), so untrusted model
output can't inject markup. Accepted tradeoff: while a code fence or bold
delimiter is still open mid-stream the block renders "whole" until it closes —
a momentary flicker that's inherent and acceptable.

## 5. Reasoning models & the `reasoning_content` channel

`kimi-k3` (and DeepSeek-backed models) emit chain-of-thought via a
`reasoning_content` delta **before** the final `content`. The adapter captures
both, forwards reasoning as its own SSE frame, and the UI renders thinking in a
collapsible block; reasoning tokens count toward usage/cost.
- **Tradeoff:** we forward the raw chain-of-thought to the client. For an
  internal tool that's a feature (transparency); shipping this publicly would
  need a policy to truncate/hide COT — a roadmap item.

## 6. The Auto-Router reveal

`router:general` lets DO pick the model, and the gateway reports the *actual*
model in the response `model` field (which we captured and verified:
`router:general → deepseek-v4-pro`). The UI surfaces this as "Auto-Router
chose: X".
- **Why it matters:** it's the *honest* version of the FOMO fix — instead of
  the product telling you which model to use, the customer can watch the
  platform's own router make the call, and compare it to their manual choice.

## 7. Moderator/Advisor: a model, not rules

The Advisor is a **moderator model** (a capable open model on the same
catalog) that reads all responses and writes the four sections. A
rule-based alternative (diff/length heuristics) was rejected: it can't read
for *semantic* consensus or give a credible recommendation.
- **Tradeoff:** an extra inference call and its cost/latency. Mitigations:
  it's toggleable, uses a lower temperature, and is bounded
  (`maxTokens`). This is the right spend — it's the part that actually kills
  the FOMO.

## 8. Mock mode

Without `DO_API_TOKEN`, the app runs on deterministic local output so the UI
is demonstrable and reliably testable offline. Detection is explicit and
labelled ("mock mode" badge) so nobody mistakes synthetic output for real.
- **Tradeoff:** the mock shares the real code path (SSE, cards, telemetry), so
  it's real for UX/tests but a divergence from live behavior if left on in
  production. We gate on "no token configured," so a deployed app with the
  secret set is live by construction.

## 9. Resilience: 429 retry + isolation

We verified DO's gateway intermittently sheds load with `429 Platform
overloaded` **even when account rate limits are clean** (headers showed
headroom). Every model call retries with exponential backoff + jitter
(respecting `Retry-After`); each model fails independently without aborting
the run.
- **Tradeoff:** retries add worst-case latency under overload. Bounded
  attempts (4) + per-model isolation keep it acceptable; the UI signals
  "retrying…" so a slow model is explicable.

## 10. Anti-abuse & budget guards

Public endpoint, no login → the cheapest way to be exploited is a scripted
`/api/run` storm draining the DO token's daily budget. Defense in depth:
- per-IP sliding-window limits (`/api/run` + `/api/models`), sized **under**
  DO's gateway limits so clients can't exhaust DO's quota through us;
- per-run cost bounds (max models, prompt chars, max tokens) so one request
  can't spike spend;
- a server-side cumulative daily token guard that stops spending with a clear
  message.
- **Tradeoff:** in-memory storage is per-instance — meaningful only at
  `instance_count: 1`. Scale-out needs a shared rate/usage store (Redis);
  flagged in the roadmap.

## 11. Security

The DO token is read **only** from a `SECRET` env var server-side; it never
reaches the browser or the repo (`spec.yaml` leaves its value blank). Public
users don't authenticate (correct for a take-home; API keys for callers are a
roadmap item).
- **Token choice:** our account PAT works as the bearer, but it's a broad,
  personal token. The production posture is a **scoped inference key** +
  short-lived credentials. We keep it configurable so either works.

## 12. Testing strategy (thin by design)

We test the two things most likely to break and most expensive to debug
blind: (a) provider HTTP parsing + retry, and (b) SSE fan-out + partial-failure
isolation — plus the catalog logic, rate limiter, and a **real-DO smoke**
contract check (reused post-deploy). `node --test` with no extra deps.
- **Deliberately thin:** no visual/E2E-browser suite, no snapshot tests, no DB
  to validate. For a PoC this is the right budget; the smoke script is the
  safety net that catches catalog drift and new 403/404s.

## 13. Deploy: App Platform, single service, GitHub push

Matches the team's existing pattern (`deploy_on_push`, `blr`, `http_port 8080`,
health `/healthz`). Region `blr` for the app; inference served from `tor1`/`ric1`
— negligible cross-region latency for a PoC. Auto TLS + `ondigitalocean.app` domain.

## 14. What I'd change in production

- Split UI/API components; shared Redis for rate/usage limits.
- Scoped + short-lived inference credentials; per-caller API keys.
- Persist run history, dedupe identical prompts (cache), and add spend/
  quality dashboards.
- Forward the advisor into a streaming router recommendation and A/B-validate
  it against human picks (see ROADMAP.md).

## 15. Observability — logging, audit, tracing (shipped, not just documented)

**Logging.** `lib/logger.js` emits single-line JSON to stdout; every record
carries `ts/level/msg` plus a per-request context (`requestId`, `traceId`,
`ip`) attached via `log.with()`. A request-context middleware assigns
`X-Request-Id` / `X-Trace-Id` and **honors a client-supplied trace id**, so a
single run is correlated from the browser all the way through to the gateway.
Access lines log method/path/status/duration. `LOG_LEVEL` gates verbosity.

**Tracing.** A run is a trace; each model is a span. The fan-out emits
`model.start` / `model.done` (model, latency, tokensOut, retries, and
`selectedModel` — the router's reveal), and the advisor its own spans. Every
transient 429/5xx backoff logs `model.retry {attempt, waitMs}` — so you can
distinguish "this model is slow" from "the gateway is shedding load" and even
measure overload per model. Spans are structured lines today; the shape is
OpenTelemetry-ready (the same ids become W3C `traceparent` in production).

**Audit.** `run.complete` records each run: requested models, per-model
status/latency/tokens/retries, totals, consensus model, prompt length. It is
**privacy-safe by construction — no prompt or response text, ever** (length +
nothing else), because the product is public and prompts are user data. Kept
in a bounded in-memory buffer + stdout in the PoC; in production this streams
to an append-only store / DO object storage / SIEM with retention and
access control. It's the basis for spend attribution and abuse detection.

**Tradeoffs.** In-memory audit is volatile and per-instance (fine at
`instance_count: 1`, and we call it out); stdout JSON is cheap but not
queryable at scale → managed logging + storage in prod. We deliberately do
**not** expose a public `/api/usage` (it would leak IPs and usage across
tenants); an admin-gated equivalent is a production route.

## 16. Staff-level operational readiness (the interview-relevant view)

- **SLO / error budget.** e.g. availability 99.5% + a TTFT p95 target on
  `/api/run`; the budget is burned by gateway 429s and model failures — exactly
  the signals our spans make measurable.
- **Dashboards & alerting.** By (endpoint, model): request volume, error rate,
  429 rate, latency histograms (TTFT / end-to-end), cost per model/day, budget
  burn, rate-limit hits. Alerts on error-rate spikes, retry storms, budget
  exhaustion.
- **Cost observability.** Per-model & per-run cost (we already estimate it) →
  spend dashboards + the budget guard we ship.
- **Privacy & retention.** No prompt/response text in logs; retention +
  who-can-query policy on audit; redaction on the public path.
- **Feature flags & rollout.** Model catalog toggles; canary a new model to a
  % of runs rather than all-or-nothing (ties to ROADMAP A/B).
- **Rollback & reproducibility.** `deploy_on_push` + immutable images; pinned
  model IDs; health gate before routing traffic.
- **Error taxonomy.** Client rate-limit (429 per-IP) vs DO overload (429
  platform) vs tier-lock (403) vs unknown model (404) — kept distinct in code
  and logs so each maps to its own SLO/alerting bucket.
