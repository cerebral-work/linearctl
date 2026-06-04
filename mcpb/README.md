# linearctl — Claude Desktop extension (`.mcpb`)

`manifest.json` packages the `linearctl mcp serve` MCP server as a Claude Desktop
extension. It launches the **installed `linearctl` binary** (per ADR / plugin-spec
D5), so it is a tiny manifest-only bundle rather than a self-contained one.

## Prerequisite
`linearctl` must be on `PATH` (install via `mise use -g "github:cerebral-work/linearctl"`).
Zero-prerequisite per-OS bundling is deferred (plugin-spec §9).

## Pack
```sh
npx @anthropic-ai/mcpb pack mcpb/ dist/linearctl.mcpb
```

## Install
Open Claude Desktop → Settings → Extensions → install `linearctl.mcpb` (or
double-click it). On first run Desktop prompts for the **Linear API Key** (a
masked `sensitive` field) and stores it in the OS keychain; it is injected as
`LINEAR_API_KEY` — never written to any file.

## Verify
The `linearctl`, `project_list` (read), `file_issue`, `project_create`,
`issue_update`, `issue_close` (write) tools appear in the Desktop tool list.
