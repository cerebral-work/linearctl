import { readStdinFor } from "../lib/io.js";
import { printJson, printTable } from "../lib/output.js";
import { isStyled, pc } from "../lib/style.js";
import {
  createHandoff,
  getHandoff,
  listHandoffs,
  resolveHandoff,
  HandoffError,
  type Handoff,
} from "../core/handoffs.js";
import { handoffBodySkeleton, missingSections, HANDOFF_SECTIONS } from "../lib/handoff-template.js";

export interface HandoffCreateOptions {
  title?: string;
  pr?: string;
  ticket?: string;
  body?: string;
  store?: string;
  skeleton?: boolean;
  json?: boolean;
}

export interface HandoffListOptions {
  store?: string;
  status?: "active" | "resolved" | "all";
  json?: boolean;
}


export interface HandoffShowOptions {
  store?: string;
  json?: boolean;
}

export interface HandoffResolveOptions {
  store?: string;
  json?: boolean;
}

/** Status badge for the human table — green active, dim resolved. */
function statusBadge(status: Handoff["status"]): string {
  if (!isStyled()) return status;
  return status === "active" ? pc.green("active") : pc.dim("resolved");
}


/**
 * `linearctl handoff create` — persist a session handoff to the local store.
 *
 * `--body <md|->` reads the markdown body (use `-` for stdin, same convention
 * as `file --desc -` / `comment --body -`). When `--body` is omitted entirely,
 * `--skeleton` emits the section template to stdout for `$EDITOR` workflows
 * (the caller edits, then pipes back via `--body -`). `--pr`/`--ticket` are
 * optional identifiers surfaced in `list`; `--store <dir>` overrides the
 * default `~/.local/state/linearctl/handoffs/` (test seam + ad-hoc relocation).
 * See docs/spec.md Track 6 sub-feature B.
 */
export async function handoffCreate(opts: HandoffCreateOptions): Promise<void> {
  const title = opts.title?.trim();
  if (!title) throw new Error("handoff create needs --title <text>.");

  let body: string | undefined;
  if (opts.body === "-") {
    body = await readStdinFor("--body -");
  } else if (opts.body) {
    body = opts.body;
  }

  // No body + --skeleton: emit the template and exit (the $EDITOR workflow).
  if (body === undefined) {
    if (!opts.skeleton) {
      throw new Error("handoff create needs --body <md|-> (or --skeleton to emit the template).");
    }
    process.stdout.write(
      handoffBodySkeleton({ pr: opts.pr, ticket: opts.ticket }),
    );
    return;
  }

  if (!body.trim()) throw new Error("handoff body is empty.");

  const created = createHandoff(
    { title, pr: opts.pr, ticket: opts.ticket, body },
    { dir: opts.store },
  );

  if (opts.json) {
    printJson(created);
    return;
  }

  const missing = missingSections(body);
  process.stdout.write(
    `created handoff "${created.title}" (${created.id})\n` +
      `  store: ${opts.store ?? "~/.local/state/linearctl/handoffs/"}\n` +
      `  status: active\n`,
  );
  if (missing.length > 0) {
    process.stderr.write(
      pc.yellow("⚠") + ` body is missing sections: ${missing.join(", ")}\n`,
    );
  }
}

/**
 * `linearctl handoff list [--status active|resolved|all]` — list handoffs,
 * newest-first. `--status` filters (default `active` — open work surfaces first;
 * `all` includes resolved). Plain table when piped, styled when at a TTY.
 */
export async function handoffList(opts: HandoffListOptions): Promise<void> {
  const status = opts.status ?? "active";
  const all = listHandoffs({ dir: opts.store });
  const filtered = status === "all" ? all : all.filter((h) => h.status === status);

  if (opts.json) {
    printJson(filtered);
    return;
  }

  if (filtered.length === 0) {
    process.stdout.write(
      status === "all" ? "(no handoffs)\n" : `(no ${status} handoffs)\n`,
    );
    return;
  }

  const rows = filtered.map((h) => ({
    id: h.id,
    date: h.date,
    status: statusBadge(h.status),
    title: h.title,
    pr: h.pr ?? "",
    ticket: h.ticket ?? "",
  }));
  printTable(rows, ["id", "date", "status", "title", "pr", "ticket"]);
}

/**
 * `linearctl handoff show <id>` — print one handoff in full (the stored
 * markdown, frontmatter + body). `--json` wraps the parsed `Handoff`.
 */
export async function handoffShow(id: string, opts: HandoffShowOptions): Promise<void> {
  const handoff = getHandoff(id, { dir: opts.store });

  if (opts.json) {
    printJson(handoff);
    return;
  }

  process.stdout.write(renderHandoff(handoff));
}

/** Render a Handoff as human-readable markdown (the storage form, re-serialized). */
function renderHandoff(h: Handoff): string {
  const lines: string[] = [];
  lines.push(`# ${h.title}`);
  lines.push("");
  lines.push(`- **id:** ${h.id}`);
  lines.push(`- **date:** ${h.date}`);
  lines.push(`- **status:** ${h.status}`);
  if (h.pr) lines.push(`- **pr:** ${h.pr}`);
  if (h.ticket) lines.push(`- **ticket:** ${h.ticket}`);
  lines.push("");
  lines.push(h.body.trimEnd());
  lines.push("");
  return lines.join("\n");
}

/**
 * `linearctl handoff resolve <id>` — flip a handoff's status to `resolved`.
 * Idempotent-safe: throws if already resolved (the caller learns it's a no-op,
 * not a silent success). The body is preserved verbatim.
 */
export async function handoffResolve(id: string, opts: HandoffResolveOptions): Promise<void> {
  try {
    const resolved = resolveHandoff(id, { dir: opts.store });
    if (opts.json) {
      printJson(resolved);
      return;
    }
    process.stdout.write(`resolved handoff "${resolved.title}" (${resolved.id})\n`);
  } catch (e) {
    if (e instanceof HandoffError) {
      process.stderr.write(`${pc.red("✖")} ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

/** Re-exported so tests + future callers can reference the section contract. */
export { HANDOFF_SECTIONS };
