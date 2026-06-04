# `linearctl` plugin — Claude Code plugin + Claude Desktop extension

**Status:** proposed (spec). Ships the linearctl capability set into Claude via a
single shared MCP core, distributed as both a Claude Code plugin and a Claude
Desktop (`.mcpb`) extension. Companion to `docs/spec.md` (the CLI spec) and
`docs/decisions.md` (ADRs).

## Decisions (settled with the operator, 2026-06-04)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Primary job | **Read + act** — surface Linear context in chat *and* take actions (file / project / update / close) |
| D2 | Target surface | **Both**, off one shared MCP core (Desktop + Claude Code; CC also gets optional slash commands) |
| D3 | Architecture | **MCP server reusing `src/` logic** — factor a shared core lib; CLI and MCP both call it (no subprocess, no reimplementation) |
| D4 | Distribution | **From this repo** — a `.claude-plugin/` marketplace entry for Claude Code + an `.mcpb` bundle for Desktop |
| D5 | Runtime | **Invoke the installed binary** — both surfaces run `linearctl mcp serve` off the mise-installed binary on PATH (coheres with ADR-0001) |
| D6 | Write safety | **Annotate + no destructive ops** — MCP tool annotations (`readOnlyHint` / `destructiveHint`); expose create/update/close, **never** delete/archive; rely on client tool-confirmation |
| D7 | v1 phasing | **Ship what exists, grow incrementally** — v1 = whoami + file + project + update/close; add digest/triage/milestone tools as M1 lands |

## 1. Motivation & positioning

The CLI is the headless surface for scripts/CI. The plugin is the **in-conversation**
surface: Claude (Desktop or Code) can read Linear state and take bounded actions
without the operator leaving the chat. One Linear integration, three consumers
(CLI, Claude Code, Claude Desktop), **one core** — no logic forks.

This does *not* replace the M4 native-agent roadmap (`docs/spec.md` §10): that is an
OAuth `actor=app` agent reacting to webhooks. The plugin is the **client-side tool
surface** — complementary, and shippable now.

## 2. Architecture — shared core

Today each `src/commands/*` file calls `makeClient()` and does its Linear logic
inline, then formats output. To feed both the CLI and an MCP server without
duplication, factor the Linear logic out of the command bodies:

```
src/
  core/                 # NEW — pure-ish domain fns: (client, typed params) → typed data
    whoami.ts           #   no commander, no MCP, no process.exit, no console
    issues.ts           #   createIssue, updateIssue, closeIssue, triage, digest
    projects.ts         #   createProject, listProjects, milestone
    teams.ts            #   resolveTeamByKey (moved from lib/resolve.ts)
  commands/*            # THIN: parse flags → call core → printTable/printJson
  mcp/
    serve.ts            # NEW — McpServer + StdioServerTransport; registers one tool per core fn
    tools.ts            #   tool defs: input schema (zod) + annotations + core call + result shaping
  index.ts              # adds the `mcp serve` subcommand
```

- **`linearctl mcp serve`** — a new subcommand that boots a stdio MCP server
  (`@modelcontextprotocol/sdk`, `McpServer` + `StdioServerTransport`). This single
  entry point is what both the plugin and the `.mcpb` launch. Exact SDK call
  surface is verified against context7 at implementation time (the SDK API moves).
- **Core fns** take a `LinearClient` + typed params and return typed data. They
  throw on error (no `process.exit`); the CLI maps errors to exit codes, the MCP
  layer maps them to tool errors. This is the refactor that makes D3 real.
- **No subprocess, no shelling out** — the MCP server is the same binary running a
  different entry point, sharing the in-process core (contrast with the rejected
  "shell out to the binary" option).

## 3. Tool catalog

Tools are `snake_case verb_noun`; the client namespaces them under the server.
Annotations drive D6 (write safety).

### v1 — ships now (logic already exists)

| Tool | Params | Annotation | Core |
|------|--------|------------|------|
| `whoami` | — | `readOnlyHint` | core.whoami |
| `file_issue` | team, title, description?, project?, labels[] | write (`destructiveHint:false`) | core.createIssue |
| `project_create` | name, team, description? | write | core.createProject |
| `project_list` | team? | `readOnlyHint` | core.listProjects |
| `issue_update` | id, state?, assignee?, labels[]?, project?, priority? | write | core.updateIssue *(depends on CER-1156)* |
| `issue_close` | id | write | core.closeIssue *(→ team completed state; CER-1156)* |

### v1.x — added as the M1 read commands land

| Tool | Params | Annotation | Core |
|------|--------|------------|------|
| `digest` | since?, team? | `readOnlyHint` | core.digest *(M1 / CER-1137)* |
| `triage` | team | `readOnlyHint` | core.triage *(M1 / CER-1138)* |
| `milestone` | project? | `readOnlyHint` | core.milestone *(M1 / CER-1139)* |

**Excluded by D6:** no `issue_delete`, no `project_archive`, no `issue_archive`.
Destruction stays a deliberate human action outside the model's tool surface.

### Claude Code slash commands (optional, v1.1 sugar)

The MCP tools are sufficient on their own. As ergonomic shortcuts, the CC plugin
*may* bundle thin slash commands (`commands/*.md`) like `/linear-digest`,
`/linear-file` that prompt the corresponding tool call. Not required for v1.

## 4. Authentication

The Linear key never lives in a checked-in file. Per surface:

- **Claude Code plugin** — `plugin.json` declares the server with
  `env: { "LINEAR_API_KEY": "${LINEAR_API_KEY}" }`; Claude Code interpolates the
  user's environment variable at server start. Same env contract as the CLI
  (`docs/spec.md` §5) — 1Password / `op run` / shell export.
- **Claude Desktop** — the `.mcpb` `manifest.json` declares a `userConfig` entry
  of `type: "password"` (`required: true`); Desktop prompts once, stores it in the
  OS keychain (macOS) / Credential Manager (Windows), and injects it as
  `LINEAR_API_KEY` via `${user_config.linearApiKey}`. The key is never visible in
  any config file.

`makeClient()` already reads `LINEAR_API_KEY` from the environment only — no change
needed; both surfaces converge on that one env var.

## 5. Distribution artifacts

All ship from this repo (D4). Concrete shapes, grounded in the current docs:

### 5.1 Claude Code plugin — `.claude-plugin/plugin.json`

```json
{
  "name": "linearctl",
  "description": "Linear workflows in Claude — read context, file/triage/close issues.",
  "version": "0.1.0",
  "author": { "name": "Cerebral Work Institute" },
  "homepage": "https://github.com/cerebral-work/linearctl",
  "license": "MIT",
  "mcpServers": {
    "linearctl": {
      "command": "linearctl",
      "args": ["mcp", "serve"],
      "env": { "LINEAR_API_KEY": "${LINEAR_API_KEY}" }
    }
  }
}
```

Note D5: `command: "linearctl"` resolves the mise-installed binary on PATH (not a
bundled per-OS binary). The plugin assumes the CLI is installed — documented as a
prerequisite, consistent with the single-binary/mise thesis.

### 5.2 Marketplace — `.claude-plugin/marketplace.json` (repo root)

```json
{
  "name": "cerebral-work",
  "description": "Cerebral Work Institute plugins.",
  "plugins": [
    { "name": "linearctl",
      "source": { "type": "github", "repo": "cerebral-work/linearctl", "path": "/" },
      "tags": ["linear", "automation", "mcp"] }
  ]
}
```

Install UX: `/plugin marketplace add cerebral-work/linearctl` → `/plugin install linearctl@cerebral-work`.

### 5.3 Claude Desktop — `.mcpb` bundle `manifest.json`

```json
{
  "manifest_version": "0.3",
  "name": "linearctl",
  "version": "0.1.0",
  "description": "Linear workflows in Claude Desktop — read context, file/triage/close.",
  "author": { "name": "Cerebral Work Institute" },
  "license": "MIT",
  "server": {
    "type": "binary",
    "command": "linearctl",
    "args": ["mcp", "serve"],
    "env": { "LINEAR_API_KEY": "${user_config.linearApiKey}" }
  },
  "userConfig": [
    { "key": "linearApiKey", "type": "password", "label": "Linear API Key", "required": true }
  ],
  "compatibility": { "os": ["darwin", "win32", "linux"] }
}
```

D5 caveat to resolve at build time: `type: "binary"` + `command: "linearctl"` relies
on the binary being on PATH; a `.mcpb` is normally self-contained. If we want the
zero-prereq Desktop experience later, that becomes the "bundle per-OS binaries"
path (a v2 packaging change, explicitly deferred here).

## 6. Implementation plan (the build, in order)

1. **Core refactor** — extract `src/core/*` from the existing command bodies;
   rewire `commands/*` to call core. Pure refactor, no behavior change; existing
   tests stay green, add core-level unit tests. *(Prereq for everything.)*
2. **`mcp serve` subcommand** — add `@modelcontextprotocol/sdk`; stand up the
   stdio server; register the **v1** tools (whoami, file_issue, project_create,
   project_list). Verify with the MCP Inspector + a live `whoami` tool call.
3. **`issue_update` / `issue_close`** — implement `core.updateIssue` /
   `core.closeIssue` (this also delivers the CLI `update`/`close` commands —
   CER-1156). Add the matching tools with write annotations.
4. **Claude Code plugin** — add `.claude-plugin/plugin.json` + repo-root
   `marketplace.json`; install locally via `/plugin marketplace add ./` and verify
   tools appear and a write round-trips.
5. **Claude Desktop `.mcpb`** — author `manifest.json`, pack the bundle, install in
   Desktop, verify the password `userConfig` injects the key and tools work.
6. **Reads (v1.x)** — as M1 lands (digest/triage/milestone — CER-1137/1138/1139),
   add `core.*` + the read tools. Plugin grows without re-release of the shell.
7. **Docs + CI** — README install sections (both surfaces); CI step that builds the
   binary and smoke-runs `mcp serve` (handshake + tools/list) so a broken server is
   caught at PR time, mirroring the existing `--version` smoke.

## 7. Tickets to file (into the linearctl Linear project, via `linearctl file`)

- `refactor(core): extract src/core from command bodies` (prereq)
- `feat(mcp): linearctl mcp serve — stdio MCP server + v1 tools`
- `feat(mcp): write tools (file/project/update/close) with annotations` *(folds in CER-1156)*
- `feat(plugin): Claude Code plugin.json + marketplace.json`
- `feat(plugin): Claude Desktop .mcpb bundle + userConfig secret`
- `feat(mcp): read tools (digest/triage/milestone)` *(gated on M1)*
- `ci: smoke-test mcp serve handshake on PR`
- `docs: plugin + extension install guides`

These slot as a new track alongside `docs/spec.md` M3 (more workflows); the core
refactor and v1 MCP server are the critical path.

## 8. Verification

- Core unit tests green; `bun run typecheck` / `bun test` / `bun run build` clean.
- `mcp serve` passes an MCP `initialize` + `tools/list` handshake (Inspector / CI smoke).
- Live: a `file_issue` tool call creates an issue in the linearctl project and
  round-trips (then trashed), exactly as the CLI was verified.
- Claude Code: plugin installs from local marketplace, tools listed, write works.
- Claude Desktop: `.mcpb` installs, password prompt stores the key in the keychain,
  tools work with no key in any file.

## 9. Risks / open minor points

- **MCP SDK churn** — pin `@modelcontextprotocol/sdk`; verify the server API against
  context7 at implementation (don't code from memory).
- **bun-compiled binary as an MCP stdio server** — confirm the compiled binary
  speaks clean JSON-RPC on stdout with no stray logging (route all logs to stderr).
  Smoke-test in CI.
- **PATH assumption (D5)** — both manifests assume `linearctl` is installed; if not,
  the server fails to launch. Documented prereq now; per-OS bundling is the deferred
  escape hatch.
- **`.mcpb` `type: binary` vs bundled runtime** — flagged in §5.3; resolve at build
  time, default to the installed-binary path per D5.
