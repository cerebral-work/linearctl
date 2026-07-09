# Feature: `linearctl` interactive mode — prompts, spinners, and styled output

**Status:** proposed
**Command:** `linearctl <cmd> --interactive` (or auto-detected when stdout is a TTY and no `--json`)
**Roadmap:** net-new (not in §7)
**Milestone:** M3 (after the write commands stabilize)

## Motivation

`linearctl` is headless-first: `--json` everywhere, pipe-friendly, safe-by-
default. This is the right default for scripts, cron, and CI. But the
same operator who runs `linearctl file "Fix the thing" --team CER --json`
in a hook also runs it **at the terminal** — and at the terminal, the
experience is bare:

- `linearctl file` with no `--desc` creates an issue with just the title.
  At the terminal, you'd want a prompt: "Description? (optional)".
- `linearctl triage` dumps a table. At the terminal with 40 issues, you'd
  want to **filter interactively** ("show only unassigned") rather than
  re-run with flags.
- `linearctl update CER-142` with no mutation flags prints "nothing to do."
  At the terminal, you'd want: "Update what? (state/assignee/label/priority)"
  → "State? (Todo/In Progress/In Review)" → confirm.
- Long operations (`xref --fix --apply` across 50 PRs) show nothing until
  done. At the terminal, you'd want a spinner + progress.

The pattern: **when stdout is a TTY and no `--json` is passed, the CLI can
offer interactive prompts and live feedback** — the middle mode between
headless (`--json`, pipes) and full-screen TUI (`linearctl tui`).

## Proposal

Add an **interactive layer** that activates when:
1. `stdout` is a TTY (`process.stdout.isTTY === true`), AND
2. No `--json` flag is passed, AND
3. The command is invoked without all required arguments (i.e., the user
   would get a "missing argument" error in headless mode).

When interactive mode activates, the CLI uses prompt libraries to ask
for the missing input, shows spinners during async operations, and renders
styled output (colored tables, borders, status symbols). When any of the
three conditions are false, the CLI behaves exactly as it does today —
no prompts, no spinners, plain output.

```
# headless (today, unchanged)
linearctl file "Fix webhook retry" --team CER --json
  → { identifier: "CER-142", url: "https://..." }

# interactive (proposed)
linearctl file
  ? Title: Fix webhook retry_
  ? Team: (use arrow keys)
    ❯ CER — Cerebral Work Institute
      BRAND — Brand
      TOD — Today
  ? Description (optional): [stdin: type or Ctrl-D to finish]
  ⠹ Creating issue... ✓ Created CER-142
  → https://linear.app/...
```

### Three layers of interactivity

| Layer | When | What |
|-------|------|------|
| **Prompting** | TTY + no `--json` + missing args | `@inquirer/prompts` to fill missing args interactively |
| **Progress** | TTY + no `--json` + long operation | `ora` spinner / `listr2` multi-task during API calls |
| **Styling** | TTY + no `--json` (always, when interactive) | `chalk` colors, `boxen` borders, `log-symbols` status marks |

All three are **additive** — they only activate when the three conditions
are met. In headless mode (pipe, `--json`, CI), none of them fire.

### Per-command interactive behavior

| Command | Interactive trigger | What prompts |
|---------|---------------------|-------------|
| `file` | Missing `--title` or `--team` | Title (text input), Team (select), Description (multiline editor), Labels (multi-select from team labels) |
| `park` | Missing `--title` or `--team` | Title, Team, Persona (text), Acceptance criteria (multiline) |
| `update` | No mutation flags | "What to update?" (select: state/assignee/label/priority), then per-field prompts, then confirm |
| `close` | Missing `<id>` | Issue search/select (fuzzy find by identifier or title), then confirm close |
| `triage` | TTY + no flags | "Filter by reason?" (multi-select: unassigned/unestimated/no-priority/triage-state), live-filtered table |
| `stale` | TTY + no flags | "Older than? (30d/60d/90d/custom)" → re-renders table |
| `xref` | TTY + `--fix` | Confirm each planned remediation individually or in batch |
| `show` | Missing `<id>` | Fuzzy issue search/select |

### Architecture

```
src/
  lib/
    interactive.ts    # isInteractive(): TTY + no --json + missing args
    prompts.ts        # @inquirer/prompts wrappers (teamSelect, labelMultiSelect, etc.)
    spinner.ts        # ora wrapper: withSpinner("Creating issue...", async fn)
    style.ts         # chalk + boxen + log-symbols helpers
  commands/
    file.ts           # if isInteractive() && !title → promptTitle()
    update.ts         # if isInteractive() && no mutation flags → promptUpdate()
    ...
```

The interactive layer sits **between commander and `core/*`** — it fills
in the arguments that commander couldn't parse, then hands the complete
argument set to the same `core/*` function the headless path uses:

```typescript
// src/commands/file.ts (conceptual)
program.command("file")
  .argument("[title]")
  .option("--team <key>")
  .action(async (title, opts) => {
    if (interactive.isInteractive()) {
      if (!title) title = await prompts.text("Title");
      if (!opts.team) opts.team = await prompts.teamSelect(client);
      if (!opts.desc) opts.desc = await prompts.multiline("Description (optional)");
    }
    // headless validation still runs — prompts don't bypass required-arg checks
    if (!title || !opts.team) exit.missingArgs();
    const result = await spinner.withSpinner("Creating issue...", () =>
      core.issues.create(client, { title, team: opts.team, ... }));
    output.result(result);
  });
```

No new `core/*` functions. No new API calls. The interactive layer is
purely **argument gathering + feedback rendering** — the same `core/*`
path runs either way.

## Library candidates

From the [`tui-cli-landscape/typescript-javascript.md`](./tui-cli-landscape/typescript-javascript.md)
research:

### Prompts

| Library | GH ★ | Weekly DL | Status | Fit |
|---------|------|-----------|--------|-----|
| **@inquirer/prompts** | 21.5k | 6.1M | ✅ v8.5.2 | Commander-native (same author ecosystem). Per-prompt imports, 7.7k dependents, TS-first. Fuzzy search, multi-select, editor, password. |
| **@clack/prompts** | 8.6k | 7.3M | ✅ v1.7.0 | Gum-like polish. Vercel/Astro adopted. Lighter, fewer prompt types. |

**Lean: `@inquirer/prompts`.** The per-prompt import model (import only
`select`, not the whole library) keeps the bun-compiled binary lean. The
7,712 dependents and TS-first API make it the safe choice. `@clack/prompts`
is the aesthetic alternative if the operator prefers the gum look — either
works behind the same `src/lib/prompts.ts` abstraction.

### Spinners

| Library | Weekly DL | Status | Fit |
|---------|-----------|--------|-----|
| **ora** | 57M | ✅ v9.4.1 | The standard. `ora.promise()`, 80+ spinner styles. 57M weekly DL. |
| **listr2** | 28.7M | ✅ v10.2.2 | Multi-task lists with per-task spinners. For `xref --fix` across many PRs. |
| **nanospinner** | ~5M | ✅ active | Minimal alternative. |

**Lean: `ora` + `listr2`.** `ora` for single operations (file, update,
close). `listr2` for multi-step operations (xref --fix remediation, batch
file). Both are the ecosystem standard — 85M combined weekly DL.

### Styling

| Library | Weekly DL | Status | Fit |
|---------|-----------|--------|-----|
| **chalk** | ~120M | ✅ active | The standard. Template literals, chainable. |
| **picocolors** | ~80M | ✅ active | 14x smaller, 2x faster. |
| **boxen** | ~30M | ✅ active | Bordered boxes — for issue detail cards. |
| **log-symbols** | ~30M | ✅ active | Status marks (✓ ✖ ! ℹ). |
| **cli-table3** | ~25M | ✅ active | Pretty tables — upgrade from current ASCII tables. |

**Lean: `picocolors` + `boxen` + `log-symbols` + `cli-table3`.**
`picocolors` over `chalk` for bundle size (linearctl is a compiled binary
— every KB matters). `boxen` for issue detail cards. `log-symbols` for
status marks. `cli-table3` to upgrade the current ASCII table rendering
to bordered, color-aware tables — the table is the primary interactive
output surface.

### Bundle impact

linearctl is a `bun build --compile` single binary (~60–92MB). The interactive
libraries are tiny:

| Library | Bundle size (minified) |
|---------|----------------------|
| `@inquirer/prompts` | ~50KB (tree-shaken to used prompts) |
| `ora` | ~5KB |
| `listr2` | ~20KB |
| `picocolors` | ~4KB |
| `boxen` | ~10KB |
| `log-symbols` | ~2KB |
| `cli-table3` | ~15KB |

Total: ~106KB added to a ~60MB binary. Negligible.

## API surface

No new Linear API calls. No new `core/*` functions. The interactive layer
wraps existing calls:

| Core function | Interactive wrapper |
|---------------|-------------------|
| `core/issues.create()` | `spinner.withSpinner("Creating issue...", create)` |
| `core/issues.update()` | `prompts.updateWizard()` → `spinner.withSpinner("Updating...", update)` |
| `core/grooming.getTriageQueue()` | `prompts.reasonFilter()` → re-query → styled table |
| `core/xref.reconcile()` + `--fix` | `listr2` multi-task with per-PR confirm |

## Relationship to other proposals

- **[`tui.md`](./tui.md)** — the full-screen dashboard. Interactive mode is
  the middle layer; TUI is the outer layer. Both share `core/*`. The
  interactive layer is a prerequisite for the TUI in practice (the prompt
  and styling libraries are shared infrastructure), but they are
  architecturally independent — the TUI could ship without interactive mode
  if the operator only wants full-screen.
- **[`search.md`](./search.md)** — the search command. Interactive mode's
  fuzzy-select prompt would be used by `linearctl search` when no query is
  given: type to filter, enter to select an issue, then show it.
- **[`dupcheck.md`](./dupcheck.md)** — duplicate detection. Interactive mode
  would show `dupcheck` matches as a confirm-or-cancel prompt before filing:
  "3 similar issues found. Continue? (Y/n/show)".

## Non-goals

- **Not a replacement for headless mode.** The headless path (`--json`,
  pipes, no prompts) is the default and the primary mode. Interactive mode
  is a convenience layer for the human at the terminal, not a new product.
- **Not a full TUI.** No full-screen rendering, no pane switching, no
  keyboard navigation beyond the prompt's built-in arrow keys. For
  full-screen, use [`linearctl tui`](./tui.md).
- **No breaking changes to existing commands.** A command that works
  headless today works identically headless tomorrow. Interactive mode
  only adds behavior when the three conditions (TTY + no `--json` +
  missing args) are met.
- **No stored state.** Interactive mode doesn't save preferences, remember
  last-used team, or persist anything. Each invocation is stateless. If
  the operator wants a default team, that's a `LINEAR_DEFAULT_TEAM` env var
  (future), not interactive-mode state.

## Alternatives considered

- **Make `--json` opt-out instead of opt-in.** Rejected — inverts the safe
  default. `--json` being opt-in means a script that forgets `--json` gets
  human output (annoying but safe); opt-out means a script that forgets
  `--no-json` gets prompts (broken, hangs in CI).
- **Add a `--interactive` flag.** Considered, but unnecessary — TTY
  detection + `--json` absence is the correct trigger. An explicit flag
  would mean two ways to say the same thing. The current trigger is
  precise: TTY + no `--json` + missing args.
- **Use the TUI framework (Ink) for interactive prompts.** Overkill — Ink
  is a full-screen React renderer. `@inquirer/prompts` is purpose-built
  for inline prompts that don't take over the screen. Different tool,
  different mode.

## Verification

- `linearctl file --team CER --json` → unchanged headless behavior (JSON
  output, no prompts, no spinner).
- `linearctl file` in a real terminal → prompts for title, team,
  description; shows spinner during creation; prints styled result.
- `echo "" | linearctl file` → no prompts (stdin is not a TTY), errors
  "title required" (same as today).
- `linearctl triage` in a terminal → styled table with colored reason
  flags; `/` opens inline filter; `q` exits filter.
- `linearctl update CER-142` in a terminal → "What to update?" wizard;
  selecting state shows a select prompt; confirm step; spinner during
  update; success symbol.
- `linearctl xref --fix --apply` in a terminal → listr2 multi-task with
  per-PR confirm; spinner per remediation; summary at end.
- `bun run typecheck` clean, `bun test` green, `bun build --compile` still
  produces a single binary (interactive libs add ~106KB).
- CI runs with no TTY → no interactive behavior, no hung prompts.
