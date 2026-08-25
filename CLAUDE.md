# ModelArena — notes for Claude sessions

## Model switching (this session / workflow)
- **Claude Code `/model`** only switches between **Claude-family** models — it can **not** run this session on a DigitalOcean-hosted model (DO's `kimi-k3` etc. are inference-API models, not Claude runtime models). Do not imply Claude can ride on a DO model.
- The DigitalOcean-hosted **`kimi-k3`** is instead a **model in the ModelArena app catalog** (verified working on `inference.do-ai.run/v1`, completion + streaming). It's a reasoning model — streams `reasoning_content` (chain-of-thought) before the final answer; the streaming parser captures that.

## pi agent — DigitalOcean / kimi-k3 (configured & verified)
The `pi` coding-assistant CLI (v0.84.2, config in `~/.pi/agent/`) is wired so Mayank can develop on **Kimi K3 from DigitalOcean**:
- `models.json` has a `digitalocean` provider → `https://inference.do-ai.run/v1`, `api: openai-completions`, `apiKey: $DO_API_TOKEN`, model `kimi-k3` (reasoning → `thinkingFormat: "deepseek"`).
- `settings.json` default = `digitalocean` / `kimi-k3`. Key stored in `auth.json` (`digitalocean`) and exported as `DO_API_TOKEN` in `~/.zshrc`.
- Backups of the edited configs: `*.bak` beside each file.
- **Switch back (one-off):** `pi --provider deepinfra --model "deepseek-ai/DeepSeek-V4-Flash-0731" <msg>`
- **Switch back (default):** edit `~/.pi/agent/settings.json` → `defaultProvider: deepinfra`, `defaultModel: deepseek-ai/DeepSeek-V4-Flash-0731`.
- **Verify:** `pi auth check --provider digitalocean --model kimi-k3 --json`.

## Project context
- Build a **DigitalOcean Staff take-home PoC: multi-model LLM comparison** to fight "model FOMO."
- Real endpoint (verified): `https://inference.do-ai.run/v1` — OpenAI-compatible, auth `Bearer <DO_API_TOKEN>` (the user's DO PAT). Streaming SSE + standard `usage` fields confirmed.
- Confirmed-working catalog: `deepseek-v4-pro`, `deepseek-v4-flash-0731`, `deepseek-4-flash`, `llama-4-maverick`, `gemma-4-31B-it`, `mistral-3-14B`, plus `router:general` (auto-router that reveals its model choice). Premium Anthropic/OpenAI (GPT-5, Claude) are tier-locked on this workspace → keep catalog to confirmed models.
- Architecture + product spec live in **PLAN.md** (read it before coding). Deliverables also include DESIGN.md and ROADMAP.md.
- Deploy target: **App Platform**; `DO_API_TOKEN` goes in App Platform env, never in the repo.
