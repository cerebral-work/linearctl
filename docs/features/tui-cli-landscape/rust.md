# Rust — TUI/CLI Library Reference

State of the art in Rust terminal libraries. Each entry includes adoption
signals (GitHub stars, crates.io downloads), maintenance status, notable
adopters, and a one-line characterization.

**Status legend:** ✅ active (publish ~3mo) · ⚠️ stale/infrequent (>12mo or
minimal) · ❌ dead/archived.

---

## Argument parsing

| Crate | GH ★ | Downloads | Status | Notes |
|-------|------|-----------|--------|-------|
| **clap** | 16.5k | 949M all-time | ✅ v4.6.1 | The standard. Derive macros, subcommands, env vars, 240k+ repos. |
| **argh** | 1.5k | ~20M | ⚠️ infrequent | Google's lightweight derive parser. Simpler than clap, fewer features. |
| **lexopt** | 0.8k | ~5M | ✅ maintained | Zero-dep, hand-rolled, maximal control. For minimalists. |

## Interactive prompts

| Crate | Downloads | Status | Notes |
|-------|-----------|--------|-------|
| **dialoguer** | 66.2M | ✅ active | Most downloaded. Fuzzy select, confirm, input, password. Armin Ronacher. |
| **inquire** | 11.7M | ✅ active | Most feature-rich: Text, Select, MultiSelect, Confirm, Password, Editor, DateSelect, CustomType, autocomplete, validators. crossterm/termion/console backends. |
| **cliclack** | 2.6M | ✅ active (v0.5.2) | "Clack for Rust." gum-like aesthetic, themes, spinner, progress, multiselect with filtering. |
| **requestty** | 384k | ⚠️ infrequent | Inquirer.js-inspired, feature-rich. |
| **promptly** | 1.3k | ⚠️ minimal | Simple text + parse-to-type. |
| **asky** | 2.6k | ⚠️ minimal | Good-looking prompts, newer. |

## Full-screen TUI frameworks

| Framework | GH ★ | Crates using | Status | Notes |
|-----------|------|-------------|--------|-------|
| **ratatui** | 20k+ | 2,100+ | ✅ very active | The standard. Forked from tui-rs 2023. Immediate-mode rendering, multi-backend. Netflix, OpenAI, AWS, Vercel. Sub-ms rendering. |
| **tui-realm** | ~0.5k | — | ✅ maintained | Framework atop ratatui. Elm/React-inspired components with properties + states, message system. |
| **tuie** | ~0.1k | — | ⚠️ early | Image support (Kitty/sixel/SSH/tmux), per-widget dirty tracking. |
| **cursive** | ~2.2k | — | ⚠️ infrequent | Higher-level, view-based. Predates ratatui's dominance. |

### Terminal I/O backends (shared across frameworks)

| Backend | Platform | Notes |
|---------|----------|-------|
| **crossterm** | Win/Mac/Linux | Default for ratatui. Cross-platform, raw mode, mouse, event polling. |
| **termion** | Unix-only | Lighter, no Windows. |
| **termwiz** | All | Wezterm's backend, niche. |

## Spinners & progress

| Crate | Downloads | Status | Notes |
|-------|-----------|--------|-------|
| **indicatif** | ~40M | ✅ active | The standard. ProgressBar, MultiProgress, spinners, ETA, templates. |
| **kdam** | ~2M | ✅ active | tqdm port, 4x faster. Spinners, gradient colors, charset fill. |
| **ratatui** (Gauge widget) | (in ratatui) | ✅ | For full-TUI progress. |

## Styling

| Crate | Notes |
|-------|-------|
| **owo-colors** | Recommended. `std::io::IsTerminal` support, truecolor. |
| **colored** | Natural chaining: `"text".red().bold()`. Truecolor. |
| **termcolor** | BurntSushi. Cross-platform. ⚠️ targets deprecated Windows Console APIs. |
| **ansi_term** | ⚠️ deprecated → use owo-colors or colored. |
| **yansi** | Zero-dep, lightweight. |

## Tables

| Crate | Notes |
|-------|-------|
| **tabled** | Pretty-print structs/enums as tables. ANSI support via feature flag. |
| **comfy-table** | Auto content wrapping. ⚠️ seeking new maintainer, feature freeze. |
| **term-grid** | Grid layout, minimize space. ogham. |
| **cli-table** | Low compile time, optional CSV. |

## Markdown rendering

| Library | GH ★ | Notes |
|---------|------|-------|
| **termimad** | ~1k | Canop. Markdown in CLI/TUI. Skins, wrapping, table balancing, scrolling. |
| **bat** (binary) | ~50k | Syntax-highlighted cat. Not markdown-specific but the standard for code rendering. |

## Syntax highlighting

| Library | Notes |
|---------|-------|
| **syntect** | The standard. Sublime syntax defs, regex-based. bat uses this. |
| **tree-sitter** | Parser-based highlighting. Used by Helix, Neovim, Zed. Not a color library — a parsing engine. |

## Testing

| Crate | Notes |
|-------|-------|
| **insta** | Snapshot testing. `cargo insta review` → TUI diff. The standard for CLI/TUI output. |
| **trycmd** | Herd-of-CLI-tests snapshot testing. mdBook integration. |
| **snapbox** | Snapshot toolbox for CLI output. |
| **assert_cmd** | Process-execution assertions for CLI binaries. |
| **assert_fs** | Filesystem assertions, pairs with assert_cmd. |
| **ratatui-testlib** | PTY-based integration testing for ratatui. Sixel tracking, Bevy ECS, insta snapshots. |
| **tui-testing-mcp** | MCP server for driving interactive terminal programs over PTY. |

## Binary distribution

| Tool | Notes |
|------|-------|
| **cargo-dist** | Plan → build → host → publish → announce. Generates CI scripts. v0.32.0 (May 2026). cargo-auditable + zigbuild support. |
| **GoReleaser** | v2.17 (2026). Now supports Rust (alpha). cargo-zigbuild default. |
| **release-plz** | release-please alternative. Compares local vs published crates. Rust-optimized. |
| **cargo-auditable** | Embeds dependency info in binary for `cargo audit` supply-chain checks. |

## Notifications & system integration

| Crate | Notes |
|-------|-------|
| **notify-rust** | OS notifications. |
| **clipboard-rs** | System clipboard. |
| **arboard** | Cross-platform clipboard. |

## ASCII art & branding

| Crate | Notes |
|-------|-------|
| **figlet** | Rust port of figlet. ~2M downloads. |
| **termint** | ASCII art and layout. |

---

## Rust "winners" summary

| Category | Recommended | Runner-up |
|----------|-------------|-----------|
| Arg parsing | clap | argh (lighter) |
| Prompts | inquire | dialoguer (more downloads) |
| TUI framework | ratatui | tui-realm (component framework) |
| Spinner/progress | indicatif | kdam (tqdm port) |
| Styling | owo-colors | colored |
| Tables | tabled | comfy-table |
| Markdown | termimad | bat (code rendering) |
| Syntax highlight | syntect | tree-sitter (parser-based) |
| Testing | insta + assert_cmd | trycmd / snapbox |
| Distribution | cargo-dist | release-plz |
