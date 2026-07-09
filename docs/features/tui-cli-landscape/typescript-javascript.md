# TypeScript / JavaScript — TUI/CLI Library Reference

State of the art in TS/JS terminal libraries. Adoption signals sourced from
GitHub and npm as of July 2026. This is the ecosystem linearctl lives in.

**Status legend:** ✅ active · ⚠️ stale/infrequent · ❌ dead/archived.

---

## Argument parsing

| Library | GH ★ | Weekly DL | Status | Notes |
|---------|------|-----------|--------|-------|
| **commander** | ~26k | 80M | ✅ active | The standard. linearctl uses this. Subcommands, options, TypeScript defs. |
| **yargs** | ~11k | 60M | ✅ active | Heavier, powerful. Great help generation, advanced parsing. |
| **citty** | ~3k | 5M | ✅ active | unjs ecosystem, minimal, ESM-only. |
| **clipanion** | ~1k | ~10M | ✅ maintained | Oclif's underlying parser. Class-based commands. |
| **meow** | ~3k | 40M | ⚠️ minimal | Minimal arg parsing for single-command CLIs. |
| **sade** | ~1k | ~5M | ✅ maintained | Lightweight, similar to meow. |

## Interactive prompts

| Library | GH ★ | Weekly DL | Status | Notes |
|---------|------|-----------|--------|-------|
| **@inquirer/prompts** | 21.5k | 6.1M | ✅ v8.5.2 | The standard. Per-prompt imports, 7.7k dependents. Pairs with commander/oclif. |
| **@clack/prompts** | 8.6k | 7.3M | ✅ v1.7.0 | Gum-like polish, actively shipped. Used by Vercel, Astro CLI, Turbopack. |
| **prompts** (terkel) | 11.3k | 43.9M | ⚠️ stale | Huge transitive base, unmaintained >12mo. |
| **enquirer** | 7.9k | 30.1M | ⚠️ minimal | Plugin-based, legacy. |
| **inquirer** (legacy) | 21.5k | 47M | ⚠️ legacy | Monolithic predecessor of @inquirer/prompts. |

## Full-screen TUI frameworks

| Framework | GH ★ | Weekly DL | Status | Notes |
|-----------|------|-----------|--------|-------|
| **ink** | 38.1k | 4.2M | ✅ v7.0.6 | React renderer for terminal. Claude Code, Gemini CLI, GitHub Copilot CLI. Inline + full-screen. |
| **OpenTUI** | 11.9k | 119k | ✅ v0.4.3 | Native Zig core + TS bindings. Powers OpenCode, terminal.shop. High performance, cell-diffing. |
| **Glyph** | 40 | low | ⚠️ early | React + Yoga, 20+ components, focus system (Tab, scopes, modal, JumpNav). Full-screen only. Aion, Epist. |
| **blessed** | 10.6k | ~1M | ❌ dead | Curses-like, 16k lines. Pioneered JS TUI. |
| **neo-blessed** | 403 | 23–44k | ❌ dead | blessed fork, last publish 7yr ago. |
| **@unblessed/core** | — | — | ⚠️ new | TS rewrite of blessed, flexbox engine. |
| **terminal-kit** | 2.4k | ~3M | ✅ maintained | Full suite: 256 color, mouse, screen buffer, tables, spinners, images. Imperative, non-React. |
| **melker** | — | — | ⚠️ new | HTML-like, document-first, Deno, sandboxed, flexbox. |

### Ink component libraries

| Library | Status | Notes |
|---------|--------|-------|
| **@inkjs/ui** | ⚠️ stale | v2.0.0 published 2 years ago. No updates since. Weakens Ink's component story. |
| **ink-ui** | ⚠️ minimal | Community components. |
| **Build your own** | — | The Ink-recommended path: compose primitives (Box, Text) into custom components. |

## Spinners & progress

| Library | Weekly DL | Status | Notes |
|---------|-----------|--------|-------|
| **ora** | 57M | ✅ v9.4.1 | The standard. `ora.promise()`, 80+ spinner styles. Key ecosystem project. |
| **listr2** | 28.7M | ✅ v10.2.2 | Multi-task lists, concurrent/serial, per-task spinners. |
| **cli-spinners** | 15M | ✅ active | Pure animation data (no rendering), used by ora. |
| **nanospinner** | ~5M | ✅ active | Minimal, tiny bundle. |
| **cli-progress** | ~20M | ✅ active | Progress bars, multi-bar, ETA. |

## Styling

| Library | Weekly DL | Notes |
|---------|-----------|-------|
| **chalk** | ~120M | The standard. Template literals, chainable, truecolor. |
| **picocolors** | ~80M | 14x smaller, 2x faster than chalk. sindresorhus. |
| **colorette** | ~60M | Minimal, used by many build tools. |
| **ansis** | growing | CJS/ESM, truecolor, Bun/Deno/Next.js compatible. 882k ops/sec. |
| **ansi-colors** | ~40M | 10–20x faster than chalk. gulp ecosystem. |
| **boxen** | ~30M | Bordered boxes — the `gum style` equivalent. |
| **kleur** | ~40M | Tiny, fast. |
| **figures** | ~40M | Unicode symbols (✔ ✖ ⚠ → ★). |
| **log-symbols** | ~30M | Status symbols (✓ ✖ ! ℹ). |
| **ansi-escapes** | ~50M | Raw escape sequences, low-level. Used by Ink. |
| **terminal-link** | ~15M | Clickable terminal links. |

## Tables

| Library | Weekly DL | Notes |
|---------|-----------|-------|
| **cli-table3** | ~25M | Pretty unicode tables, borders, alignment, word-wrap. |
| **tty-table** | ~10M | Windows-compatible, per-column callbacks. |
| **console-table-printer** | ~5M | Colored, compact. |

## Markdown rendering

| Library | Weekly DL | Notes |
|---------|-----------|-------|
| **marked + marked-terminal** | ~40M | Markdown parser + terminal renderer. |
| **markdown-it + markdown-it-highlightjs** | ~30M | Plugin-based, TS defs. |

## Syntax highlighting

| Library | Weekly DL | Notes |
|---------|-----------|-------|
| **shiki** | growing | VS Code grammars, streaming highlight for LLM outputs. |
| **highlight.js** | ~30M | Auto-detect, 190+ languages. |
| **cli-highlight** | ~10M | Highlight code in terminal. |

## Testing

| Library | Notes |
|---------|-------|
| **ink-testing-library** | `render()` → `lastFrame()` string capture, stdin mocking, rerender. In-memory, no real TTY. |
| **bun:test** | linearctl's test runner (per ADR-0001). |
| **vitest** | Vite-native test runner, snapshot support. |

## Binary distribution

| Tool | Notes |
|------|-------|
| **bun build --compile** | Single binary, embeds runtime (~60MB). Cross-compile 4 targets. linearctl uses this. |
| **Bunli** | Bun CLI framework: build, test, release, init, generate. |
| **pkg** | ⚠️ Vercel deprecated. Predecessor to bun compile. |
| **sea** | Node.js Single Executable Application (experimental). |

## Notifications & system integration

| Library | Weekly DL | Notes |
|---------|-----------|-------|
| **node-notifier** | ~15M | macOS, Windows toast, Linux libnotify. |
| **update-notifier** | ~30M | "Update available" npm check. |
| **clipboardy** | ~20M | System clipboard read/write. |
| **qrcode-terminal** | ~10M | QR codes in terminal. |

## ASCII art & branding

| Library | Weekly DL | Notes |
|---------|-----------|-------|
| **figlet** | ~15M | ASCII art text. Full FIGfont spec in TS. |
| **gradient-string** | ~20M | Gradient text colors. |
| **chalk-animation** | ~15M | Animated text (rainbow, pulse, glitch, radar). |
| **ascii-art** | ~5M | Comprehensive: images, styles, tables, graphs, figlet. |
| **cli-ascii-logo** | low | Gradient ASCII logos with animations. |

---

## TS/JS "winners" summary

| Category | Recommended | Runner-up |
|----------|-------------|-----------|
| Arg parsing | commander | yargs (more features) |
| Prompts | @inquirer/prompts | @clack/prompts (gum-like polish) |
| TUI framework | ink | OpenTUI (native perf), Glyph (components) |
| Spinner/progress | ora | listr2 (multi-task) |
| Styling | chalk | picocolors (smaller/faster) |
| Tables | cli-table3 | tty-table |
| Markdown | marked + marked-terminal | markdown-it |
| Syntax highlight | shiki | highlight.js |
| Testing | bun:test | vitest |
| Distribution | bun build --compile | Bunli |

## Relevance to linearctl

linearctl already uses:
- **commander** — arg parsing
- **@linear/sdk** — Linear API client
- **bun:test** — testing
- **bun build --compile** — single-binary distribution

If interactive prompts or TUI modes are added, the candidates are:
- **@inquirer/prompts** — interactive mode (select/confirm/input). Commander-native, 6.1M DL, 7.7k dependents, TS-first.
- **@clack/prompts** — alternative if gum-like polish is preferred. Vercel/Astro adopted.
- **ink** — full-screen TUI mode. Proven by Claude Code, Gemini CLI, Copilot CLI. But `@inkjs/ui` is stale — expect to build components from primitives.
- **OpenTUI** — high-performance TUI via Zig core. Newer, less ecosystem.
- **Glyph** — richest component library, but 40★ and early-stage. Full-screen only.

See [`README.md`](./README.md) for the multi-modal architecture discussion.
