# Roadmap — agentic infra ops (TOD)

> Generated 2026-07-22 via `linearctl roadmap --project "agentic infra ops (TOD)"`.
> 3 milestones · 13 issues · 1 in progress · 12 backlog.

---

## Milestone 1 — Local Inference & Model Serving

`[░░░░░░░░░░░░░░░░░░░░] 0%  0/6`

The 5090 model-serving stack: T2 model bring-up, hermes local endpoint
config, `/local` harness exercise, vLLM KV-cache (APC + OffloadingConnector),
LMCache PoC, and the fine-tune/quantize lane (Unsloth Core + llm-compressor).

| Issue | State | Priority | Assignee | Title |
|-------|-------|----------|----------|-------|
| [TOD-988](https://linear.app/cerebral-work/issue/TOD-988/serve-a-t2-model-on-the-5090-and-validate-all-three-harnesses-against) | Backlog | — | — | Serve a T2 model on the 5090 and validate all three harnesses against it |
| [TOD-989](https://linear.app/cerebral-work/issue/TOD-989/hermes-cli-configlocal-endpointyaml-validate-keys-against-hermes-0180) | Backlog | — | — | hermes cli-config.local-endpoint.yaml: validate keys against hermes 0.18.0 |
| [TOD-990](https://linear.app/cerebral-work/issue/TOD-990/exercise-local-extension-live-pin-bump-cadence-for-the-three-harnesses) | Backlog | — | — | Exercise /local extension live + pin-bump cadence for the three harnesses |
| [TOD-992](https://linear.app/cerebral-work/issue/TOD-992/local-kv-wins-confirm-vllm-v0240-apc-hit-rate-enable) | Backlog | medium | — | Local KV wins: confirm vLLM v0.24.0 APC hit-rate + enable OffloadingConnector on the 5090 |
| [TOD-993](https://linear.app/cerebral-work/issue/TOD-993/lmcache-poc-lmcachevllm-openaiv051-cu129-vs-native-offloadingconnector) | Backlog | medium | — | LMCache PoC: lmcache/vllm-openai:v0.5.1-cu129 vs native OffloadingConnector baseline |
| [TOD-995](https://linear.app/cerebral-work/issue/TOD-995/fine-tunequantize-lane-unsloth-core-uv-pinned-llm-compressor-0120) | Backlog | medium | — | Fine-tune/quantize lane: Unsloth Core (uv-pinned) + llm-compressor 0.12.0; repoint AutoAWQ references |

---

## Milestone 2 — Agent Harness & MCP Migration

`[░░░░░░░░░░░░░░░░░░░░] 0%  0/4`

Harness-side work: hermes-agent cluster bump, bench evidence format
(inspect-ai + lm_eval), MCP protocol migration prep (sessions/sampling/
roots/setLevel inventory before 2026-07-28 spec final), and the LLMRouter
offline-vs-static data question on bench traces.

| Issue | State | Priority | Assignee | Title |
|-------|-------|----------|----------|-------|
| [TOD-991](https://linear.app/cerebral-work/issue/TOD-991/unsigned-paas-bump-cluster-hermes-agent-0160-0180) | In Progress | urgent | @ctodie | unsigned-paas: bump cluster hermes-agent 0.16.0 -> 0.18.0 |
| [TOD-994](https://linear.app/cerebral-work/issue/TOD-994/bench-evidence-format-inspect-ai-03244-eval-transcripts-lm-eval) | Backlog | medium | — | Bench evidence format: inspect-ai 0.3.244 .eval transcripts + lm_eval loglikelihood in unsigned-gg/bench |
| [TOD-996](https://linear.app/cerebral-work/issue/TOD-996/mcp-migration-prep-inventory-sessionssamplingrootssetlevel-usage) | Backlog | high | — | MCP migration prep: inventory sessions/sampling/roots/setLevel usage before 2026-07-28 spec final |
| [TOD-997](https://linear.app/cerebral-work/issue/TOD-997/routing-brain-data-question-llmrouter-method-zoo-offline-vs-static) | Backlog | medium | — | Routing-brain data question: LLMRouter method zoo offline vs static role→model mapping on bench traces |

---

## Milestone 3 — Cygnus MCP Platform Deployment

`[░░░░░░░░░░░░░░░░░░░░] 0%  0/3`

Cygnus remote MCP endpoint rollout: OAuth flows + token minting (Google PAT,
Telegram, Stripe, Lusha, voicemode-dev), Phase 2 apply (push images, seed
OpenBao, publish chart, apply manifests, smoke), and cutover local
~/.claude MCP configs to remote endpoints + decommission local containers.

| Issue | State | Priority | Assignee | Title |
|-------|-------|----------|----------|-------|
| [TOD-1008](https://linear.app/cerebral-work/issue/TOD-1008/complete-mcp-oauth-flows-token-minting-google-pat-telegram-bot-stripe) | Backlog | medium | — | Complete MCP OAuth flows + token minting (Google PAT, Telegram bot, Stripe, Lusha, voicemode-dev) |
| [TOD-1009](https://linear.app/cerebral-work/issue/TOD-1009/cygnus-phase-2-apply-push-mcp-images-seed-openbao-publish-chart-apply) | Backlog | medium | — | Cygnus Phase 2 apply: push MCP images + seed OpenBao + publish chart + apply manifests + smoke |
| [TOD-1010](https://linear.app/cerebral-work/issue/TOD-1010/cut-local-claude-mcp-configs-over-to-remote-cygnus-endpoints) | Backlog | medium | — | Cut local ~/.claude MCP configs over to remote Cygnus endpoints + decommission local containers |
