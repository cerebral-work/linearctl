# Python — TUI/CLI Library Reference

State of the art in Python terminal libraries. Adoption signals sourced from
GitHub and PyPI as of July 2026.

**Status legend:** ✅ active · ⚠️ stale/infrequent · ❌ dead/archived.

---

## Argument parsing

| Library | GH ★ | Downloads | Status | Notes |
|---------|------|-----------|--------|-------|
| **click** | 17.6k | 929M/mo | ✅ v8.3.1 | The standard. Decorator-based, composable, plugin system. 38.7% of Python CLI projects. |
| **typer** | 8.0k | ~300M/mo | ✅ active | Built on click, adds type hints → CLIs with almost no boilerplate. Auto-completion, Pydantic integration. |
| **argparse** | stdlib | — | ✅ built-in | Python standard library. No dep, verbose API. |
| **fire** | 1.8k | ~50M/mo | ⚠️ minimal | Google's "automatically generate CLIs from objects/functions." |
| **cappa** | 0.3k | — | ⚠️ new | Type-safe, declarative, built on dataclasses. |

## Interactive prompts

| Library | GH ★ | Status | Notes |
|---------|------|--------|-------|
| **questionary** | ~1.5k | ✅ maintained | Recommended Inquirer.js port. prompt_toolkit 3.0+. |
| **InquirerPy** | ~1k | ✅ maintained | More customization than questionary, fuzzy prompt, key bindings. |
| **PyInquirer** | ~1.5k | ⚠️ unmaintained | Legacy, use questionary or InquirerPy instead. |
| **prompt_toolkit** | 11k | ✅ active | The engine behind IPython, pgcli. Low-level, powerful. |
| **rich.prompt** | (in rich) | ✅ active | Simple prompts within rich's ecosystem. |

## Full-screen TUI frameworks

| Framework | GH ★ | Status | Notes |
|-----------|------|--------|-------|
| **textual** | ~28k | ✅ very active | Web-inspired TUI framework. CSS-like styling, 16.7M colors, mouse, animations, async. Companion to rich. App → Screen → Widget. |
| **rich** | 57k | ✅ very active | Not a TUI per se, but the rendering engine: tables, progress, markdown, syntax highlight, tracebacks, trees. Powers textual. |
| **urwid** | 3k | ✅ maintained | Veteran console UI library. Widget-based, mature, partially Windows. |
| **prompt_toolkit** | 11k | ✅ active | Low-level prompt/input engine. Powers IPython, pgcli. Not full-screen TUI but the building block. |
| **trogon** | 2.6k | ✅ active | Auto-generates a TUI from a Click CLI. Discoverability for CLI args. |
| **pytermgui** | ~0.5k | ⚠️ minimal | Modular widget system, mouse support, markup language. |
| **curtsies** | ~0.5k | ⚠️ minimal | Lightweight, curses-like. |

## Spinners & progress

| Library | GH ★ | Status | Notes |
|---------|------|--------|-------|
| **tqdm** | ~28k | ✅ active | The standard. 1B+ downloads. Smart ETA, platform-agnostic, Jupyter. |
| **rich.progress** | (in rich) | ✅ active | Styled, multi-bar, dynamic descriptions. |
| **alive-progress** | ~4k | ✅ active | Animated spinners, smart ETA. |
| **click-progressbar** | ~0.5k | ⚠️ minimal | Click integration. |

## Styling

| Library | Notes |
|---------|-------|
| **rich** | Colors + formatting + everything (tables, markdown, panels). |
| **colorama** | Cross-platform ANSI (Windows support). |
| **termcolor** | Google's simple ANSI colors. |
| **colored** | Simple chain syntax. |
| **ansicolors** | Truecolor. |

## Tables

| Library | GH ★ | Notes |
|---------|------|-------|
| **rich** (Table) | 57k | The best Python table rendering. |
| **tabulate** | ~2k | Pretty-print, multi-format (HTML, LaTeX, Markdown). |
| **prettytable** | ~1k | ASCII tables. |
| **texttable** | ~0.5k | Configurable column alignment. |

## Markdown rendering

| Library | Notes |
|---------|-------|
| **rich.markdown** | Rich's markdown renderer. The standard. |

## Syntax highlighting

| Library | Notes |
|---------|-------|
| **pygments** | The classic. 600+ lexers. Used by rich, Sphinx, Jupyter. |

## Testing

| Library | Notes |
|---------|-------|
| **pytest** | The standard test runner. |
| **pexpect** | PTY-based interaction testing for CLI/TUI. |
| **textual-dev** | Snapshot testing for textual apps. |

## Binary distribution

Python CLIs are typically distributed via pip/uv, not compiled to binaries.
For standalone executables:

| Tool | Notes |
|------|-------|
| **uv** | Astral. Ultra-fast package manager + `uv build` for wheels. |
| **PyInstaller** | Freeze Python → standalone executable. |
| **Nuitka** | Compile Python → C → binary. |
| **shiv** | Zipapp-based self-contained executables. |
| **pex** | Pants. Python executable format. |

---

## Python "winners" summary

| Category | Recommended | Runner-up |
|----------|-------------|-----------|
| Arg parsing | click | typer (type-hint sugar) |
| Prompts | questionary | InquirerPy (more customization) |
| TUI framework | textual | urwid (veteran) |
| Spinner/progress | tqdm | rich.progress |
| Styling | rich | colorama (Windows) |
| Tables | rich.Table | tabulate |
| Markdown | rich.markdown | — |
| Syntax highlight | pygments | — |
| Testing | pytest + pexpect | textual-dev (textual apps) |
| Distribution | uv (wheels) | PyInstaller (binary) |

## The Textual ecosystem

Python's dominant TUI stack is **Textual + Rich**, both from the same author
(Will McGugan):

```
rich (rendering engine)
  → textual (TUI framework, uses rich for rendering)
    → textual-dev (testing + dev tools)
    → trogon (auto-TUI from Click CLIs)
```

Rich is the rendering layer (colors, tables, markdown, progress, syntax
highlighting). Textual builds full-screen apps on top. The synergy is tight:
textual apps get rich's rendering for free.
