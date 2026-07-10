# Feature: `linearctl template` — file issues from reusable templates

**Status:** ticketed — [CER-1562](https://linear.app/cerebral-work/issue/CER-1562)
**Command:** `linearctl template list|file|validate [--team CER] [--json]`
**Roadmap:** net-new (not in §7)
**Milestone:** M3

## Motivation

The recurring pattern: the same issue shape gets filed over and over with
only the specifics changing. Examples already visible in this workspace:

- **User stories** — "As a X, I want Y, so that Z" + acceptance criteria
  (see [park](./park.md)).
- **Bug reports** — Repro / Evidence / Root cause / Fix direction / Acceptance
  (the `file-bug` skill's format).
- **Spec sections** — `linear-file-spec` parses a multi-section markdown spec
  into N linked tickets, each following a template shape.

Today every filing re-derives the scaffold. `file --desc` takes raw markdown,
so the *shape* (sections, headings, acceptance criteria) is manually retyped
each time. The gap: **reusable templates** that pre-fill the structure and
accept the variables.

This generalizes `park` — `park` is `template file user-story` with a baked-in
scaffold. Templates make the pattern extensible without a new command per
shape.

## Proposal

### Template files

Templates live in `.linearctl/templates/` (repo-local) and
`~/.config/linearctl/templates/` (user-global), as markdown files with
frontmatter:

```markdown
---
name: bug
title: "bug: {{ summary }}"
labels: [bug]
description: |
  ## Repro
  {{ repro }}

  ## Evidence
  {{ evidence }}

  ## Root cause
  {{ root_cause | "TBD" }}

  ## Fix direction
  {{ fix_direction | "TBD" }}

  ## Acceptance
  {{ acceptance }}
---
```

### Commands

#### `linearctl template list [--json]`

List available templates (name + source: repo-local or user-global):

```
bug              .linearctl/templates/bug.md
user-story       .linearctl/templates/user-story.md
spec-section     ~/.config/linearctl/templates/spec-section.md
```

#### `linearctl template file <name> --team CER [--project ID] [--var key=value...] [--json]`

File an issue from a template, filling variables:

```
linearctl template file bug --team CER \
  --var summary="ratelimit exit code wrong on probe failure" \
  --var repro="linearctl ratelimit with dead network" \
  --var evidence="exit 1, not 2" \
  --var acceptance="exit 2 when quota exhausted"
```

- Variables use `{{ var }}` substitution (Handlebars-free — simple regex
  replace, no new dep). `{{ var | "default" }}` supports defaults.
- `--var key=value` is repeatable. `--var key=-` reads a value from stdin.
- Frontmatter `title` becomes the issue title (after substitution);
  `description` becomes the issue body; `labels` are resolved + attached.
- Calls the same `core/issues` create path as `file`.

#### `linearctl template validate <name>`

Check a template: frontmatter parses, required variables are declared,
substitution doesn't leave unresolved `{{ }}` markers. Catches typos
before a batch filing run.

### Behavior

- **Variable resolution:** `--var` flags → frontmatter `{{ }}` slots. Missing
  variables with no default → error (fail loud, like `pickLabelIds`). Missing
  with a default → use default.
- **Label resolution:** frontmatter `labels` resolved via the existing
  `pickLabelIds` (strict — labels must exist; use `linearctl label create`
  first).
- **Precedence:** repo-local templates override user-global ones with the same
  name.
- All commands honor `--json`.

## API surface

No new Linear mutations — `template file` calls `createIssue` (the same path
as `file`). Template parsing + variable substitution is pure `lib/template.ts`.

## Relationship to existing skills

| Skill | What it does | What `template` adds |
|---|---|---|
| `file-bug` | Interactive, one bug at a time, via MCP | Headless/batch bug filing with a repo-defined shape |
| `linear-file-spec` | Parses a spec file into N tickets | Template-per-section (the spec sections *are* templates) |
| `park` | User-story scaffold, baked in | `park` becomes `template file user-story` (or keeps its own command for ergonomics) |

`template` doesn't replace the skills — it gives the **CLI** the same
scaffold-reuse capability the interactive skills have.

## Non-goals

- **No template marketplace.** Templates are local files, not shared.
  Sharing is git's job (commit `.linearctl/templates/`).
- **No dynamic/templated labels.** Labels in frontmatter are literal names,
  not `{{ }}`-substituted (avoids creating arbitrary labels from input).
- **No conditional sections.** Templates are flat substitution; `{{ if X }}`
  logic needs Handlebars (a dep) — out of scope. Use multiple templates
  instead.

## Alternatives considered

- **Just use `file --desc` with a shell heredoc.** Works for one-off; doesn't
  scale to "file 12 bugs from a CSV" — the template shape has to be retyped
  or embedded in a script. Templates make the shape a file, reusable across
  runs and teams.
- **Handlebars/Mustache.** Adds a dependency for `{{ if }}`/`{{ each }}` that
  the use case doesn't need. Regex substitution over a flat frontmatter is
  enough and stays dep-free.

## Verification

- `linearctl template list` → lists templates from both locations.
- `linearctl template file bug --team CER --var summary="x" --var repro="y" ...`
  → issue created with the bug scaffold, title `bug: x`, label `bug` attached.
- `linearctl template file bug --team CER` (missing required vars) → error
  listing the missing variables.
- `linearctl template validate bug` → OK; `validate broken-template` → error
  pointing at the unresolved `{{ }}` or bad frontmatter.
- `--var key=-` reading from stdin → value substituted correctly.
