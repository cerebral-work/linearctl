# Other Languages — TUI/CLI Library Reference

State of the art in Haskell, OCaml, Ruby, Zig, Nim, Elixir, and Crystal
terminal libraries. These are smaller ecosystems but contain notable
contributions worth knowing about.

**Status legend:** ✅ active · ⚠️ stale/infrequent · ❌ dead/archived.

---

## Haskell

Haskell has a small but mature TUI ecosystem with excellent documentation.

### Argument parsing

| Library | Status | Notes |
|---------|--------|-------|
| **optparse-applicative** | ✅ standard | The Haskell CLI parser. Applicative, type-safe, heavily used. |

### Interactive prompts

| Library | Status | Notes |
|---------|--------|-------|
| **ansi-terminal** | ✅ standard | Low-level ANSI escape codes for color/cursor. |

### Full-screen TUI

| Framework | Status | Notes |
|-----------|--------|-------|
| **brick** | ✅ mature | Declarative, pure-function TUI. Excellent documentation. vty-crossplatform (Unix + Windows). Powers Haskell CLI tools like `git-brunch`, `hledger`. |

### Testing

| Library | Status | Notes |
|---------|--------|-------|
| **Hspec** | ✅ standard | BDD-style testing framework. |
| **tasty** | ✅ maintained | Flexible testing framework. |

### brick

brick is the standout Haskell TUI — a declarative, pure-function approach
where the UI is a function of state. Similar to Elm architecture. Very well
documented with a long tutorial. Built on `vty` (terminal I/O).

---

## OCaml

OCaml has a niche but functional TUI ecosystem, largely from the research
community.

### Argument parsing

| Library | Status | Notes |
|---------|--------|-------|
| **cmdliner** | ✅ standard | Declarative CLI parsing for OCaml. Used by Dune ecosystem tools. |

### Full-screen TUI

| Framework | Status | Notes |
|-----------|--------|-------|
| **nottui** | ⚠️ mature | Notty + Lwd. Reactive, declarative. Undocumented but works. |
| **minttea** | ⚠️ new | Bubble Tea-inspired, Elm architecture, built on Riot. |

### Terminal I/O

| Library | Status | Notes |
|---------|--------|-------|
| **notty** | ⚠️ minimal | Declarative terminal images. Paired with nottui for UIs. |

---

## Ruby

Ruby has a mature, well-organized TUI ecosystem through the **TTY toolkit** —
a collection of 19+ gems by Piotr Murach.

### Argument parsing

| Library | GH ★ | Status | Notes |
|---------|------|--------|-------|
| **thor** | ~5k | ✅ maintained | Rails-adjacent, maps classes to subcommands. Powers Bundler, Rake tasks. |
| **gli** | ~1k | ✅ maintained | GLI — Git-like interface. |
| **slop** | ~0.7k | ⚠️ minimal | Simple option parsing. |

### Interactive prompts

| Library | Status | Notes |
|---------|--------|-------|
| **tty-prompt** | ✅ mature | Part of TTY toolkit. Select, multi-select, confirm, ask, slider, filter. |

### Full-screen TUI / toolkit

| Library | Status | Notes |
|---------|--------|-------|
| **tty** (toolkit) | ✅ mature | 19 plugins: prompt, table, progress, spinner, screen, box, file, editor, color, cursor, pie, grid, spinner. Unix + Windows. |
| **tty-spinner** | ✅ mature | Spinner component. |
| **tty-progressbar** | ✅ mature | Progress bars. |
| **tty-table** | ✅ mature | Tables. |
| **tty-box** | ✅ mature | Boxes. |
| **pastel** | ✅ mature | ANSI colors and styling. |

### Testing

| Library | Status | Notes |
|---------|--------|-------|
| **RSpec** | ✅ standard | BDD testing framework. |
| **aruba** | ✅ maintained | CLI testing with Cucumber. |

### The TTY toolkit

```
tty (meta-gem)
  ├── tty-prompt       (prompts)
  ├── tty-spinner      (spinners)
  ├── tty-progressbar  (progress)
  ├── tty-table        (tables)
  ├── tty-box          (boxes)
  ├── tty-screen       (screen size)
  ├── tty-cursor       (cursor control)
  ├── tty-color        (color detection)
  ├── tty-file         (file operations)
  ├── tty-editor       (open $EDITOR)
  ├── tty-pie          (pie charts)
  ├── tty-grid         (grid layout)
  ├── tty-which        (find executables)
  ├── tty-logger       (logging)
  └── ... 6 more
```

The TTY toolkit is Ruby's answer to Charm (Go) and Rich/Textual (Python) — a
single author's coherent suite covering the full CLI/TUI surface.

---

## Zig

Zig is emerging as a systems language with TUI relevance primarily through
**OpenTUI** (whose native core is Zig, with TS bindings).

### Full-screen TUI

| Framework | Status | Notes |
|-----------|--------|-------|
| **OpenTUI** (native core) | ✅ active | The Zig core powers the TS-accessible OpenTUI. High-performance cell-diffing, used by OpenCode and terminal.shop. |
| **zfetch** | ⚠️ minimal | HTTP client, not TUI. |

Zig doesn't yet have a standalone Zig-only TUI framework with wide adoption.
The TUI story is: write Zig, bind to TS via OpenTUI.

---

## Nim

Nim has minimal but existing TUI options.

### Full-screen TUI

| Framework | Status | Notes |
|-----------|--------|-------|
| **illwill** | ⚠️ minimal | Low-level terminal I/O. |
| **(FTXUI bindings)** | ⚠️ experimental | C++ FFI to FTXUI. |

Nim's C++ FFI means C++ TUI frameworks (FTXUI, FINAL CUT) can be used directly
from Nim, though with no idiomatic Nim wrapper.

---

## Elixir

Elixir's TUI ecosystem is minimal. Most Elixir CLIs use Erlang's standard
libraries or shell out to external tools.

### Argument parsing

| Library | GH ★ | Status | Notes |
|---------|------|--------|-------|
| **Optimus** | ~0.3k | ⚠️ minimal | CLI parser inspired by clap. |
| **ex_cli** | ~0.2k | ⚠️ minimal | Another CLI parser. |

### Full-screen TUI

| Framework | Status | Notes |
|-----------|--------|-------|
| **(none widely adopted)** | — | Elixir lacks a mature TUI framework. Projects typically shell out or use NIFs to C libraries. |

---

## Crystal

Crystal is Ruby-syntax, compiled. Its TUI ecosystem is very small.

### Argument parsing

| Library | Status | Notes |
|---------|--------|-------|
| **Crystal stdlib `OptionParser`** | ✅ built-in | Standard library CLI parser. |

### Full-screen TUI

| Framework | Status | Notes |
|-----------|--------|-------|
| **(none widely adopted)** | — | Crystal lacks a mature TUI framework. |

---

## Cross-language observations

1. **Every language with a mature CLI ecosystem has a "winner" arg parser:**
   clap (Rust), cobra (Go), click (Python), commander (TS/JS), thor (Ruby),
   optparse-applicative (Haskell), cmdliner (OCaml). The pattern is clear —
   one library dominates, alternatives exist for niche preferences.

2. **Single-author coherent suites are a pattern:**
   - Charm (Go): bubbletea + bubbles + lipgloss + glamour + huh + gum + glow
   - Textual/Rich (Python): rich + textual + trogon + textual-dev
   - TTY toolkit (Ruby): 19+ gems by Piotr Murach
   - These suites offer integrated, consistent UX across categories.

3. **Elm architecture is cross-language:**
   Bubble Tea (Go), minttea (OCaml), and to some extent brick (Haskell) all
   use the Elm/TEA pattern (Model → Msg → update → view). It's proven for
   terminal UIs.

4. **Smaller languages (Elixir, Crystal) lack mature TUI.** The investment
   to build a full TUI framework is high; these communities haven't reached
   critical mass for one. They shell out or use C FFI.

5. **Zig is the emerging systems layer for TUI.** OpenTUI's Zig core shows
   that high-performance terminal rendering can be a shared foundation
   across language boundaries via FFI/bindings.
