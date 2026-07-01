# Changelog

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
