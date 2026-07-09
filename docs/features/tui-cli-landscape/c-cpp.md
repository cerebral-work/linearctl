# C / C++ — TUI/CLI Library Reference

State of the art in C and C++ terminal libraries. These are the foundational
layers that many higher-level language frameworks build on (ncurses is the
grandparent of all TUI libraries).

**Status legend:** ✅ active · ⚠️ stale/infrequent · ❌ dead/archived.

---

## Terminal I/O backends (low-level)

These are the building blocks beneath the frameworks.

| Library | GH ★ | Status | Notes |
|---------|------|--------|-------|
| **ncurses** | — | ✅ eternal | The classic. C API, terminal-independent. Every TUI's grandparent. |
| **libtickit** | ~0.5k | ✅ maintained | Low-level terminal abstraction. Used by some Perl/Ruby TUI libs. |
| **readline** | — | ✅ maintained | GNU line editing, history, completion. The CLI input standard. |
| **libedit** | — | ✅ maintained | BSD readline alternative, used by macOS. |

## Full-screen TUI frameworks

| Framework | GH ★ | Status | Notes |
|-----------|------|--------|-------|
| **notcurses** | ~3k | ✅ active | "Definitely not curses." Vivid colors, multimedia, threads, Unicode. C with Rust/C++/Python bindings. |
| **FTXUI** | ~3.5k | ✅ active | C++ functional TUI, React-inspired. Cross-platform, mouse, animations. |
| **FINAL CUT** | ~1k | ✅ maintained | C++ widget toolkit, Qt-inspired. No external deps, full mouse, Unicode. |
| **cpp-terminal** | ~0.5k | ✅ maintained | Header-only C++ terminal I/O. |
| **TUIKit** | — | ⚠️ new | Qt-style C++ atop FTXUI. Labels, buttons, fields, layout containers. |

### notcurses

notcurses is the standout modern C library:

- C core with Rust (`notcurses-rs`), C++, and Python bindings
- Full multimedia support (images, video) via FFmpeg
- Thread-safe, high-performance cell-diffing
- Powers some Rust and Python TUI projects via FFI
- Author: nick black, very active development

### FTXUI

The C++ community's preferred modern TUI:

- Functional/declarative style (React-inspired)
- `ftxui::Component` with properties and children
- Cross-platform (Windows, macOS, Linux)
- Mouse support, animations
- Used in embedded systems and educational projects

## Argument parsing

C/C++ doesn't have a single dominant arg parser the way Rust/Go/Python do.

| Library | Language | Notes |
|---------|----------|-------|
| **argparse** (C) | C | Lightweight header-only parser. |
| **CLI11** | C++ | Single-header, feature-rich. Most popular C++ CLI parser. |
| **gflags** | C++ | Google. Used in internal Google tooling. |
| **cxxopts** | C++ | Lightweight header-only. |
| **boost::program_options** | C++ | Boost ecosystem. Heavyweight. |

## Styling

C/C++ TUI libraries generally handle their own styling via direct ANSI escape
codes or through the framework's built-in color system (notcurses has a rich
color API, FTXUI has `ftxui::Color`).

No standalone "chalk equivalent" library is widely used — color is usually
part of the TUI framework.

## Tables

| Library | Notes |
|---------|-------|
| **notcurses** | Built-in table rendering via `ncplane` APIs. |
| **FTXUI** | Table component with borders, separators. |

## Testing

| Library | Notes |
|---------|-------|
| **Google Test** | The C++ testing standard. |
| **Catch2** | Header-only, modern alternative to GTest. |
| **doctest** | Fastest, header-only. |

## Binary distribution

C/C++ binaries are compiled natively — distribution is via package managers
(apt, brew, pacman, AUR), static linking, or custom installers. No
equivalent to cargo-dist or GoReleaser exists for C/C++ specifically.

| Tool | Notes |
|------|-------|
| **CMake** | The standard build system. |
| **vcpkg** | Microsoft package manager. |
| **Conan** | C++ package manager. |
| **Meson** | Alternative build system. |

---

## C/C++ "winners" summary

| Category | Recommended | Runner-up |
|----------|-------------|-----------|
| Terminal I/O | ncurses | libtickit |
| TUI framework | notcurses | FTXUI (C++) |
| Arg parsing | CLI11 (C++) | cxxopts |
| Testing | Google Test | Catch2 |
| Build system | CMake | Meson |

## Relevance

C/C++ TUI libraries are primarily relevant as:

1. **Foundational layers** — ncurses is what most other languages' terminal
   backends ultimately talk to.
2. **High-performance TUI** — notcurses offers multimedia and threading that
   higher-level frameworks can't match.
3. **Embedded/systems** — FTXUI and FINAL CUT target environments where a
   Rust/Go/Python runtime is too heavy.

For a TS/JS project like linearctl, these are reference points, not
candidates.
