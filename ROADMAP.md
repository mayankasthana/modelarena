# ModelArena — longer-term roadmap

*Prompt: "assume what you built got traction — what else solves this problem,
and where does the area go?"*

This sketches the product evolution from the current PoC to a platform. Each
row says **what**, **why** (which part of model FOMO / confidence it attacks),
and **dependencies**.

---

## Phase 0 — PoC (shipped)
Parallel multi-model comparison + telemetry + Auto-Router reveal + Advisor.

## Phase 1 — Productize the comparison (make the answer trustworthy & shareable)

| Initiative | Attacks | Notes / deps |
|---|---|---|
| **Evals / judge-based picker** — a judge model scores each response (correctness, instruction-following, style) and ranks models on *this* prompt | replaces vibes with a score; the core of "which model is right" | needs a small eval harness + a judge subsystem; reuse the provider adapter |
| **Run history + save/share** | trust through reproducibility | add persistence (DB/object storage) |
| **Per-caller auth + quotas** | lets more people use it without abusing it | API keys, tenant budgets on top of the existing limiter |
| **Prompt-class telemetry** — grouped by task (code / writing / RAG / reasoning) | shows *when* to trust a model | classify prompts, aggregate outcomes |

## Phase 2 — Proactive guidance (stop making the user ask)

| Initiative | Attacks | Notes / deps |
|---|---|---|
| **Router-powered recommendation** — surface DO's `router:*` choice as a first-class "recommended" lane, not just a card | FOMO is *deciding*; a credible default removes the decision | already live for `router:general`; generalize |
| **Per-use-case routing policy** — "for this prompt class, route here" guardrails (cost/latency ceilings) | automation over anxiety | needs router + telemetry from Phase 1 |
| **Prompt caching / dedupe** — identical prompts don't re-run every frontier model | cost & latency, so users compare more freely | cache keyed on prompt+models |
| **Benchmark-informed ranking** per prompt class (LLM evals + curated suites) | pre-computed trust, fast path | ingest benchmark data (DO catalog already exposes MMLU etc.) |
| **Cost/latency "good enough" checker** — suggest the cheapest model that meets a quality bar | the highest-value real ask: "is the expensive model worth it?" | needs judge scores |

## Phase 3 — Model confidence platform (own the decision layer on DO)

| Initiative | Why |
|---|---|
| **OpenAI-compatible gateway product** — one endpoint that routes to the best model per prompt (routing-as-a-service), with ModelArena as the visible face | DO becomes the *neutral* place to buy model quality; a real moat vs single-vendor lock-in |
| **A/B model rollouts + canaries** — customers route a % of traffic to a new model and compare quality/cost | upgrades become safe, measurable, de-risked |
| **Feedback loops into routers** — thumbs-up/down + captured choices retrain/retune routing | the comparison product feeds the router, compounding trust |
| **Spend/quality observability & budgets** — dashboards, alerts, guardrails per team | enterprise adoption (finance/legal need it) |
| **Multi-modal & embeddings variance** — extend comparison to image/audio/embedding models | broader surface; reuses the same grid pattern |

---

## North-star metrics
- **Time-to-decide** for "which model for this prompt" (min)
- **% of runs where the chosen model is later validated as best** (judge vs. pick)
- **Switching lift** — % of users who move to a cheaper/faster model after a run (the real FOMO win)
- **Retention** inside DO's catalog (did they stay, vs. leaving for a vendor)

## Sequencing principle
Everything that makes the *existing decision* more trustworthy (judges, evals,
history) comes before anything that adds surface area (modalities, gateway).
Guardrails (quotas, budgets, observability) should land before broad
multi-tenant rollout so traction doesn't outrun safety.
