# Changelog

## [Unreleased]


### Features

* **milestone:** `milestone create` subcommand — create project milestones headless (CER-1686)
* **project:** `project update` subcommand — update project state, name, description (CER-1687)
* **roadmap:** milestone timeline view with progress and issue lists per milestone (CER-1688)
* **watch:** `linearctl watch --once --payload` — full-loop fallback path for AgentSessionEvent payloads; loop driver library (`emitThought` → `driveAgentLoop` → `moveToStartedIfDelegated`) with 10s-SLA thought-first ordering (CER-1149)
* **operator:** `linearctl operator` long-running daemon — CF Queue `linear-agent-events` consumer + Unix-socket control (POST /delegate, GET /healthz) for `linearctl watch` delegation; token cache, graceful SIGINT/SIGTERM shutdown (CER-1149)
* **handoff:** `linearctl handoff` command tree — create / list / show / resolve session handoff notes persisted as markdown under `~/.local/state/linearctl/handoffs/` (XDG state dir shared with the operator socket); cross-session memory bridge for the maintainer-agent (Track 6 sub-feature B)


### Bug Fixes

* **file:** `--stdin` dry-run now validates project name resolution so the preview matches `--apply` (CER-1604)


## [0.7.0](https://github.com/cerebral-work/linearctl/compare/v0.6.0...v0.7.0) (2026-07-11)


### Features

* **comments:** comments-by-author — the 'what did X say' scan in one query (CER-1187) ([#55](https://github.com/cerebral-work/linearctl/issues/55)) ([1273fbc](https://github.com/cerebral-work/linearctl/commit/1273fbcc188a9ec385662c6a47ed18098b82bffe))
* **doc:** list / create / update Linear documents (CER-1344) ([#57](https://github.com/cerebral-work/linearctl/issues/57)) ([2f6dc94](https://github.com/cerebral-work/linearctl/commit/2f6dc947c6325ebe75ff4198f18e0f9523894ae2))
* **file:** --stdin batch mode with pre-flight quota gate (CER-1141) ([#53](https://github.com/cerebral-work/linearctl/issues/53)) ([08ab4ef](https://github.com/cerebral-work/linearctl/commit/08ab4ef7c6303335e3f0c0a43e1f8f5709404060))
* **graph:** --parent / --blocked-by / --related-to on file+update, link command (CER-1342, CER-1192) ([#51](https://github.com/cerebral-work/linearctl/issues/51)) ([5af6d80](https://github.com/cerebral-work/linearctl/commit/5af6d80fe0a57352e9c7b4f0121570154a8daff4))
* **release-notes:** markdown notes from completed issues in a range (CER-1146) ([#56](https://github.com/cerebral-work/linearctl/issues/56)) ([81b8689](https://github.com/cerebral-work/linearctl/commit/81b8689d6813f8a01ba173932b3341b9faf5a423))
* **standup:** render digest as a standup — no auto-posting by design (CER-1147) ([#58](https://github.com/cerebral-work/linearctl/issues/58)) ([f44046c](https://github.com/cerebral-work/linearctl/commit/f44046ccf5e7e9906c72d4e32db1d3656547a9e7))

## [0.6.0](https://github.com/cerebral-work/linearctl/compare/v0.5.0...v0.6.0) (2026-07-11)


### Features

* **cli:** interactive slices — fuzzy issue picker (show/close) + xref --fix confirm gate (CER-1551) ([#41](https://github.com/cerebral-work/linearctl/issues/41)) ([6bf30b9](https://github.com/cerebral-work/linearctl/commit/6bf30b9150a42df13517a64470fe12c6d54a8f42))
* **cycle:** current-cycle review — scope, burn-down, at-risk, carry-over (CER-1143) ([#50](https://github.com/cerebral-work/linearctl/issues/50)) ([4619967](https://github.com/cerebral-work/linearctl/commit/4619967c851e98eccb6a836b6e8d1c04562afa4f))
* **dupcheck:** fuzzy title match before filing + file --check-dups guard (CER-1559) ([#44](https://github.com/cerebral-work/linearctl/issues/44)) ([278e169](https://github.com/cerebral-work/linearctl/commit/278e1692eb65ae885a87329f8419e1293081f6be))
* **file:** --assignee / --priority / --milestone parity with update ([#43](https://github.com/cerebral-work/linearctl/issues/43)) ([3e8942b](https://github.com/cerebral-work/linearctl/commit/3e8942b12b879bbdf86d39d2b7f77ae91d825951))
* **history:** issue activity timeline — the audit trail show doesn't surface (CER-1561) ([#48](https://github.com/cerebral-work/linearctl/issues/48)) ([64d2e35](https://github.com/cerebral-work/linearctl/commit/64d2e35a7d92935f4802bc4162ada270c2604c02))
* **label:** list / create / rename — headless label management (CER-1558) ([#47](https://github.com/cerebral-work/linearctl/issues/47)) ([4f0c23d](https://github.com/cerebral-work/linearctl/commit/4f0c23da128b862b26f045eaceadb9c6964b8381))
* **park:** file user stories straight into Backlog (CER-1557) ([#46](https://github.com/cerebral-work/linearctl/issues/46)) ([2321f6f](https://github.com/cerebral-work/linearctl/commit/2321f6f36c24b14e375835d31440cc3c700d5553))
* **search:** arbitrary-criteria issue search — the grep for Linear (CER-1560) ([#40](https://github.com/cerebral-work/linearctl/issues/40)) ([e0908f3](https://github.com/cerebral-work/linearctl/commit/e0908f31903731ab16f5169a51d87b9139f5eca4))
* **template:** file issues from reusable markdown templates (CER-1562) ([#49](https://github.com/cerebral-work/linearctl/issues/49)) ([0049059](https://github.com/cerebral-work/linearctl/commit/0049059e585c6a604c57365c429182dea1046853))
* **update:** edit title and description (CER-1341) ([#45](https://github.com/cerebral-work/linearctl/issues/45)) ([e1e0620](https://github.com/cerebral-work/linearctl/commit/e1e0620902ebc319f7f80ce57337726c1b6211fc))


### Bug Fixes

* **cli:** picker direct-entry choice appends last, not first ([#42](https://github.com/cerebral-work/linearctl/issues/42)) ([c2142af](https://github.com/cerebral-work/linearctl/commit/c2142af247ea79e10cf5517bf56f120bdbdd2c8e))
* **core:** eliminate N+1 lazy-relation fetches — grooming reads select state/assignee inline ([#38](https://github.com/cerebral-work/linearctl/issues/38)) ([df941f1](https://github.com/cerebral-work/linearctl/commit/df941f194e525f8f718a708474bc8157467bae31))

## [0.5.0](https://github.com/cerebral-work/linearctl/compare/v0.4.0...v0.5.0) (2026-07-10)


### Features

* **cli:** interactive mode — prompts + spinners (M3) ([#37](https://github.com/cerebral-work/linearctl/issues/37)) ([e21fccb](https://github.com/cerebral-work/linearctl/commit/e21fccbaa9b7980656e6c42ba76f2a13ac649183))
* **cli:** TTY-gated styled tables — picocolors + cli-table3 behind isStyled() ([#35](https://github.com/cerebral-work/linearctl/issues/35)) ([e892f37](https://github.com/cerebral-work/linearctl/commit/e892f37a74d671be63030bb6470f68e922ed7389))
* **comment:** add headless comment command + comment_issue MCP tool ([#33](https://github.com/cerebral-work/linearctl/issues/33)) ([596a229](https://github.com/cerebral-work/linearctl/commit/596a229dc3e008dbd91dc8a13fee3f583a41c89d))


### Documentation

* add feature proposals + TUI/CLI library landscape reference ([06931b6](https://github.com/cerebral-work/linearctl/commit/06931b69526e3d66f613bf87f6dd7a9e0a48cb4c))
* add tui + interactive mode feature proposals ([bc61c40](https://github.com/cerebral-work/linearctl/commit/bc61c404d7ce76f8724ae202d764c1fa2ddcb023))
* **features:** mark proposals ticketed with CER IDs after dogfood filing ([#34](https://github.com/cerebral-work/linearctl/issues/34)) ([a2672c3](https://github.com/cerebral-work/linearctl/commit/a2672c348ccef9708052a52094d024773f6bed10))

## [0.4.0](https://github.com/cerebral-work/linearctl/compare/v0.3.0...v0.4.0) (2026-07-02)


### Features

* **doc:** project overview get/set — mirror plan docs to Linear headlessly ([#26](https://github.com/cerebral-work/linearctl/issues/26)) ([36e6625](https://github.com/cerebral-work/linearctl/commit/36e66256f322c6458ac26b8965cdb0b1c6fc1208))

## [0.3.0](https://github.com/cerebral-work/linearctl/compare/v0.2.0...v0.3.0) (2026-07-01)


### Features

* linearctl bulk-remediation + robustness (batch, retry, --project, bulk, milestone delete, label-team fix) ([#23](https://github.com/cerebral-work/linearctl/issues/23)) ([abb0743](https://github.com/cerebral-work/linearctl/commit/abb07430db75f7727ceb17d33a52ef0c75a07fdf))
* show + ratelimit + xref --fix — the reads and remediation the sweep sessions lacked ([#25](https://github.com/cerebral-work/linearctl/issues/25)) ([a840a0e](https://github.com/cerebral-work/linearctl/commit/a840a0e7cd6286322e6e9c9ef88eae31a06af639))

## [0.2.0](https://github.com/cerebral-work/linearctl/compare/v0.1.0...v0.2.0) (2026-06-05)


### Features

* **file:** headless issue creation ([#7](https://github.com/cerebral-work/linearctl/issues/7)) ([8a0fa84](https://github.com/cerebral-work/linearctl/commit/8a0fa84e26172d7dc78027092cfff3cf9f7b1418))
* **mcp:** issue update/close — CLI commands + MCP write tools ([#11](https://github.com/cerebral-work/linearctl/issues/11)) ([d2a8f89](https://github.com/cerebral-work/linearctl/commit/d2a8f8920bb21e5602159182201a28c094aae224))
* **mcp:** linearctl mcp serve — stdio MCP server + v1 tools ([#10](https://github.com/cerebral-work/linearctl/issues/10)) ([8a4137d](https://github.com/cerebral-work/linearctl/commit/8a4137dca4ac456edf1c65aaee3cb670da41fc19))
* **mcp:** read tools — digest/triage/milestone/stale ([#17](https://github.com/cerebral-work/linearctl/issues/17)) ([d420108](https://github.com/cerebral-work/linearctl/commit/d42010866ca2a98bff3f4cf85a6d1f8923b59ac2))
* **milestone:** per-milestone burn-down + extract mapPool ([#16](https://github.com/cerebral-work/linearctl/issues/16)) ([5232e2f](https://github.com/cerebral-work/linearctl/commit/5232e2ffeffb2960ded084adb8053c739215ebc4))
* **plugin:** Claude Code plugin + Claude Desktop .mcpb packaging ([#12](https://github.com/cerebral-work/linearctl/issues/12)) ([0211196](https://github.com/cerebral-work/linearctl/commit/0211196a8cb1054ac9daa217d7813bb6d82fafb2))
* **project:** create + list Linear projects ([#6](https://github.com/cerebral-work/linearctl/issues/6)) ([7199209](https://github.com/cerebral-work/linearctl/commit/7199209ace6410d95fa7e780949c65848448f766))
* scaffold linear-workflows (lw) — headless Linear workflow CLI ([fcd38eb](https://github.com/cerebral-work/linearctl/commit/fcd38ebc8ca4c02ed6ed63d6fa10796629e8c642))
* **stale:** stale-issue sweep by last-update age ([#14](https://github.com/cerebral-work/linearctl/issues/14)) ([6731c38](https://github.com/cerebral-work/linearctl/commit/6731c38a4f8086810d605e5c43b4e58cb376fcc7))
* **triage,digest:** finish the grooming surface verbs ([#13](https://github.com/cerebral-work/linearctl/issues/13)) ([da2479b](https://github.com/cerebral-work/linearctl/commit/da2479ba08d3274a55ce38b94fc1a761f6155fae))
* **xref:** PR&lt;-&gt;ticket cross-ref audit (read-only) ([#15](https://github.com/cerebral-work/linearctl/issues/15)) ([413d61e](https://github.com/cerebral-work/linearctl/commit/413d61ee3531c678d0194b12b4437b923ec940bf))


### Bug Fixes

* **ci:** drive linear-release from release.yml (close tag-trigger gap) ([#21](https://github.com/cerebral-work/linearctl/issues/21)) ([9b207fe](https://github.com/cerebral-work/linearctl/commit/9b207febbbedf22ed3c5909d36b6e702d8b4f18e))
* read --version from package.json instead of hardcoding ([#20](https://github.com/cerebral-work/linearctl/issues/20)) ([af6f258](https://github.com/cerebral-work/linearctl/commit/af6f2589d7274288b4fa313368ed4e78bc680024))


### Code Refactoring

* **core:** extract src/core from command bodies ([#9](https://github.com/cerebral-work/linearctl/issues/9)) ([9c8cd82](https://github.com/cerebral-work/linearctl/commit/9c8cd8226cccecf36b4429191da5ee181568ab57))


### Documentation

* plugin + Desktop install guides; refresh stale status ([#19](https://github.com/cerebral-work/linearctl/issues/19)) ([dfec263](https://github.com/cerebral-work/linearctl/commit/dfec26341ca1b624f1bb20f84fe86d9705570f76))
* spec the linearctl plugin (Claude Code + Claude Desktop) ([#8](https://github.com/cerebral-work/linearctl/issues/8)) ([6c98105](https://github.com/cerebral-work/linearctl/commit/6c98105cca9b02257d3d467053273e6ece4868f7))
* use stable 1Password item ID in the op run auth example ([1e8aa60](https://github.com/cerebral-work/linearctl/commit/1e8aa60d3ece9a7a9172473cdc1f6e3014293e51))
