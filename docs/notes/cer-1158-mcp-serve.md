# CER-1158 — `linearctl mcp serve` + v1 tools (working scope notes)

> **Working/scratch notes**, prepped on branch `cer-1158-mcp-serve` (off
> `refactor/core`) while CER-1157 is gated on merge. Fold into the implementation
> and **remove this file before the CER-1158 PR** — it is planning scaffolding,
> not shipped docs. Source of truth: `docs/plugin-spec.md` §2–§3, §6.
>
> Stacked on `refactor/core` so `src/core/*` is present to build against, but this
> branch adds **no code that depends on unmerged work** yet — notes only until #9
> lands, then implement here (rebase onto main after merge).

## Goal
A `linearctl mcp serve` subcommand that runs a **stdio MCP server** exposing the
v1 tool surface, calling the same `src/core/*` fns the CLI calls. This is the one
entry point both the Claude Code plugin (CER-1160) and the Desktop `.mcpb`
(CER-1161) launch.

## Dependencies
- Add `@modelcontextprotocol/sdk` (pin the version). **Verify the exact server API
  against context7 at implementation time** — the SDK surface moves; do not code
  the `McpServer`/transport calls from memory.
- No new Linear deps — reuse `@linear/sdk` via `makeClient()` and `core/*`.

## Layout (new)
```
src/mcp/
  serve.ts     # boot McpServer + StdioServerTransport; register tools; connect
  tools.ts     # tool defs: name, zod input schema, annotations, core call, result shaping
src/index.ts   # add `mcp` command group → `serve` subcommand
```

## v1 tools (this ticket — writes that already have core support)
Map 1:1 to `core/*`. Annotations per `docs/plugin-spec.md` D6.

| Tool | Input (zod) | Annotation | Core call |
|------|-------------|------------|-----------|
| `whoami` | `{}` | `readOnlyHint: true` | `getWhoami(client)` |
| `project_list` | `{ team?: string }` | `readOnlyHint: true` | `listProjects(client, team)` |
| `file_issue` | `{ team, title, description?, project?, labels?: string[] }` | write (`destructiveHint: false`) | `createIssue(client, {teamKey:team, ...})` |
| `project_create` | `{ name, team, description? }` | write (`destructiveHint: false`) | `createProject(client, {teamKey:team, ...})` |

**Not in this ticket:** `issue_update` / `issue_close` → **CER-1159** (needs new
`core.updateIssue`/`closeIssue`). `digest`/`triage`/`milestone` → **CER-1162**
(gated on M1). No `*_delete`/`*_archive` ever (D6).

## Discipline / foot-guns
- **stdout is the JSON-RPC channel.** ALL logging → **stderr**. Audit that no
  `core/*` or `lib/*` path writes to stdout during a tool call (today only the
  command layer writes stdout via `printJson`/`printTable` — the MCP layer must
  NOT call those; it shapes its own result objects). Confirm the bun-compiled
  binary emits clean JSON-RPC (no banner/stray output) on stdout.
- **Auth:** `makeClient()` reads `LINEAR_API_KEY` from env and `process.exit(1)`
  with a stderr message if missing. At server *startup* that's acceptable (server
  fails to launch). Decide: keep exit-on-missing at boot, or surface as an MCP
  init error. Lean: validate the key presence at `serve` startup before
  `transport.connect`, so the failure is a clean "not configured" rather than a
  mid-handshake crash.
- **Error mapping:** `core/*` throws `Error` → tool handler catches → return an
  MCP error result (`isError: true`, message = `err.message`). Never let it throw
  past the handler and kill the server.
- **Stdin convention:** the CLI's `--desc -` stdin trick is CLI-only; MCP tools
  take `description` as a normal string param (core already takes a resolved
  string — no stdin in core, good).

## Open questions (resolve during impl)
- **Result shape:** text content only, or also `structuredContent` (typed JSON the
  client can consume)? Lean: both — a human-readable text block + structuredContent
  mirroring the core return type.
- **Server version string:** read from `package.json`? Ties to the known
  version-sync bug (`index.ts` hardcodes `0.1.0`); pick one source of truth for
  both `--version` and the MCP server version while here.
- **Tool naming:** `snake_case verb_noun` (locked in spec). Confirm the client
  namespaces by server name `linearctl` so unprefixed is fine.

## Verification plan
- `bun run typecheck` / `bun test` / `bun run build` green.
- MCP Inspector (`npx @modelcontextprotocol/inspector`) → `initialize` + `tools/list`
  show the 4 tools with correct annotations.
- Live: `whoami` tool returns the viewer; `file_issue` creates in the linearctl
  project and round-trips, then trash it (same create+trash discipline as CER-1165).
- CI handshake smoke is a **separate** ticket (CER-1163).
