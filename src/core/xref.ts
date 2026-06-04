import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LinearClient } from "@linear/sdk";

const pexec = promisify(execFile);

interface GhPR {
  number: number;
  title: string;
  body: string | null;
  headRefName: string;
  url: string;
}

/**
 * List PRs via the GitHub CLI. The only non-Linear dependency in the suite —
 * degrades with a clear error (never an unhandled crash) if `gh` is missing or
 * unauthenticated. Omitting `repo` lets `gh` use the current directory's repo.
 */
async function ghPRList(
  repo: string | undefined,
  state: string,
  limit: number,
): Promise<GhPR[]> {
  const args = [
    "pr", "list", "--state", state, "--limit", String(limit),
    "--json", "number,title,body,headRefName,url",
  ];
  if (repo) args.push("--repo", repo);
  let stdout: string;
  try {
    ({ stdout } = await pexec("gh", args, { maxBuffer: 20_000_000 }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `\`gh\` failed (state=${state}). Ensure the GitHub CLI is installed and ` +
        `authenticated (\`gh auth status\`). ${msg}`,
    );
  }
  return JSON.parse(stdout) as GhPR[];
}

// A PR's ticket is named where the conventions put it (RFC §4.4) — NOT in
// arbitrary body prose (which mentions other tickets: "next: CER-2", "out of
// scope: CER-3"). So extract only from: the branch (`feature/cer-123-…`), the
// title, and magic-word body refs (`Closes CER-123`, tolerating markdown like
// `**CER-123**`). This keeps prose mentions from masquerading as the deliverable.
const ANY_REF = /\b([A-Za-z]{2,})-(\d+)\b/g;
const MAGIC_REF =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|part of)\b[\s:#*_-]*([A-Za-z]{2,}-\d+)\b/gi;

function extractRefs(pr: GhPR, prefixes?: Set<string>): string[] {
  const refs = new Set<string>();
  const add = (rawPrefix: string, num: string) => {
    const prefix = rawPrefix.toUpperCase();
    if (prefixes && !prefixes.has(prefix)) return;
    refs.add(`${prefix}-${num}`);
  };
  // branch name + title: reliable ticket signals
  for (const m of `${pr.headRefName}\n${pr.title}`.matchAll(ANY_REF)) add(m[1], m[2]);
  // body: only refs introduced by a magic word
  for (const m of (pr.body ?? "").matchAll(MAGIC_REF)) {
    const [prefix, num] = m[1].split("-");
    add(prefix, num);
  }
  return [...refs];
}

export interface XrefFinding {
  kind:
    | "open-pr-no-ticket"
    | "merged-pr-no-ticket"
    | "merged-pr-ticket-not-done"
    | "pr-ref-missing-ticket";
  pr: number;
  prTitle: string;
  prUrl: string;
  refs: string[];
  detail: string;
}

export interface XrefResult {
  repo: string;
  openPRs: number;
  mergedPRs: number;
  findings: XrefFinding[];
}

interface TicketState {
  exists: boolean;
  done: boolean;
  state: string | null;
}

async function ticketState(client: LinearClient, ref: string): Promise<TicketState> {
  try {
    const issue = await client.issue(ref);
    const state = await issue.state;
    return { exists: true, done: state?.type === "completed", state: state?.name ?? null };
  } catch {
    // Non-existent identifier (or a non-ticket like UTF-8) — treat as not a ticket.
    return { exists: false, done: false, state: null };
  }
}

/** Bounded-concurrency map (keeps the per-ref Linear lookups from flooding). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Reconcile GitHub PRs ↔ Linear tickets (read-only, RFC §3.4). Scans open +
 * merged PRs for `KEY-N` refs, validates each against Linear (so non-tickets
 * like `UTF-8` are ignored), and reports: in-flight PRs naming no ticket, merged
 * PRs naming no ticket, merged PRs whose ticket isn't Done, and (when `--team`
 * scopes the prefixes) prefix-matching refs that point at no real ticket.
 * See docs/spec.md §6.10.
 */
export async function xref(
  client: LinearClient,
  opts: { repo?: string; teamKeys?: string[]; mergedLimit?: number },
): Promise<XrefResult> {
  const prefixes =
    opts.teamKeys && opts.teamKeys.length && !opts.teamKeys.includes("all")
      ? new Set(opts.teamKeys.map((k) => k.toUpperCase()))
      : undefined;

  const [open, merged] = await Promise.all([
    ghPRList(opts.repo, "open", 200),
    ghPRList(opts.repo, "merged", opts.mergedLimit ?? 50),
  ]);

  const openRefs = open.map((pr) => ({ pr, refs: extractRefs(pr, prefixes) }));
  const mergedRefs = merged.map((pr) => ({ pr, refs: extractRefs(pr, prefixes) }));

  const uniqueRefs = [
    ...new Set([...openRefs, ...mergedRefs].flatMap((x) => x.refs)),
  ];
  const states = new Map<string, TicketState>();
  await mapPool(uniqueRefs, 10, async (ref) => {
    states.set(ref, await ticketState(client, ref));
    return ref;
  });

  const findings: XrefFinding[] = [];

  for (const { pr, refs } of openRefs) {
    const real = refs.filter((r) => states.get(r)?.exists);
    if (real.length === 0) {
      findings.push({
        kind: "open-pr-no-ticket",
        pr: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        refs: [],
        detail: "in-flight PR names no Linear ticket",
      });
    }
    // when --team scopes prefixes, a prefix-matching ref that resolves to nothing is a typo/gap
    if (prefixes) {
      for (const r of refs) {
        if (!states.get(r)?.exists) {
          findings.push({
            kind: "pr-ref-missing-ticket",
            pr: pr.number,
            prTitle: pr.title,
            prUrl: pr.url,
            refs: [r],
            detail: `references ${r}, which is not a real ticket`,
          });
        }
      }
    }
  }

  for (const { pr, refs } of mergedRefs) {
    const real = refs.filter((r) => states.get(r)?.exists);
    if (real.length === 0) {
      findings.push({
        kind: "merged-pr-no-ticket",
        pr: pr.number,
        prTitle: pr.title,
        prUrl: pr.url,
        refs: [],
        detail: "merged PR maps to no Linear ticket",
      });
      continue;
    }
    for (const r of real) {
      const st = states.get(r)!;
      if (!st.done) {
        findings.push({
          kind: "merged-pr-ticket-not-done",
          pr: pr.number,
          prTitle: pr.title,
          prUrl: pr.url,
          refs: [r],
          detail: `${r} is "${st.state}", not Done`,
        });
      }
    }
  }

  return {
    repo: opts.repo ?? "(current dir)",
    openPRs: open.length,
    mergedPRs: merged.length,
    findings,
  };
}
