# Go — TUI/CLI Library Reference

State of the art in Go terminal libraries. Adoption signals sourced from
GitHub and pkg.go.dev as of July 2026.

**Status legend:** ✅ active · ⚠️ stale/infrequent · ❌ dead/archived.

---

## Argument parsing

| Library | GH ★ | Dependents | Status | Notes |
|---------|------|-----------|--------|-------|
| **cobra** | 44k | 68.8k | ✅ v1.10+ | The standard. Powers Kubernetes, Hugo, Docker, etcd, rclone, Istio. Subcommands, completions, help generation. |
| **urfave/cli** | 2.8k | ~50k | ✅ active | Lighter than cobra. Flag-centric, composable. |
| **pflag** | 2.1k | — | ✅ maintained | POSIX-compatible flag parsing. Used by cobra. |
| **kong** | 2.0k | — | ✅ active | Struct-tag-driven, declarative. Unique approach. |

## Interactive prompts

| Library | GH ★ | Status | Notes |
|---------|------|--------|-------|
| **huh** | ~4k | ✅ v2.0.0 (Mar 2026) | Charmbracelet. Forms (groups → fields), Input/Text/Select/MultiSelect/Confirm, themes, **accessible mode** (screen reader). Built on Bubble Tea v2. |
| **survey** | ~4k | ⚠️ legacy (pre-huh) | The original Go prompt library. Superseded by huh. |
| **go-prompt** | ~1k | ⚠️ minimal | Line-editor prompt with completion. |

## Full-screen TUI frameworks

| Framework | GH ★ | Status | Notes |
|-----------|------|--------|-------|
| **bubbletea** | 38.3k | ✅ v2 (2026) | The standard. Elm architecture, Cursed Renderer (ncurses-based). Powers glow, gum, soft-serve. |
| **bubbles** | — | ✅ active | Component library for bubbletea (list, table, viewport, spinner, text input, filter). Used in production by glow. |
| **tview** | ~1.5k | ✅ maintained | High-level widget library (forms, tables, trees, modal). Built on tcell. Less opinionated than bubbletea. |
| **termui** | ~1.5k | ⚠️ legacy | Dashboard widgets (charts, gauges, sparklines). Pre-bubbletea. |
| **gocui** | ~9k | ❌ archived | Low-level, termbox-like. Original Go TUI. |
| **tcell** | ~4.5k | ✅ maintained | Low-level terminal I/O (termbox successor). Used by tview. |

## Spinners & progress

| Library | Status | Notes |
|---------|--------|-------|
| **bubbles/spinner** | ✅ active | Bubbletea component. |
| **mpb** | ✅ maintained | Multi-progress-bar library, independent of bubbletea. |

## Styling

| Library | GH ★ | Notes |
|---------|------|-------|
| **lipgloss** | 11.4k | The standard. Style definitions, layout, borders, padding, color downsampling. Charm ecosystem. |
| **go-isatty** | — | TTY detection. |
| **go-colorable** | — | Windows color support. |
| **aurora** | ~1.2k | ANSI color chain. |
| **gookit/color** | ~1.5k | Rich color, gradient, theme. |

## Tables

| Library | Notes |
|---------|-------|
| **lipgloss/table** | (in lipgloss) Styled tables, borders, padding. |
| **bubbles/table** | Interactive table component for bubbletea. |
| **go-pretty/v6/table** | Rich tables with colors, footers. |

## Markdown rendering

| Library | GH ★ | Notes |
|---------|------|-------|
| **glow** (binary) | 24.5k | Charmbracelet. CLI markdown reader + TUI. v2.1.2 (Apr 2026). |
| **glamour** | — | Powers glow. Markdown → styled ANSI. Syntax highlighting. |

## Syntax highlighting

| Library | Notes |
|---------|-------|
| **chroma** | Lexer library. Used by glamour. 600+ lexers. |

## Testing

| Library | Notes |
|---------|-------|
| **tea-test** | Bubbletea testing utilities. |
| **bubbletea-test** | Event injection, model assertion. |

## Binary distribution

| Tool | Notes |
|------|-------|
| **GoReleaser** | v2.17 (2026). Now supports Rust + Zig (alpha). The standard for Go. |
| **release-please** | Google. Conventional Commits → Release PR → tag. GitHub-only. |

## Notifications & system integration

| Library | Notes |
|---------|-------|
| **readline** | Line editing, history. |
| **ishell** | Interactive shell framework. |

---

## Go "winners" summary

| Category | Recommended | Runner-up |
|----------|-------------|-----------|
| Arg parsing | cobra | urfave/cli (lighter) |
| Prompts | huh | survey (legacy) |
| TUI framework | bubbletea | tview (widget-based) |
| Spinner/progress | bubbles/spinner | mpb (multi-bar) |
| Styling | lipgloss | gookit/color |
| Tables | lipgloss/table | go-pretty/table |
| Markdown | glamour | glow (binary) |
| Syntax highlight | chroma | — |
| Testing | tea-test | bubbletea-test |
| Distribution | GoReleaser | release-please |

## The Charm ecosystem

Most of the recommended Go libraries come from **Charmbracelet**, a cohesive
suite designed to work together:

```
bubbletea (framework) → bubbles (components) → lipgloss (styling)
                                             → glamour (markdown)
                                             → huh (prompts)
                                             → gum (shell-script prompts)
                                             → glow (markdown reader)
                                             → soft-serve (git server)
```

This is Go's answer to "I want one vendor's coherent TUI stack." No other
language has an equivalent single-vendor ecosystem of this breadth.
