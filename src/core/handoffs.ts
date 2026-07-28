/**
 * CRUD over the linearctl handoff store — cross-session memory for what a
 * session landed, what it verified, and what the next session should do.
 *
 * A `Handoff` is the persisted form of the human-authored handoff doc at
 * `docs/handoffs/2026-07-28-cer-1148-oauth-scaffolding.md`, made first-class:
 * the operator daemon (Track 1) and `linearctl watch` can call `createHandoff`
 * to persist session state; the next session rehydrates from `listHandoffs` +
 * `getHandoff`. This is the durable-state half of estate invariant 8
 * ("park, don't drop") — Reverie stays the cross-harness memory of record;
 * handoffs are linearctl-local durable state.
 *
 * Storage: `~/.local/state/linearctl/handoffs/<id>.md` — the same XDG state
 * dir the operator daemon uses for its Unix socket
 * (`src/lib/control-socket.ts:30`). One markdown file per handoff, with a
 * small YAML frontmatter block (id/date/status + optional pr/ticket/title)
 * so `linearctl doc`-style markdown is the storage format and the file is
 * human-readable when opened directly. Frontmatter parse/serialize mirrors the
 * minimal approach in `src/core/loop-recipes.ts` — no new YAML dependency.
 *
 * Local-only in the first slice. Mirroring handoffs to a Linear project doc
 * (or committing them under the repo's `docs/handoffs/`) is a later
 * `--mirror` decision — see the follow-up-tracks plan, Track 6 sub-feature B
 * open operator decision 1.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

/** Default handoff store — the XDG state dir shared with the operator socket. */
export const DEFAULT_HANDOFF_STORE = `${homedir()}/.local/state/linearctl/handoffs`;

/** A handoff's lifecycle status. `active` = open work; `resolved` = landed/closed. */
export type HandoffStatus = "active" | "resolved";

/**
 * A persisted session handoff. The body is markdown matching the existing
 * handoff template (Date/PR/Ticket/Status → What landed → Verification →
 * Decisions → Next steps); `pr` / `ticket` are optional identifiers that let a
 * future `listHandoffs` filter or a TUI pane render a compact row.
 */
export interface Handoff {
  id: string;
  date: string; // YYYY-MM-DD
  pr?: string;
  ticket?: string;
  title: string;
  status: HandoffStatus;
  body: string;
}

/** Input for {@link createHandoff} — `id`/`date`/`status` are derived, not caller-set. */
export interface NewHandoff {
  title: string;
  pr?: string;
  ticket?: string;
  body: string;
}

/** The handoff store resolved for a call. `dir` overrides the default XDG path. */
export function resolveStore(dir?: string): string {
  return dir ? resolve(dir) : DEFAULT_HANDOFF_STORE;
}

const ID_SLUG_RE = /[^a-z0-9]+/g;

/**
 * Build a filesystem-safe handoff id from a title + date. The slug is derived
 * (not caller-supplied) so ids stay sortable by date and convention with the
 * existing `2026-07-28-cer-1148-oauth-scaffolding.md` handoff is preserved:
 * `<YYYY-MM-DD>-<slug>`. The slug is lowercased, non-alphanumerics collapse to
 * single `-`, and empty slugs fall back to `handoff`.
 */
export function handoffId(title: string, date: string): string {
  const slug = title
    .toLowerCase()
    .replace(ID_SLUG_RE, "-")
    .replace(/^-+|-+$/g, "");
  return `${date}-${slug || "handoff"}`;
}

/** Today's date as `YYYY-MM-DD` (local time — a handoff is session-local). */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Serialize a Handoff to its markdown storage form: YAML frontmatter
 * (id/date/status + optional pr/ticket/title) followed by the body. The
 * frontmatter is the only structured surface; `body` is verbatim markdown.
 */
export function serializeHandoff(h: Handoff): string {
  const lines = ["---"];
  lines.push(`id: ${yamlScalar(h.id)}`);
  lines.push(`date: ${yamlScalar(h.date)}`);
  lines.push(`title: ${yamlScalar(h.title)}`);
  if (h.pr) lines.push(`pr: ${yamlScalar(h.pr)}`);
  if (h.ticket) lines.push(`ticket: ${yamlScalar(h.ticket)}`);
  lines.push(`status: ${h.status}`);
  lines.push("---");
  lines.push("");
  // Preserve the body as-written; a single trailing newline keeps the file tidy.
  return lines.join("\n") + h.body.replace(/\n+$/, "") + "\n";
}

/** Quote a scalar for YAML only when it would otherwise be misread on parse. */
function yamlScalar(v: string): string {
  if (v === "") return '""';
  // Quote only the cases that break a naive `key: value` line parse:
  //   - leading YAML indicator chars (# starts a comment, * & ! > | etc. are flow markers)
  //   - a literal true/false/null/~ (would be typed as boolean/null)
  //   - contains `: ` or ` #` (would be read as a mapping or a trailing comment)
  //   - leading/trailing whitespace (would be silently trimmed)
  // Date/id/ticket scalars (e.g. 2026-07-28-oauth, CER-1148) need NO quoting —
  // they don't start with an indicator and contain no colon-space, so the
  // naive parser reads them verbatim. PR refs like "#112" DO quote (leading #).
  const needsQuote =
    /^["'#!&*?>|@`%-]/.test(v) ||
    /^(true|false|null|~)$/i.test(v) ||
    /:\s|\s#/.test(v) ||
    v !== v.trim();
  if (!needsQuote) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Parse the frontmatter of a handoff markdown file. Mirrors the minimal
 * approach in `src/core/loop-recipes.ts#parseFrontmatter` — top-level
 * `key: value` lines only (handoff frontmatter is always flat), with
 * `key: ""` / `key: value` semantics. Returns the raw parsed record + the body
 * after the closing `---`, or `null` if the file has no frontmatter block.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const block = match[1];
  const body = match[2];
  const data: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const noComment = line.replace(/ #.*$/, "");
    if (!noComment.trim()) continue;
    const kvMatch = noComment.match(/^([\w_]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const raw = kvMatch[2].trim();
    if (raw === "") {
      data[key] = "";
    } else if (raw === "[]") {
      data[key] = [];
    } else {
      const cleaned = raw.replace(/^["']|["']$/g, "");
      data[key] = cleaned;
    }
  }
  return { frontmatter: data, body: body.replace(/\n+$/, "") };
}

/** Validate + shape a parsed frontmatter record into a `Handoff`. Throws on malformed. */
function toHandoff(frontmatter: Record<string, unknown>, body: string, file: string): Handoff {
  const id = frontmatter.id;
  const date = frontmatter.date;
  const title = frontmatter.title;
  const status = frontmatter.status;
  if (typeof id !== "string" || !id) throw new HandoffError(`missing id in ${basename(file)}`);
  if (typeof date !== "string" || !date) throw new HandoffError(`missing date in ${basename(file)}`);
  if (typeof title !== "string" || !title) throw new HandoffError(`missing title in ${basename(file)}`);
  if (status !== "active" && status !== "resolved") {
    throw new HandoffError(`invalid status "${String(status)}" in ${basename(file)} (expected active|resolved)`);
  }
  const pr = typeof frontmatter.pr === "string" && frontmatter.pr ? frontmatter.pr : undefined;
  const ticket = typeof frontmatter.ticket === "string" && frontmatter.ticket ? frontmatter.ticket : undefined;
  return { id, date, title, status, pr, ticket, body: body.replace(/\n+$/, "") };
}

/** Read one handoff by id from the store. Throws `HandoffError` if missing/malformed. */
export function getHandoff(id: string, opts: { dir?: string } = {}): Handoff {
  const store = resolveStore(opts.dir);
  const file = join(store, `${id}.md`);
  if (!existsSync(file)) {
    throw new HandoffError(`no handoff with id "${id}" (looked in ${store})`);
  }
  const raw = readFileSync(file, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new HandoffError(`handoff ${id} has no YAML frontmatter (expected ---\\nid: …\\nstatus: …\\n---)`);
  }
  return toHandoff(parsed.frontmatter, parsed.body, file);
}

/**
 * Persist a new handoff to the store. Derives `id`/`date`/`status` and writes
 * the markdown file. Returns the created `Handoff` (with the derived id so the
 * caller can print/`show` it). Throws `HandoffError` if a handoff with the
 * derived id already exists (idempotent create — re-running with the same
 * title on the same day is the common "did I already record this?" check).
 */
export function createHandoff(input: NewHandoff, opts: { dir?: string; date?: string } = {}): Handoff {
  if (!input.title.trim()) throw new HandoffError("handoff title is required.");
  if (!input.body.trim()) throw new HandoffError("handoff body is required.");
  const date = opts.date ?? today();
  const id = handoffId(input.title, date);
  const store = resolveStore(opts.dir);
  const file = join(store, `${id}.md`);
  if (existsSync(file)) {
    throw new HandoffError(`a handoff with id "${id}" already exists at ${file}`);
  }
  // Normalize once at the storage boundary: the canonical body has no
  // trailing newlines (serializeHandoff re-adds exactly one). Keeping the
  // in-memory Handoff in canonical form makes create→get an identity and
  // lets resolveHandoff's "preserve the body verbatim" contract hold.
  const body = input.body.replace(/\n+$/, "");
  const handoff: Handoff = {
    id,
    date,
    title: input.title,
    status: "active",
    pr: input.pr,
    ticket: input.ticket,
    body,
  };
  mkdirSync(store, { recursive: true });
  writeFileSync(file, serializeHandoff(handoff), "utf-8");
  return handoff;
}

/**
 * List all handoffs in the store, newest-first by date then id. Missing store
 * dir → `[]` (not an error — a fresh install has no handoffs yet). Malformed
 * files are skipped with a note to stderr so a corrupt file doesn't poison
 * the whole listing.
 */
export function listHandoffs(opts: { dir?: string } = {}): Handoff[] {
  const store = resolveStore(opts.dir);
  let entries: string[];
  try {
    entries = readdirSync(store);
  } catch {
    return [];
  }
  const handoffs: Handoff[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "README.md") continue;
    const file = join(store, entry);
    try {
      const raw = readFileSync(file, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;
      handoffs.push(toHandoff(parsed.frontmatter, parsed.body, file));
    } catch (e) {
      process.stderr.write(`warning: skipping malformed handoff ${entry}: ${(e as Error).message}\n`);
    }
  }
  // Newest-first by date desc, then id desc (ids start with the date, so this
  // is a stable lexical sort of the most recent session first).
  handoffs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return handoffs;
}

/**
 * Flip a handoff's status to `resolved` and persist the updated frontmatter.
 * The body is preserved verbatim (resolving is a status change, not an edit).
 * Throws `HandoffError` if the handoff is missing or already resolved.
 */
export function resolveHandoff(id: string, opts: { dir?: string } = {}): Handoff {
  const handoff = getHandoff(id, opts);
  if (handoff.status === "resolved") {
    throw new HandoffError(`handoff "${id}" is already resolved.`);
  }
  const updated: Handoff = { ...handoff, status: "resolved" };
  const store = resolveStore(opts.dir);
  const file = join(store, `${id}.md`);
  writeFileSync(file, serializeHandoff(updated), "utf-8");
  return updated;
}

/** Error class for handoff store failures (missing, malformed, already-resolved). */
export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffError";
  }
}
