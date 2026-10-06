/**
 * reorg — a generic, plan-file-driven Linear workspace reorganization engine.
 *
 * The estate's rules (team maps, label maps, status rules) live OUTSIDE this
 * repo; this module ships the schema, the op registry, the journaled executor,
 * the pacing, and the verification machinery — nothing workspace-specific.
 *
 * Pipeline: `reorg census` → `reorg plan --rules <file>` → human review →
 * `reorg apply <plan> --phase N [--apply | --check] [--resume]`. Dry-run is
 * the default; `--check` adds a live drift pre-read of every target (still no
 * writes); `--apply` requires a fresh backup record ({@link assertFreshBackup})
 * and gates irreversible ops behind `--allow-irreversible` + per-op approvals.
 *
 * Executor contract (per op, strictly sequential):
 *   live pre-read (abort on drift vs the census-time `from`, scoped to the
 *   op's read coverage) → write inside withRetry → re-read by a DIFFERENT
 *   query → compare the op's computed EXPECTED end state ({@link OpDef.expectedPost},
 *   never vacuous) → append to applied.jsonl (fsync). First mismatch stops the
 *   run with exit 3 — batch members are journaled individually first, the
 *   mismatching one marked ok:false. `--resume` skips journaled-ok seqs
 *   (before --max-ops slices). Ops sharing a `batchKey` (identical input) go
 *   through `issueBatchUpdate` in batches of ≤ 50, verified by one filtered
 *   read.
 *
 * The Linear MCP is never used. Pacing: token bucket at 2000 req/h plus
 * X-RateLimit-*-Remaining header reads, sleeping to reset under 10 %.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import type { LinearClient } from "@linear/sdk";
import { usageError } from "../lib/errors.js";
import { withRetry } from "../lib/retry.js";

// ---------------------------------------------------------------------------
// Plan file schema
// ---------------------------------------------------------------------------

export const REORG_OPS = [
  "create-workspace-label",
  "create-team-label",
  "relabel",
  "rename-label",
  "retire-or-delete-label",
  "set-state",
  "enable-triage",
  "archive-state",
  "set-project-status",
  "set-project-lead",
  "set-project-target",
  "add-project-team",
  "remove-project-team",
  "move-project-initiative",
  "set-initiative-owner",
  "archive-issue",
  "archive-project",
  "archive-initiative",
  "move-issue-team",
  "create-project-status",
  "delete-team",
] as const;
export type ReorgOpKind = (typeof REORG_OPS)[number];

/** Ops that have an irreversible form at all (reversible:false is phase-6-only). */
const IRREVERSIBLE_CAPABLE: Record<string, true> = {
  "retire-or-delete-label": true, // deleteIssueLabel is final; retire is not
  "archive-state": true, // no unarchive; recreate is the undo
  "delete-team": true, // data deleted after the 30-day grace window
};

export interface ReorgTarget {
  type: "issue" | "team" | "label" | "state" | "project" | "initiative";
  /** Linear UUID of the target entity (`new:<name>` for creates). */
  id: string;
  /** Human handle for reports (issue identifier, team key, label name…). */
  identifier: string;
}

export interface ReorgOp {
  seq: number;
  phase: number;
  op: ReorgOpKind;
  target: ReorgTarget;
  /** Live state captured at census time; the executor aborts on drift. May
   *  carry extra census context (projectTeamIds, cycleId) beyond the op's
   *  read coverage — the drift check only compares covered keys. */
  from: Record<string, unknown>;
  /** Intended change; the post-write compare uses {@link OpDef.expectedPost}. */
  to: Record<string, unknown>;
  /** Why this op exists (rule name + census evidence). */
  evidence: string;
  reversible: boolean;
  /** Deck item id; REQUIRED when reversible === false. */
  approval?: string;
  /** Groups identical-input relabel/set-state ops for issueBatchUpdate. */
  batchKey?: string;
  /** Explicit opt-in (copied from the rule, never inferred) for a move-issue-team
   *  or add-project-team op that changes who can see the affected issues or
   *  project. Without it such an op is refused. */
  allowVisibilityChange?: boolean;
}

export interface ReorgPlanMeta {
  generated: string;
  censusHash: string;
  workspaceId: string;
  rulesHash: string;
}

export interface ReorgPlan {
  meta: ReorgPlanMeta;
  ops: ReorgOp[];
  /** Non-fatal planner warnings (e.g. a to-be-deleted team still referenced). */
  warnings: string[];
  /** Per team-pair count of visibility-changing ops (all allowed here: the
   *  planner throws, listing the same table, when any is not). */
  visibility?: VisibilityPairCount[];
  /** Informational planner lines (e.g. source members who lose access). */
  notes?: string[];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Parse + validate a reorg plan file (header `_meta` line + one op per line). */
/** Trashing is a delayed permanent delete (Linear purges after 30 days), so an
 *  `archive-project` that asks for it is refused outright. */
export function assertArchiveProjectNotTrash(op: string, to: Record<string, unknown>, where: string): void {
  if (op === "archive-project" && to.trashed === true)
    throw new Error(
      `${where}: archive-project must not trash — trashing is a delayed permanent delete and belongs in a gated phase-6 op, not a reversible one (use to: { archived: true })`,
    );
}

export function parsePlanFile(path: string): ReorgPlan {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new Error(`plan file ${path} is empty`);
  const first: unknown = JSON.parse(lines[0]);
  if (
    !first || typeof first !== "object" || !("_meta" in first) ||
    !first._meta || typeof first._meta !== "object"
  ) {
    throw new Error('plan line 1 must be the {"_meta":…} header');
  }
  const meta = first._meta as ReorgPlanMeta;
  for (const k of ["generated", "censusHash", "workspaceId", "rulesHash"] as const) {
    if (typeof meta[k] !== "string" || !meta[k]) throw new Error(`plan _meta.${k} missing`);
  }
  const ops: ReorgOp[] = lines.slice(1).map((l, i) => {
    const o = JSON.parse(l) as ReorgOp;
    const where = `plan line ${i + 2}`;
    if (typeof o.seq !== "number") throw new Error(`${where}: seq must be a number`);
    if (typeof o.phase !== "number" || o.phase < 0 || o.phase > 6)
      throw new Error(`${where}: phase must be 0..6`);
    if (!REORG_OPS.includes(o.op)) throw new Error(`${where}: unknown op ${o.op}`);
    if (!o.target?.type || !o.target?.id) throw new Error(`${where}: target.type/id required`);
    if (typeof o.from !== "object" || o.from === null)
      throw new Error(`${where}: from required (captured at census)`);
    if (typeof o.to !== "object" || o.to === null) throw new Error(`${where}: to required`);
    assertArchiveProjectNotTrash(o.op, o.to, where);
    if (typeof o.evidence !== "string") throw new Error(`${where}: evidence required`);
    if (typeof o.reversible !== "boolean") throw new Error(`${where}: reversible required`);
    if (o.allowVisibilityChange !== undefined && typeof o.allowVisibilityChange !== "boolean")
      throw new Error(`${where}: allowVisibilityChange must be a boolean`);
    if (o.op === "create-team-label" && (typeof o.to.name !== "string" || !o.to.name))
      throw new Error(`${where}: create-team-label needs to.name`);
    if (o.op === "move-issue-team" && "labelMap" in o.to) {
      const lm = o.to.labelMap;
      if (!lm || typeof lm !== "object" || Array.isArray(lm) ||
          Object.values(lm as Record<string, unknown>).some((v) => typeof v !== "string" || !v))
        throw new Error(`${where}: move-issue-team to.labelMap must map source label ids to a label id or created:<seq>`);
    }
    if (o.op === "archive-state" && o.reversible !== false)
      throw new Error(`${where}: archive-state is never reversible (Linear has no unarchive) — reversible:false + approval required`);
    if (o.reversible === false) {
      // archive-state runs in phase 2 (after its issues are moved out) with a
      // deck approval; every other irreversible form is phase-6 only.
      const allowedPhase = o.op === "archive-state" ? o.phase === 2 || o.phase === 6 : o.phase === 6;
      if (!allowedPhase) throw new Error(`${where}: reversible:false ${o.op} is out of its allowed phase`);
      if (typeof o.approval !== "string" || !o.approval)
        throw new Error(`${where}: reversible:false needs an approval id`);
      if (!(o.op in IRREVERSIBLE_CAPABLE))
        throw new Error(`${where}: op ${o.op} has no irreversible form`);
    }
    return o;
  });
  const seqs = new Set<number>();
  for (const o of ops) {
    if (seqs.has(o.seq)) throw new Error(`duplicate seq ${o.seq}`);
    seqs.add(o.seq);
  }
  return { meta, ops: ops.sort((a, b) => a.seq - b.seq), warnings: [] };
}

// ---------------------------------------------------------------------------
// Pacing — token bucket + X-RateLimit header tracking
// ---------------------------------------------------------------------------

/** 2000 requests/hour under Linear's 2500/h personal-key budget. */
export const REORG_RATE_PER_HOUR = 2000;
const BUCKET_CAPACITY = 200;
/** Below 10 % remaining, sleep until the reset header says the window rolls. */
const LOW_WATERMARK = 0.1;

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerMs: number,
    capacity: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.tokens + (t - this.last) * this.ratePerMs, BUCKET_CAPACITY);
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil((1 - this.tokens) / this.ratePerMs));
    }
  }
}

/** Reads X-RateLimit-*-Remaining/Reset off raw responses; sleeps low → reset. */
export class RateTracker {
  private limit = 2500;
  private remaining = this.limit;
  private resetAtMs = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly onLow?: (remaining: number) => void,
  ) {}
  recordHeaders(headers?: Headers): void {
    if (!headers) return;
    const lim = Number(headers.get("x-ratelimit-requests-limit"));
    const rem = Number(headers.get("x-ratelimit-requests-remaining"));
    const rst = Number(headers.get("x-ratelimit-requests-reset"));
    if (Number.isFinite(lim) && lim > 0) this.limit = lim;
    if (Number.isFinite(rem)) this.remaining = rem;
    if (Number.isFinite(rst) && rst > 0) this.resetAtMs = rst; // UTC epoch ms
  }
  /** Sleep until the reset when the remaining budget dips under 10 %. */
  async throttleIfLow(): Promise<void> {
    if (this.remaining >= this.limit * LOW_WATERMARK) return;
    const wait = Math.max(0, this.resetAtMs - this.now()) + 1000;
    this.onLow?.(this.remaining);
    await this.sleep(wait);
    this.remaining = this.limit;
  }
  get snapshot(): { limit: number; remaining: number } {
    return { limit: this.limit, remaining: this.remaining };
  }
}

/** The one Linear call path for reorg: pace → retry → record headers. */
export async function reorgRaw<Data>(
  client: LinearClient,
  query: string,
  vars: Record<string, unknown>,
  pace: { bucket: TokenBucket; tracker: RateTracker },
): Promise<Data> {
  await pace.bucket.acquire();
  await pace.tracker.throttleIfLow();
  const res = await withRetry(() =>
    client.client.rawRequest<Data, Record<string, unknown>>(query, vars),
  );
  pace.tracker.recordHeaders(res.headers);
  if (res.errors?.length) {
    throw new Error(`graphql: ${res.errors.map((e) => e.message).join("; ")}`);
  }
  if (!res.data) throw new Error("graphql: no data in response");
  return res.data;
}

type MutPayload = Record<string, { success?: boolean } | undefined>;

/** Mutation call: the payload's `success:false` is a thrown error here. */
async function mutate(
  ctx: OpCtx,
  name: string,
  query: string,
  vars: Record<string, unknown>,
): Promise<void> {
  const d = await reorgRaw<MutPayload>(ctx.client, query, vars, ctx.pace);
  if (d[name]?.success === false) throw new Error(`mutation ${name} returned success:false`);
}

// ---------------------------------------------------------------------------
// Journal — applied.jsonl, fsync per record; resume reads ok:true seqs
// ---------------------------------------------------------------------------

export interface JournalRecord {
  seq: number | string; // op seq, or "verify" / "census" markers
  phase?: number;
  op?: string;
  /** The original op — lets rollback invert and preconditions cross-reference. */
  original?: ReorgOp;
  before?: unknown;
  after?: unknown;
  at: string;
  ok: boolean;
  error?: string;
  /** The live state already equalled the op's expected end state at pre-read
   *  (an earlier write landed but was never journaled); nothing was written.
   *  `before` is the planned from-state so rollback inverts it like any ok row. */
  alreadyApplied?: boolean;
  /** With alreadyApplied (move-issue-team): the issue was carried to the
   *  destination team by another move (a parent's cascade). Informational. */
  cascade?: boolean;
  /** The write call threw but a re-read showed the planned end state had landed.
   *  The tool's own write did the work, so rollback still inverts the row. */
  writeErrorButApplied?: boolean;
  /** With writeErrorButApplied: the message of the error the write threw. */
  writeError?: string;
}

function writeFsync(path: string, content: string, mode: "a" | "w"): void {
  const fd = openSync(path, mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function journalAppend(path: string, rec: JournalRecord): void {
  writeFsync(path, JSON.stringify(rec) + "\n", "a");
}

export function journalRead(path: string): JournalRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JournalRecord);
}

/** Seq numbers with a successful journal entry (drives --resume). */
export function journalOkSeqs(records: JournalRecord[]): Set<number> {
  const ok = new Set<number>();
  for (const r of records) if (r.ok && typeof r.seq === "number") ok.add(r.seq);
  return ok;
}

/** True when the LATEST verify marker for the phase is green (file order: a
 *  later red revokes an earlier green). */
export function journalPhaseVerified(records: JournalRecord[], phase: number): boolean {
  let latest: JournalRecord | undefined;
  for (const r of records) if (r.seq === "verify" && r.phase === phase) latest = r;
  return latest?.ok === true;
}

/** Latest verify marker for the phase in ONE journal (file order), or undefined. */
function latestMarker(records: JournalRecord[], phase: number): JournalRecord | undefined {
  let latest: JournalRecord | undefined;
  for (const r of records) if (r.seq === "verify" && r.phase === phase) latest = r;
  return latest;
}

/** Gate across journals, with no clock involved: if the CURRENT journal has any
 *  verify marker for the phase, its latest (file order) decides alone. Prior
 *  journals are consulted only when the current one has none, and then every
 *  prior journal that has a marker must end green (any red fails). */
export function journalPhaseVerifiedAcross(
  prior: JournalRecord[][],
  current: JournalRecord[],
  phase: number,
): boolean {
  const cur = latestMarker(current, phase);
  if (cur) return cur.ok === true;
  const marks = prior.map((j) => latestMarker(j, phase)).filter((m): m is JournalRecord => m !== undefined);
  return marks.length > 0 && marks.every((m) => m.ok === true);
}

/** Verify markers only, one list per journal, from journals this run must not
 *  own: read-only gate input. Their ops are never resumed, rolled back or written. */
export function loadPriorMarkers(paths: string[] | undefined): JournalRecord[][] {
  return (paths ?? []).map((p) => {
    if (!existsSync(p)) throw new Error(`--prior-journal ${p} does not exist`);
    return journalRead(p).filter((r) => r.seq === "verify");
  });
}

// ---------------------------------------------------------------------------
// Backup freshness gate
// ---------------------------------------------------------------------------

/**
 * `--apply` refuses unless a backup record (produced by the backup pipeline's
 * verify step) exists at `path` and is fresher than 24 h. The record shape is
 * `{ "verifiedAt": "<ISO>" }`; anything else fails closed.
 */
export function assertFreshBackup(path: string, now: Date = new Date()): void {
  if (!existsSync(path))
    throw new Error(
      `--apply requires a fresh backup record; none at ${path}. Run the backup pipeline first.`,
    );
  const rec = JSON.parse(readFileSync(path, "utf8")) as { verifiedAt?: string };
  if (!rec.verifiedAt || Number.isNaN(Date.parse(rec.verifiedAt)))
    throw new Error(`backup record ${path} has no parseable verifiedAt`);
  const ageMs = now.getTime() - Date.parse(rec.verifiedAt);
  if (ageMs > 24 * 3600 * 1000 || ageMs < 0)
    throw new Error(
      `backup record at ${path} is stale (verified ${rec.verifiedAt}); re-verify within 24 h of --apply`,
    );
}

// ---------------------------------------------------------------------------
// Live-state reads — typed at the boundary, fields named by the query
// ---------------------------------------------------------------------------

interface OpCtx {
  client: LinearClient;
  pace: { bucket: TokenBucket; tracker: RateTracker };
  /** Post-write verify re-read backoff (ms). Defaults to {@link DEFAULT_VERIFY_DELAYS_MS}. */
  verifyDelaysMs?: number[];
  /** Injectable sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (ev: { kind: string; detail: string }) => void;
  /** Verify markers from prior journals (read-only phase-gate input). */
  priorMarkers?: JournalRecord[][];
}

/** Linear's read API can lag a just-acknowledged write; a post-write re-read
 *  that still shows the old state is retried with this backoff before it is
 *  declared a mismatch. */
export const DEFAULT_VERIFY_DELAYS_MS = [500, 1000, 2000, 4000];

interface ReorgIssueNode {
  id: string;
  identifier: string;
  state?: { id: string; name: string; type: string } | null;
  labels?: { nodes: { id: string }[] } | null;
  project?: { id: string } | null;
  cycle?: { id: string } | null;
  team?: { id: string; key: string } | null;
  archivedAt?: string | null;
  trashed?: boolean | null;
}

interface ReorgLabelNode {
  id: string;
  name: string;
  retiredAt?: string | null;
  team?: { id: string; key: string } | null;
  /** Set on INHERITED labels (sub-team copies mirroring the owner team's
   *  label). Linear refuses writes on them ("Cannot update inherited labels").
   *  The owner id to target instead. */
  inheritedFrom?: { id: string } | null;
}

interface ReorgStateNode {
  id: string;
  name: string;
  type: string;
  archivedAt?: string | null;
  /** Set on INHERITED states (sub-team views of a parent team's state). */
  inheritedFrom?: { id: string } | null;
  team?: { id: string; key: string } | null;
}

interface ReorgProjectNode {
  id: string;
  name: string;
  status?: { id: string; name: string } | null;
  lead?: { id: string } | null;
  targetDate?: string | null;
  archivedAt?: string | null;
  trashed?: boolean | null;
  teams?: { nodes: { id: string; key: string }[] } | null;
  initiatives?: { nodes: { id: string }[] } | null;
}

interface ReorgInitiativeNode {
  id: string;
  name: string;
  archivedAt?: string | null;
  owner?: { id: string } | null;
}

interface ReorgTeamNode {
  id: string;
  key: string;
  triageEnabled?: boolean | null;
}

const ISSUE_STATE_Q = /* GraphQL */ `
  query ReorgIssueState($id: String!) {
    issue(id: $id) {
      id
      identifier
      state { id name type }
      labels { nodes { id } }
      project { id }
      cycle { id }
      team { id key }
      trashed
      archivedAt
    }
  }
`;

const LABEL_STATE_Q = /* GraphQL */ `
  query ReorgLabelState($id: String!) {
    issueLabel(id: $id) { id name retiredAt team { id key } inheritedFrom { id } }
  }
`;

const STATE_STATE_Q = /* GraphQL */ `
  query ReorgStateState($id: String!) {
    workflowState(id: $id) { id name type archivedAt inheritedFrom { id } }
  }
`;

const PROJECT_STATE_Q = /* GraphQL */ `
  query ReorgProjectState($id: String!) {
    project(id: $id) {
      id
      name
      status { id name }
      lead { id }
      targetDate
      archivedAt
      trashed
      teams { nodes { id key } }
      initiatives { nodes { id } }
    }
  }
`;

const INITIATIVE_STATE_Q = /* GraphQL */ `
  query ReorgInitiativeState($id: String!) {
    initiative(id: $id) { id name archivedAt owner { id } }
  }
`;

const TEAM_STATE_Q = /* GraphQL */ `
  query ReorgTeamState($id: String!) {
    team(id: $id) { id key triageEnabled }
  }
`;

/** Workspace-scoped label by exact name (team:null) — create's re-read. */
const FIND_WS_LABEL_Q = /* GraphQL */ `
  query ReorgFindWsLabel($name: String!) {
    issueLabels(filter: { name: { eqIgnoreCase: $name }, team: { null: true } }) {
      nodes { id name retiredAt }
    }
  }
`;

/**
 * Label references by NAME across ops in one plan: `"name:<n>"` entries in
 * to.add / to.remove / to.reapplyLabelIds resolve at apply time — first from
 * the journal (a landed create-workspace-label's id), then from a live
 * workspace-scoped by-name lookup. Zero hits or several = refuse (no guesses).
 */
const LABEL_REF_PREFIX = "name:";

async function resolveLabelRef(
  ctx: OpCtx,
  journal: JournalRecord[],
  name: string,
): Promise<string> {
  for (const r of journal) {
    if (
      r.ok && r.op === "create-workspace-label" &&
      r.original?.to.name === name && typeof r.original.to.labelId === "string"
    ) {
      return r.original.to.labelId;
    }
  }
  const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
    ctx.client, FIND_WS_LABEL_Q, { name }, ctx.pace,
  );
  const nodes = d.issueLabels.nodes;
  if (nodes.length === 0)
    throw new Error(`labelRef "name:${name}" resolves to nothing (no workspace label, none created earlier in the plan)`);
  if (nodes.length > 1)
    throw new Error(`labelRef "name:${name}" is ambiguous (${nodes.length} workspace labels share the name)`);
  return nodes[0].id;
}

/** Rewrite any "name:<n>" refs in an op's label-id arrays to real ids. */
async function resolveOpLabelRefs(
  ctx: OpCtx,
  journal: JournalRecord[],
  op: ReorgOp,
): Promise<ReorgOp> {
  const resolveArr = async (v: unknown): Promise<unknown> => {
    if (!Array.isArray(v)) return v;
    const out: string[] = [];
    for (const e of v as string[]) {
      out.push(typeof e === "string" && e.startsWith(LABEL_REF_PREFIX)
        ? await resolveLabelRef(ctx, journal, e.slice(LABEL_REF_PREFIX.length))
        : e);
    }
    return out;
  };
  const to = { ...op.to };
  for (const key of ["add", "remove", "reapplyLabelIds"] as const) {
    if (key in to) to[key] = await resolveArr(to[key]);
  }
  if (isRecord(to.labelMap)) {
    const resolved: Record<string, string> = {};
    for (const [src, ref] of Object.entries(to.labelMap)) {
      resolved[src] = resolveCreatedRef(String(ref), journal, op.seq);
    }
    to.labelMapResolved = resolved;
  }
  return { ...op, to };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const CREATED_REF_PREFIX = "created:";
const CREATE_LABEL_OPS = new Set<string>(["create-workspace-label", "create-team-label"]);

/** A labelMap destination: a label id as-is, or `created:<seq>` → the id the
 *  journal recorded when that create op landed. Anything else unresolved
 *  throws (no guesses, no fabrication). */
export function resolveCreatedRef(ref: string, journal: JournalRecord[], forSeq: number): string {
  if (!ref.startsWith(CREATED_REF_PREFIX)) return ref;
  const n = Number(ref.slice(CREATED_REF_PREFIX.length));
  if (!Number.isInteger(n)) throw new Error(`labelMap ref "${ref}" is not created:<seq>`);
  if (n >= forSeq) throw new Error(`labelMap ref "${ref}" must point at a lower seq than ${forSeq}`);
  for (const r of journal) {
    if (
      r.ok && r.seq === n && typeof r.op === "string" && CREATE_LABEL_OPS.has(r.op) &&
      typeof r.original?.to.labelId === "string"
    ) {
      return r.original.to.labelId;
    }
  }
  throw new Error(`labelMap ref "${ref}": no ok create-label journal record for seq ${n} (apply it first)`);
}

/** All labels carrying a name (case-insensitive), any scope. */
const LABELS_BY_NAME_CI_Q = /* GraphQL */ `
  query ReorgLabelsByNameCI($name: String!) {
    issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 250) {
      nodes { id name team { id key } inheritedFrom { id } }
    }
  }
`;

/** A team's parent and sub-teams (label-name uniqueness spans the family). */
const TEAM_FAMILY_Q = /* GraphQL */ `
  query ReorgTeamFamily($id: String!) {
    team(id: $id) { id key parent { id key } children { id } }
  }
`;

interface TeamFamily {
  key: string;
  parentId: string | null;
  parentKey: string | null;
  childIds: string[];
}

async function readTeamFamily(ctx: OpCtx, teamId: string): Promise<TeamFamily> {
  const d = await reorgRaw<{
    team: { key?: string; parent?: { id: string; key?: string } | null; children?: { id: string }[] | null } | null;
  }>(ctx.client, TEAM_FAMILY_Q, { id: teamId }, ctx.pace);
  if (!d.team) throw new Error(`team ${teamId} not found`);
  return {
    key: d.team.key ?? teamId,
    parentId: d.team.parent?.id ?? null,
    parentKey: d.team.parent?.key ?? null,
    childIds: (d.team.children ?? []).map((c) => c.id),
  };
}

/**
 * Names a create-team-label cannot take: any label of that name (case-
 * insensitive) owned by the destination team, its parent, any of its sub-
 * teams, or the workspace. `freed` holds label ids a lower-seq rename has
 * already moved off the name (journaled ones show up renamed in the live read
 * anyway; planned ones are passed in by --check); their inherited views go
 * with them.
 */
export async function findLabelNameConflicts(
  ctx: OpCtx,
  teamId: string,
  name: string,
  freed: Set<string>,
): Promise<ReorgLabelNode[]> {
  const [family, d] = await Promise.all([
    readTeamFamily(ctx, teamId),
    reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
      ctx.client, LABELS_BY_NAME_CI_Q, { name }, ctx.pace,
    ),
  ]);
  const scope = new Set<string>([teamId, ...family.childIds, ...(family.parentId ? [family.parentId] : [])]);
  return d.issueLabels.nodes.filter(
    (l) =>
      l.name.toLowerCase() === name.toLowerCase() &&
      (l.team == null || scope.has(l.team.id)) &&
      !freed.has(l.id) &&
      !(l.inheritedFrom && freed.has(l.inheritedFrom.id)),
  );
}

function describeConflicts(ls: ReorgLabelNode[]): string {
  return ls
    .map((l) => `"${l.name}" ${l.id}${l.team ? ` (team ${l.team.key})` : " (workspace)"}`)
    .join(", ");
}

/** Ids of rename-label ops, strictly lower seq than `seq`, that move a label
 *  off `name` (a rename to the same name frees nothing). */
function plannedRenameFrees(ops: ReorgOp[], seq: number, name: string): Set<string> {
  const freed = new Set<string>();
  for (const o of ops) {
    if (o.op !== "rename-label" || o.seq >= seq) continue;
    if (typeof o.to.name === "string" && o.to.name.toLowerCase() === name.toLowerCase()) continue;
    freed.add(o.target.id);
  }
  return freed;
}

/** Scope check for a labelMap destination: it must be usable on an issue in
 *  `destTeamId` — workspace, owned by that team, or owned by its parent
 *  (a parent's labels are inherited by its sub-teams). Returns a reason or null. */
async function destLabelProblem(
  ctx: OpCtx,
  labelIds: string[],
  destTeamId: string,
): Promise<Map<string, string>> {
  const problems = new Map<string, string>();
  labelIds = labelIds.filter((id) => !id.startsWith(PLANNED_REF_PREFIX));
  if (labelIds.length === 0) return problems;
  const [family, d] = await Promise.all([
    readTeamFamily(ctx, destTeamId),
    reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
      ctx.client, LABEL_SCOPES_Q, { ids: labelIds }, ctx.pace,
    ),
  ]);
  const byId = new Map(d.issueLabels.nodes.map((l) => [l.id, l] as const));
  for (const id of labelIds) {
    const l = byId.get(id);
    if (!l) problems.set(id, `destination label ${id} does not exist`);
    else if (l.inheritedFrom?.id)
      problems.set(id, `destination label "${l.name}" (${id}) is inherited from ${l.inheritedFrom.id} — map to the owner`);
    else if (l.team != null && l.team.id !== destTeamId && l.team.id !== family.parentId)
      problems.set(id, `destination label "${l.name}" (${id}) belongs to team ${l.team.key}, outside the destination team's scope`);
  }
  return problems;
}

const LABEL_SCOPES_Q = /* GraphQL */ `query ReorgLabelScopes($ids: [ID!]!) {
  issueLabels(filter: { id: { in: $ids } }, first: 250) { nodes { id name team { id key } inheritedFrom { id } } }
}`;

/** The destination for one live source label: keyed by its own id, else by
 *  the owner id when it is an inherited view. */
function mapDestFor(
  map: Record<string, string>,
  l: { id: string; inheritedFrom?: { id: string } | null },
): string | undefined {
  return map[l.id] ?? (l.inheritedFrom ? map[l.inheritedFrom.id] : undefined);
}

async function readIssue(ctx: OpCtx, id: string): Promise<Record<string, unknown>> {
  const d = await reorgRaw<{ issue: ReorgIssueNode | null }>(
    ctx.client, ISSUE_STATE_Q, { id }, ctx.pace,
  );
  if (!d.issue) throw new Error(`issue ${id} not found`);
  const i = d.issue;
  return {
    stateId: i.state?.id ?? null,
    stateName: i.state?.name ?? null,
    labelIds: (i.labels?.nodes ?? []).map((l) => l.id).sort(),
    projectId: i.project?.id ?? null,
    cycleId: i.cycle?.id ?? null,
    teamId: i.team?.id ?? null,
    teamKey: i.team?.key ?? null,
    archived: i.archivedAt != null,
  };
}

async function readLabel(ctx: OpCtx, id: string): Promise<Record<string, unknown>> {
  const d = await reorgRaw<{ issueLabel: ReorgLabelNode | null }>(
    ctx.client, LABEL_STATE_Q, { id }, ctx.pace,
  );
  if (!d.issueLabel) throw new Error(`label ${id} not found`);
  return {
    retired: d.issueLabel.retiredAt != null,
    name: d.issueLabel.name,
    inheritedFromId: d.issueLabel.inheritedFrom?.id ?? null,
  };
}

async function readState(ctx: OpCtx, id: string): Promise<Record<string, unknown>> {
  const d = await reorgRaw<{ workflowState: ReorgStateNode | null }>(
    ctx.client, STATE_STATE_Q, { id }, ctx.pace,
  );
  if (!d.workflowState) throw new Error(`state ${id} not found`);
  return {
    archived: d.workflowState.archivedAt != null,
    inheritedFromId: d.workflowState.inheritedFrom?.id ?? null,
  };
}

async function readProject(ctx: OpCtx, id: string): Promise<Record<string, unknown>> {
  const d = await reorgRaw<{ project: ReorgProjectNode | null }>(
    ctx.client, PROJECT_STATE_Q, { id }, ctx.pace,
  );
  if (!d.project) throw new Error(`project ${id} not found`);
  const p = d.project;
  return {
    statusId: p.status?.id ?? null,
    leadId: p.lead?.id ?? null,
    targetDate: p.targetDate ?? null,
    archived: p.archivedAt != null,
    trashed: p.trashed === true,
    teamIds: (p.teams?.nodes ?? []).map((t) => t.id).sort(),
    initiativeIds: (p.initiatives?.nodes ?? []).map((x) => x.id).sort(),
  };
}

async function readInitiative(ctx: OpCtx, id: string): Promise<Record<string, unknown>> {
  const d = await reorgRaw<{ initiative: (ReorgInitiativeNode & { owner?: { id: string } | null }) | null }>(
    ctx.client, INITIATIVE_STATE_Q, { id }, ctx.pace,
  );
  if (!d.initiative) throw new Error(`initiative ${id} not found`);
  return { archived: d.initiative.archivedAt != null, ownerId: d.initiative.owner?.id ?? null };
}

async function readTeam(ctx: OpCtx, id: string): Promise<Record<string, unknown>> {
  const d = await reorgRaw<{ team: ReorgTeamNode | null }>(
    ctx.client, TEAM_STATE_Q, { id }, ctx.pace,
  );
  if (!d.team) throw new Error(`team ${id} not found`);
  return { triageEnabled: d.team.triageEnabled === true };
}

/** Narrow `state` to the keys a compare cares about (used in diff reports). */
function pick(state: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, state[k]]));
}

function sortedStrings(v: unknown): string[] {
  return Array.isArray(v) ? [...(v as string[])].sort() : [];
}

// ---------------------------------------------------------------------------
// Op registry — readState (drift + verify), expectedPost (NEVER vacuous:
// the computed end state the re-read must match; null = entity must be
// absent), apply (mutation), inverse (rollback).
// ---------------------------------------------------------------------------

interface OpDef {
  /** Live read used for the from-drift check AND the post-write compare. */
  readState(ctx: OpCtx, op: ReorgOp): Promise<Record<string, unknown>>;
  /** The computed expected end state over compareKeys; null ⇒ readState must
   *  throw after the write (deletes). */
  expectedPost(op: ReorgOp): Record<string, unknown> | null;
  /** The write. */
  apply(ctx: OpCtx, op: ReorgOp): Promise<void>;
  /** Inverse op for rollback, or null when no inverse exists. */
  inverse(op: ReorgOp): ReorgOp | null;
  /** Keys readState returns; scopes BOTH the drift check and the compare. */
  compareKeys: string[];
}

const M = {
  issueUpdate: /* GraphQL */ `mutation ReorgIssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success } }`,
  issueArchive: /* GraphQL */ `mutation ReorgIssueArchive($id: String!) {
    issueArchive(id: $id) { success } }`,
  issueUnarchive: /* GraphQL */ `mutation ReorgIssueUnarchive($id: String!) {
    issueUnarchive(id: $id) { success } }`,
  labelCreate: /* GraphQL */ `mutation ReorgLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) { success } }`,
  labelUpdate: /* GraphQL */ `mutation ReorgLabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
    issueLabelUpdate(id: $id, input: $input) { success } }`,
  labelRestore: /* GraphQL */ `mutation ReorgLabelRestore($id: String!) {
    issueLabelRestore(id: $id) { success } }`,
  labelDelete: /* GraphQL */ `mutation ReorgLabelDelete($id: String!) {
    issueLabelDelete(id: $id) { success } }`,
  stateArchive: /* GraphQL */ `mutation ReorgStateArchive($id: String!) {
    workflowStateArchive(id: $id) { success } }`,
  teamUpdate: /* GraphQL */ `mutation ReorgTeamUpdate($id: String!, $input: TeamUpdateInput!) {
    teamUpdate(id: $id, input: $input) { success } }`,
  teamDelete: /* GraphQL */ `mutation ReorgTeamDelete($id: String!) {
    teamDelete(id: $id) { success } }`,
  projectUpdate: /* GraphQL */ `mutation ReorgProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) { success } }`,
  // projectArchive is @deprecated in the schema, but it is the only plain-archive
  // mutation (projectDelete trashes). trash:false is explicit so a server-side
  // default can never turn an archive into a delayed permanent delete.
  projectArchive: /* GraphQL */ `mutation ReorgProjectArchive($id: String!) {
    projectArchive(id: $id, trash: false) { success } }`,
  projectUnarchive: /* GraphQL */ `mutation ReorgProjectUnarchive($id: String!) {
    projectUnarchive(id: $id) { success } }`,
  initiativeArchive: /* GraphQL */ `mutation ReorgInitiativeArchive($id: String!) {
    initiativeArchive(id: $id) { success } }`,
  initiativeUnarchive: /* GraphQL */ `mutation ReorgInitiativeUnarchive($id: String!) {
    initiativeUnarchive(id: $id) { success } }`,
  initiativeToProjectDelete: /* GraphQL */ `mutation ReorgInitToProjDelete($id: String!) {
    initiativeToProjectDelete(id: $id) { success } }`,
  initiativeToProjectCreate: /* GraphQL */ `mutation ReorgInitToProjCreate($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) { success } }`,
  batchUpdate: /* GraphQL */ `mutation ReorgBatchUpdate($ids: [UUID!]!, $input: IssueUpdateInput!) {
    issueBatchUpdate(ids: $ids, input: $input) { success } }`,
  projectStatusCreate: /* GraphQL */ `mutation ReorgProjectStatusCreate($input: ProjectStatusCreateInput!) {
    projectStatusCreate(input: $input) { success } }`,
  initiativeUpdate: /* GraphQL */ `mutation ReorgInitiativeUpdate($id: String!, $input: InitiativeUpdateInput!) {
    initiativeUpdate(id: $id, input: $input) { success } }`,
};

/** One issue in a state? (archive-state precondition: only empty states.) */
const ISSUES_IN_STATE_Q = /* GraphQL */ `
  query ReorgIssuesInState($id: ID!) {
    issues(filter: { state: { id: { eq: $id } } }, includeArchived: true, first: 10) { nodes { id identifier archivedAt } }
  }
`;

/** A project's initiative joins — initiativeToProjects has no filter argument. */
const PROJECT_INIT_JOINS_Q = /* GraphQL */ `
  query ReorgProjectInitJoins($projectId: String!, $first: Int!, $after: String) {
    project(id: $projectId) {
      initiativeToProjects(first: $first, after: $after, includeArchived: true) {
        nodes { id initiative { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface StatusNode { id: string; name: string; type: string; position?: number | null }

const STATUS_LIFECYCLE = ["backlog", "planned", "started", "paused", "completed", "canceled"];

/** Place a new status after the last status whose type sorts at or before its
 *  own in the lifecycle, and before the next one: midpoint of the two
 *  neighbours, or last+1 when nothing follows. */
export function projectStatusPosition(all: StatusNode[], type: unknown): number {
  const rank = (t: unknown) => STATUS_LIFECYCLE.indexOf(String(t));
  const mine = rank(type);
  if (mine < 0) throw new Error(`create-project-status: unknown type "${String(type)}"`);
  const sorted = all
    .filter((x) => typeof x.position === "number")
    .sort((a, b) => (a.position as number) - (b.position as number));
  const before = sorted.filter((x) => rank(x.type) <= mine);
  const prev = before.length ? (before[before.length - 1].position as number) : null;
  const next = sorted.find((x) => rank(x.type) > mine && (prev === null || (x.position as number) > prev));
  if (prev === null) return next ? (next.position as number) - 1 : 0;
  return next ? (prev + (next.position as number)) / 2 : prev + 1;
}

/** Every project status (few; paginated) — projectStatuses takes no filter. */
const PROJECT_STATUSES_Q = /* GraphQL */ `
  query ReorgProjectStatuses($first: Int!, $after: String) {
    projectStatuses(first: $first, after: $after) {
      nodes { id name type position }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Emptiness probes for delete-team (all must be empty). */
const TEAM_ISSUES_Q = /* GraphQL */ `
  query ReorgTeamIssues($id: ID!) {
    issues(filter: { team: { id: { eq: $id } } }, includeArchived: true, first: 1) { nodes { id } }
  }
`;
const TEAM_PROJECTS_Q = /* GraphQL */ `
  query ReorgTeamProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after, includeArchived: true) {
      nodes { id teams { nodes { id } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const TEAM_LABELS_Q = /* GraphQL */ `
  query ReorgTeamLabels($id: ID!, $first: Int!, $after: String) {
    issueLabels(filter: { team: { id: { eq: $id } } }, first: $first, after: $after) {
      nodes { id retiredAt }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function hasLabelMap(op: ReorgOp): boolean {
  return isRecord(op.to.labelMap) && Object.keys(op.to.labelMap).length > 0;
}

/**
 * The exact label set a labelMap move must leave on the issue: live labels
 * that remain valid in the destination (workspace, or owned by the destination
 * team or its parent), plus the mapped replacement of each team label the issue
 * carries (keyed by the label id, or its owner id for an inherited view), plus
 * to.reapplyLabelIds. Mapping entries for labels the issue does not carry add
 * nothing.
 */
async function computeMoveLabelSet(ctx: OpCtx, op: ReorgOp, sourceIds?: string[]): Promise<string[]> {
  // sourceIds: the labels the issue carried BEFORE the move, when the live
  // read can no longer supply them (the move already happened).
  const ids = sourceIds ?? sortedStrings((await readIssue(ctx, op.target.id)).labelIds);
  const out = new Set<string>(sortedStrings(op.to.reapplyLabelIds));
  const map = (isRecord(op.to.labelMapResolved) ? op.to.labelMapResolved : {}) as Record<string, string>;
  if (ids.length > 0) {
    const [family, d] = await Promise.all([
      readTeamFamily(ctx, String(op.to.teamId)),
      reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
        ctx.client, LABEL_SCOPES_Q, { ids }, ctx.pace,
      ),
    ]);
    for (const l of d.issueLabels.nodes) {
      const dest = mapDestFor(map, l);
      if (dest) out.add(dest);
      else if (
        l.team == null ||
        (!l.inheritedFrom && (l.team.id === op.to.teamId || l.team.id === family.parentId))
      ) out.add(l.id);
    }
  }
  return [...out].sort();
}

export const OP_REGISTRY: Record<ReorgOpKind, OpDef> = {
  "create-workspace-label": {
    compareKeys: ["labelId"],
    // Absence anchor: from.labelId must be null and the live lookup by name
    // must find nothing — a pre-existing label is drift (prevents dup create).
    async readState(ctx, op) {
      const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
        ctx.client, FIND_WS_LABEL_Q, { name: op.to.name }, ctx.pace,
      );
      return { labelId: d.issueLabels.nodes[0]?.id ?? null };
    },
    expectedPost(op) {
      return { labelId: op.to.labelId ?? null };
    },
    async apply(ctx, op) {
      try {
        await mutate(ctx, "issueLabelCreate", M.labelCreate, {
          input: {
            name: op.to.name,
            color: op.to.color ?? "#999999",
            ...(typeof op.to.description === "string" ? { description: op.to.description } : {}),
            // no teamId → workspace-scoped label
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(msg)) {
          // Name BOTH spellings: the requested one and the live conflicting
          // one (one extra read, failure path only). The re-read is guarded:
          // if IT fails, Linear's original refusal must still surface —
          // fall back to the generic hint.
          let spellings = "";
          try {
            const live = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
              ctx.client, LABELS_BY_NAME_CI_Q, { name: op.to.name }, ctx.pace,
            );
            spellings = live.issueLabels.nodes.map((l) => `"${l.name}"`).join(", ");
          } catch {
            spellings = "";
          }
          throw new Error(
            `create-workspace-label "${String(op.to.name)}" refused by Linear (${msg}); ` +
              `label-name uniqueness is case-insensitive — the name is taken by ${spellings || "an existing label"}; rename it first`,
          );
        }
        throw err;
      }
      const live = await OP_REGISTRY["create-workspace-label"].readState(ctx, op);
      if (typeof live.labelId !== "string")
        throw new Error(`created label "${String(op.to.name)}" not found on re-read`);
      op.to.labelId = live.labelId; // journal `after` carries the created id
    },
    inverse: () => null, // inverse of create is delete — irreversible; retire by hand
  },

  "create-team-label": {
    // target is the DESTINATION team. from.labelId null is the absence anchor:
    // a label of that name already OWNED by the team is drift (no dup create).
    // Cross-scope conflicts (parent / sub-team / workspace) are a precondition.
    compareKeys: ["labelId"],
    async readState(ctx, op) {
      const name = String(op.to.name ?? "").toLowerCase();
      const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
        ctx.client, LABELS_BY_NAME_CI_Q, { name: op.to.name }, ctx.pace,
      );
      const own = d.issueLabels.nodes.find(
        (l) => l.team?.id === op.target.id && !l.inheritedFrom && l.name.toLowerCase() === name,
      );
      return { labelId: own?.id ?? null };
    },
    expectedPost(op) {
      return { labelId: op.to.labelId ?? null };
    },
    async apply(ctx, op) {
      await mutate(ctx, "issueLabelCreate", M.labelCreate, {
        input: {
          name: op.to.name,
          teamId: op.target.id,
          color: op.to.color ?? "#999999",
          ...(typeof op.to.description === "string" ? { description: op.to.description } : {}),
        },
      });
      const live = await OP_REGISTRY["create-team-label"].readState(ctx, op);
      if (typeof live.labelId !== "string")
        throw new Error(`created team label "${String(op.to.name)}" not found on re-read`);
      op.to.labelId = live.labelId; // journal carries the created id for created:<seq> refs
    },
    inverse(op) {
      if (typeof op.to.labelId !== "string") return null; // never created by this journal
      // retire (reversible), never delete: the label may already sit on issues
      return {
        ...op,
        op: "retire-or-delete-label",
        target: { type: "label", id: op.to.labelId, identifier: `${op.target.identifier}/${String(op.to.name)}` },
        from: { retired: false },
        to: { retired: true },
        reversible: true,
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "relabel": {
    compareKeys: ["labelIds"],
    readState: (ctx, op) => readIssue(ctx, op.target.id),
    expectedPost(op) {
      const base = new Set(sortedStrings(op.from.labelIds));
      for (const a of sortedStrings(op.to.add)) base.add(a);
      for (const r of sortedStrings(op.to.remove)) base.delete(r);
      return { labelIds: [...base].sort() };
    },
    async apply(ctx, op) {
      await mutate(ctx, "issueUpdate", M.issueUpdate, {
        id: op.target.id,
        input: {
          addedLabelIds: op.to.add ?? [],
          removedLabelIds: op.to.remove ?? [],
        },
      });
    },
    inverse(op) {
      const ep = OP_REGISTRY.relabel.expectedPost(op);
      if (ep === null) throw new Error("relabel inverse: unexpected null expectedPost");
      return {
        ...op,
        from: { ...op.from, labelIds: ep.labelIds },
        to: { add: op.to.remove ?? [], remove: op.to.add ?? [] },
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "rename-label": {
    // IssueLabelUpdateInput.name — needed because Linear enforces label-name
    // uniqueness ACROSS workspace and team scope: a workspace create fails
    // while any team copy carries the name. Rename copies first, then create.
    compareKeys: ["name"],
    readState: (ctx, op) => readLabel(ctx, op.target.id),
    expectedPost: (op) => ({ name: op.to.name }),
    async apply(ctx, op) {
      await mutate(ctx, "issueLabelUpdate", M.labelUpdate, {
        id: op.target.id,
        input: { name: op.to.name },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { name: op.from.name }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "retire-or-delete-label": {
    compareKeys: ["retired"],
    readState: (ctx, op) => readLabel(ctx, op.target.id),
    expectedPost(op) {
      if (!op.reversible) return null; // delete ⇒ the label must be GONE after
      return { retired: op.to.retired !== false };
    },
    async apply(ctx, op) {
      if (op.to.retired === false) {
        await mutate(ctx, "issueLabelUpdate", M.labelUpdate, {
          id: op.target.id,
          input: { retiredAt: null },
        });
      } else if (op.reversible) {
        await mutate(ctx, "issueLabelUpdate", M.labelUpdate, {
          id: op.target.id,
          input: { retiredAt: new Date().toISOString() },
        });
      } else {
        await mutate(ctx, "issueLabelDelete", M.labelDelete, { id: op.target.id });
      }
    },
    inverse(op) {
      if (!op.reversible) return null; // deleteIssueLabel is final
      return { ...op, from: op.to, to: { retired: false }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "set-state": {
    compareKeys: ["stateId"],
    readState: (ctx, op) => readIssue(ctx, op.target.id),
    expectedPost: (op) => ({ stateId: op.to.stateId }),
    async apply(ctx, op) {
      await mutate(ctx, "issueUpdate", M.issueUpdate, {
        id: op.target.id,
        input: { stateId: op.to.stateId },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { stateId: op.from.stateId }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "enable-triage": {
    compareKeys: ["triageEnabled"],
    readState: (ctx, op) => readTeam(ctx, op.target.id),
    expectedPost: (op) => ({ triageEnabled: op.to.triageEnabled ?? true }),
    async apply(ctx, op) {
      await mutate(ctx, "teamUpdate", M.teamUpdate, {
        id: op.target.id,
        input: { triageEnabled: op.to.triageEnabled ?? true },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { triageEnabled: false }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "archive-state": {
    compareKeys: ["archived"],
    readState: (ctx, op) => readState(ctx, op.target.id),
    expectedPost: () => ({ archived: true }),
    async apply(ctx, op) {
      await assertStateEmpty(ctx, op);
      await mutate(ctx, "workflowStateArchive", M.stateArchive, { id: op.target.id });
    },
    inverse: () => null, // no unarchive — recreate is the undo (operator-acknowledged)
  },

  "set-project-status": {
    compareKeys: ["statusId"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    expectedPost: (op) => ({ statusId: op.to.statusId }),
    async apply(ctx, op) {
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { statusId: op.to.statusId },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { statusId: op.from.statusId }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "set-project-lead": {
    compareKeys: ["leadId"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    expectedPost: (op) => ({ leadId: op.to.leadId ?? null }),
    async apply(ctx, op) {
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { leadId: op.to.leadId ?? null },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { leadId: op.from.leadId ?? null }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "set-project-target": {
    compareKeys: ["targetDate"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    expectedPost: (op) => ({ targetDate: op.to.targetDate ?? null }),
    async apply(ctx, op) {
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { targetDate: op.to.targetDate ?? null },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { targetDate: op.from.targetDate ?? null }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "add-project-team": {
    // to.teamIds is the FULL desired membership — sending only the new id
    // would replace it. The planner computes it (census from.teamIds + the
    // added id); the inverse restores from.teamIds exactly.
    compareKeys: ["teamIds"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    expectedPost: (op) => ({ teamIds: sortedStrings(op.to.teamIds) }),
    async apply(ctx, op) {
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { teamIds: sortedStrings(op.to.teamIds) },
      });
    },
    inverse(op) {
      return {
        ...op,
        from: { teamIds: sortedStrings(op.to.teamIds) },
        to: { teamIds: sortedStrings(op.from.teamIds) },
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "move-project-initiative": {
    // to: { fromInitiativeToProjectId?, fromInitiativeId?, toInitiativeId? } —
    // remove the old join row, create the new one; verify compares the full
    // computed initiativeIds set.
    compareKeys: ["initiativeIds"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    expectedPost(op) {
      const set = new Set(sortedStrings(op.from.initiativeIds));
      if (typeof op.to.fromInitiativeId === "string") set.delete(op.to.fromInitiativeId);
      if (typeof op.to.toInitiativeId === "string") set.add(op.to.toInitiativeId);
      return { initiativeIds: [...set].sort() };
    },
    async apply(ctx, op) {
      // Resolve the join-row id live when the plan doesn't carry it (inverse
      // ops never know it — re-created joins get fresh ids).
      let joinId = typeof op.to.fromInitiativeToProjectId === "string"
        ? op.to.fromInitiativeToProjectId
        : null;
      if (!joinId && typeof op.to.fromInitiativeId === "string") {
        // initiativeToProjects takes no filter argument: read the project's
        // own joins (guarded paging) and match the initiative in code.
        const joins = await paged<{ id: string; initiative: { id: string } }>(
          ctx.client, ctx.pace, PROJECT_INIT_JOINS_Q, "project.initiativeToProjects",
          { projectId: op.target.id }, undefined, true,
        );
        joinId = joins.find((n) => n.initiative.id === op.to.fromInitiativeId)?.id ?? null;
      }
      if (joinId) {
        await mutate(ctx, "initiativeToProjectDelete", M.initiativeToProjectDelete, { id: joinId });
      }
      if (typeof op.to.toInitiativeId === "string") {
        await mutate(ctx, "initiativeToProjectCreate", M.initiativeToProjectCreate, {
          input: { initiativeId: op.to.toInitiativeId, projectId: op.target.id },
        });
      }
    },
    inverse(op) {
      const ep = OP_REGISTRY["move-project-initiative"].expectedPost(op);
      if (ep === null) throw new Error("move-project-initiative inverse: unexpected null expectedPost");
      return {
        ...op,
        from: { ...op.from, initiativeIds: ep.initiativeIds },
        to: {
          fromInitiativeToProjectId: null, // re-created join gets a fresh id
          fromInitiativeId: op.to.toInitiativeId ?? null,
          toInitiativeId: op.from.initiativeId ?? null,
        },
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "archive-issue": {
    compareKeys: ["archived"],
    readState: (ctx, op) => readIssue(ctx, op.target.id),
    expectedPost: (op) => ({ archived: op.to.archived !== false }),
    async apply(ctx, op) {
      const unarchiving = op.to.archived === false;
      await mutate(ctx, unarchiving ? "issueUnarchive" : "issueArchive",
        unarchiving ? M.issueUnarchive : M.issueArchive, { id: op.target.id });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { archived: false }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "archive-project": {
    compareKeys: ["archived", "trashed"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    // Archive never trashes: trashed projects are permanently removed after
    // 30 days, archived ones stay restorable. parsePlanFile refuses to:{trashed:true}.
    expectedPost: (op) => ({ archived: op.to.archived !== false, trashed: false }),
    async apply(ctx, op) {
      const restoring = op.to.archived === false;
      await mutate(ctx, restoring ? "projectUnarchive" : "projectArchive",
        restoring ? M.projectUnarchive : M.projectArchive, { id: op.target.id });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { archived: false, trashed: false }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "archive-initiative": {
    compareKeys: ["archived"],
    readState: (ctx, op) => readInitiative(ctx, op.target.id),
    expectedPost: (op) => ({ archived: op.to.archived !== false }),
    async apply(ctx, op) {
      const restoring = op.to.archived === false;
      await mutate(ctx, restoring ? "initiativeUnarchive" : "initiativeArchive",
        restoring ? M.initiativeUnarchive : M.initiativeArchive, { id: op.target.id });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { archived: false }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "move-issue-team": {
    compareKeys: ["teamId", "projectId", "stateId"],
    readState: (ctx, op) => readIssue(ctx, op.target.id),
    expectedPost(op) {
      // stateId deliberately excluded: the executor's post-move correction
      // (step 5) owns the destination-state check, because a paired
      // teamId+stateId write may map the state instead of setting it.
      // verifyPhase adds to.stateId back for the after-the-fact check.
      return {
        teamId: op.to.teamId,
        // project membership must survive the move (precondition b)
        projectId: op.from.projectId ?? null,
      };
    },
    async apply(ctx, op) {
      // labelMap moves send the EXACT final label set (a team move drops team
      // labels, and a label of another team cannot be added beforehand); it is
      // computed once from live state and journaled as to.labelIdsComputed.
      if (!Array.isArray(op.to.labelIdsComputed) && hasLabelMap(op))
        op.to.labelIdsComputed = await computeMoveLabelSet(ctx, op);
      const exact = Array.isArray(op.to.labelIdsComputed);
      await mutate(ctx, "issueUpdate", M.issueUpdate, {
        id: op.target.id,
        input: {
          teamId: op.to.teamId,
          // The move drops team labels; the mapped workspace replacements are
          // re-sent in the same input (precondition a).
          ...(exact
            ? { labelIds: sortedStrings(op.to.labelIdsComputed) }
            : { addedLabelIds: op.to.reapplyLabelIds ?? [] }),
          // Destination state sent in the same input when the plan maps one.
          ...(op.to.stateId ? { stateId: op.to.stateId } : {}),
        },
      });
    },
    inverse(op) {
      // Move back to the original team. The identifier changes AGAIN (the old
      // one keeps resolving) — recorded in the identifier map, not restored.
      // A labelMap move restores the exact source label set recorded before it.
      const restore = hasLabelMap(op)
        ? { reapplyLabelIds: [], labelIdsComputed: sortedStrings(op.from.labelIds) }
        : { reapplyLabelIds: op.from.labelIds ?? [] };
      return {
        ...op,
        from: op.to,
        to: {
          teamId: op.from.teamId,
          ...restore,
          ...(op.from.stateId ? { stateId: op.from.stateId } : {}),
        },
        evidence: `rollback of seq ${op.seq} (identifier changes again; see identifier-map)`,
      };
    },
  },

  "remove-project-team": {
    // to.teamIds is NEVER trusted — the removal membership is computed from a
    // LIVE read at apply time (a blind replace could drop a team added after
    // the census). The computed set is journaled via to.teamIdsComputed so the
    // verify compares what was actually written.
    compareKeys: ["teamIds"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    expectedPost: (op) => ({
      teamIds: Array.isArray(op.to.teamIdsComputed)
        ? sortedStrings(op.to.teamIdsComputed)
        : sortedStrings(op.from.teamIds).filter((t) => t !== op.to.teamId),
    }),
    async apply(ctx, op) {
      const live = await readProject(ctx, op.target.id);
      const next = sortedStrings(live.teamIds).filter((t) => t !== op.to.teamId);
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { teamIds: next },
      });
      op.to.teamIdsComputed = next;
    },
    inverse(op) {
      return {
        ...op,
        op: "add-project-team",
        from: { teamIds: sortedStrings(op.from.teamIds).filter((t) => t !== op.to.teamId) },
        to: { teamId: op.to.teamId, teamIds: sortedStrings(op.from.teamIds) },
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "set-initiative-owner": {
    compareKeys: ["ownerId"],
    readState: (ctx, op) => readInitiative(ctx, op.target.id),
    expectedPost: (op) => ({ ownerId: op.to.ownerId ?? null }),
    async apply(ctx, op) {
      await mutate(ctx, "initiativeUpdate", M.initiativeUpdate, {
        id: op.target.id,
        input: { ownerId: op.to.ownerId ?? null },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { ownerId: op.from.ownerId ?? null }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "create-project-status": {
    // API supports projectStatusCreate (SDK createProjectStatus). Additive;
    // rollback is archiving the status in the UI (no inverse op here).
    compareKeys: ["statusId"],
    async readState(ctx, op) {
      const all = await paged<{ id: string; name: string; type: string }>(
        ctx.client, ctx.pace, PROJECT_STATUSES_Q, "projectStatuses", {},
      );
      const match = all.find(
        (st) => st.name === op.to.name && (typeof op.to.type !== "string" || st.type === op.to.type),
      );
      return { statusId: match?.id ?? null };
    },
    expectedPost: (op) => ({ statusId: op.to.statusId ?? null }),
    async apply(ctx, op) {
      // ProjectStatusCreateInput.position is a required Float!.
      const position =
        typeof op.to.position === "number"
          ? op.to.position
          : projectStatusPosition(
              await paged<StatusNode>(
                ctx.client, ctx.pace, PROJECT_STATUSES_Q, "projectStatuses", {},
              ),
              op.to.type,
            );
      op.to.position = position; // journal `after` carries the position used
      await mutate(ctx, "projectStatusCreate", M.projectStatusCreate, {
        input: {
          name: op.to.name,
          color: op.to.color ?? "#999999",
          type: op.to.type,
          position,
          ...(typeof op.to.description === "string" ? { description: op.to.description } : {}),
        },
      });
      const live = await OP_REGISTRY["create-project-status"].readState(ctx, op);
      if (typeof live.statusId !== "string")
        throw new Error(`created project status "${String(op.to.name)}" not found on re-read`);
      op.to.statusId = live.statusId;
    },
    inverse: () => null,
  },

  "delete-team": {
    compareKeys: [],
    readState: (ctx, op) => readTeam(ctx, op.target.id),
    expectedPost: () => null, // the team must be GONE after
    async apply(ctx, op) {
      await assertTeamEmpty(ctx, op);
      await mutate(ctx, "teamDelete", M.teamDelete, { id: op.target.id });
    },
    inverse: () => null, // 30-day grace via the UI; never an inverse op
  },
};

// ---------------------------------------------------------------------------
// move-issue-team preconditions (plan §2b a–d) — LIVE reads, no census trust
// ---------------------------------------------------------------------------

/**
 * Enforced by the executor immediately before a move-issue-team write:
 *  (a) phase 1 verified green in the journal, and EVERY team-scoped label
 *      currently on the issue (live read) has a journaled relabel removing it
 *      whose added workspace replacements are all in to.reapplyLabelIds —
 *      those are re-sent in the move input because the move drops team labels;
 *  (b) the destination team is in the issue's project teamIds — read LIVE
 *      from the project, never from census/journal;
 *  (c) phase 2 verified green (destination state predictable);
 *  (d) the issue's cycleId was captured in op.from (journaled first).
 */
/**
 * Refuse when an op WRITES an inherited label id onto an issue (to.add /
 * to.reapplyLabelIds). Removing a child id from an issue is allowed — the
 * write ban is on the label object itself and on ADDING inherited labels.
 */
export async function assertNoInheritedWrites(ctx: OpCtx, op: ReorgOp): Promise<void> {
  const mapped = isRecord(op.to.labelMapResolved) ? Object.values(op.to.labelMapResolved).map(String) : [];
  const written = [...sortedStrings(op.to.add), ...sortedStrings(op.to.reapplyLabelIds), ...mapped]
    .filter((id) => !id.startsWith(LABEL_REF_PREFIX) && !id.startsWith(CREATED_REF_PREFIX) && !id.startsWith(PLANNED_REF_PREFIX)); // refs resolve elsewhere
  if (written.length === 0) return;
  const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
    ctx.client,
    `query ReorgLabelScopes($ids: [ID!]!) {
      issueLabels(filter: { id: { in: $ids } }, first: 250) { nodes { id name team { id key } inheritedFrom { id } } }
    }`,
    { ids: written },
    ctx.pace,
  );
  for (const l of d.issueLabels.nodes) {
    if (l.inheritedFrom?.id)
      throw new Error(
        `seq ${op.seq} [${op.op}]: would write inherited label "${l.name}" (${l.id}), child of ${l.inheritedFrom.id} — write the owner instead`,
      );
  }
}

export async function assertMovePreconditions(
  ctx: OpCtx,
  op: ReorgOp,
  journal: JournalRecord[],
): Promise<void> {
  const fail = (why: string): never => {
    throw new Error(`move-issue-team seq ${op.seq} precondition: ${why}`);
  };
  const prior = ctx.priorMarkers ?? [];
  if (!journalPhaseVerifiedAcross(prior, journal, 1))
    fail("(a) phase-1 verify is not green in the journal");
  if (!Array.isArray(op.to.reapplyLabelIds) && !hasLabelMap(op))
    fail("(a) to.reapplyLabelIds missing — the mapped workspace labels must be re-sent in the move input");
  if (!journalPhaseVerifiedAcross(prior, journal, 2))
    fail("(c) phase-2 verify is not green in the journal");
  if (!("cycleId" in op.from)) fail("(d) from.cycleId not captured at census");

  // (a) live label check: every TEAM-scoped label on the issue must either
  // already have been swapped for a workspace replacement by a journaled
  // relabel, or be carried over via to.labelMap to a label usable in the
  // destination team (own, its parent's, or workspace).
  const live = await readIssue(ctx, op.target.id);
  const labelIds = sortedStrings(live.labelIds);
  if (labelIds.length > 0) {
    const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
      ctx.client,
      `query ReorgLabelScopes($ids: [ID!]!) {
        issueLabels(filter: { id: { in: $ids } }, first: 250) { nodes { id name team { id key } inheritedFrom { id } } }
      }`,
      { ids: labelIds },
      ctx.pace,
    );
    const teamScoped = d.issueLabels.nodes.filter((l) => l.team != null);
    const reapply = new Set(sortedStrings(op.to.reapplyLabelIds));
    const labelMap = (isRecord(op.to.labelMapResolved) ? op.to.labelMapResolved : {}) as Record<string, string>;
    const mappedDest = new Map<string, string>(); // label id on the issue -> destination id
    for (const l of teamScoped) {
      const swapped = journal.some(
        (r) =>
          r.ok &&
          r.op === "relabel" &&
          r.original?.target.id === op.target.id &&
          sortedStrings(r.original.to.remove).includes(l.id) &&
          sortedStrings(r.original.to.add).every((a) => reapply.has(a)),
      );
      if (swapped) continue;
      const dest = mapDestFor(labelMap, l);
      if (dest) {
        mappedDest.set(l.id, dest);
        continue;
      }
      fail(
        `(a) team label "${l.name}" (${l.id}) is live on ${op.target.identifier} with no ` +
          `journaled relabel to a workspace replacement and no to.labelMap entry — phase 1 is incomplete for this issue`,
      );
    }
    if (mappedDest.size > 0 && typeof op.to.teamId === "string") {
      const problems = await destLabelProblem(ctx, [...new Set(mappedDest.values())], op.to.teamId);
      for (const [src, dest] of mappedDest) {
        const why = problems.get(dest);
        if (why) fail(`(a) labelMap ${src} -> ${dest}: ${why}`);
      }
    }
  }

  // (b) LIVE project membership read
  const projectId = op.from.projectId;
  const destTeam = op.to.teamId;
  if (typeof projectId === "string" && typeof destTeam === "string") {
    const project = await readProject(ctx, projectId);
    if (!sortedStrings(project.teamIds).includes(destTeam))
      fail(
        `(b) destination team ${destTeam} is not in project ${projectId} teamIds (live read) — ` +
          `land an add-project-team op first`,
      );
  }
}

/**
 * Team visibility. A team move adopts the destination team's visibility, so
 * moving issues out of a private team into a non-private one exposes them to
 * every workspace member (and to guests who belong to the destination).
 */
export interface TeamVisibility {
  id: string;
  key: string;
  private: boolean;
  /** Member user ids; read only for private teams. null = not read. */
  memberIds: string[] | null;
}

export interface VisibilityPairCount {
  from: string;
  to: string;
  kind: "move-issue-team" | "add-project-team";
  count: number;
  allowed: boolean;
}

/**
 * Pure rule: does moving an issue from `src` to `dst` change who can see it?
 * Returns what widens, or null. private -> non-private widens it, and so does
 * private -> private when the destination has members the source lacks.
 * A destination missing some source members only removes readers (see
 * moveAccessLost). public -> anything is not a widening, so a rollback into a
 * private team is never refused.
 */
export function moveVisibilityChange(src: TeamVisibility, dst: TeamVisibility): string | null {
  if (src.id === dst.id || !src.private) return null;
  if (!dst.private)
    return `${src.key} is private and ${dst.key} is not: the moved issues become visible to every member of the workspace, and to guests who are members of ${dst.key}`;
  if (src.memberIds === null || dst.memberIds === null)
    return `${src.key} and ${dst.key} are both private but their members could not be compared`;
  const srcMembers = new Set(src.memberIds);
  const gained = dst.memberIds.filter((m) => !srcMembers.has(m));
  if (gained.length === 0) return null;
  return `${src.key} and ${dst.key} are both private but ${gained.length} member(s) of ${dst.key} are not members of ${src.key}: they gain access to the moved issues`;
}

/** Source members absent from a private destination: they lose access (readers
 *  removed, not added, so this is information and never a refusal). */
export function moveAccessLost(src: TeamVisibility, dst: TeamVisibility): number {
  if (src.id === dst.id || !src.private || !dst.private || !src.memberIds || !dst.memberIds) return 0;
  const dstMembers = new Set(dst.memberIds);
  return src.memberIds.filter((m) => !dstMembers.has(m)).length;
}

/**
 * Pure rule: does adding `added` teams to a project whose current teams are
 * `current` change who can see it? Only when every current team is private and
 * a non-private team is added (page, description and updates become visible).
 */
export function projectTeamAddVisibilityChange(
  current: TeamVisibility[],
  added: TeamVisibility[],
): string | null {
  if (current.length === 0 || !current.every((t) => t.private)) return null;
  const open = added.filter((t) => !t.private);
  if (open.length === 0) return null;
  return `project is only on private team(s) ${current.map((t) => t.key).join(", ")}; adding non-private ${open
    .map((t) => t.key)
    .join(", ")} makes the project page, description and updates visible to every member of the workspace`;
}

const TEAM_PRIVACY_Q = /* GraphQL */ `
  query ReorgTeamPrivacy($id: String!) {
    team(id: $id) { id key private }
  }
`;

const TEAM_MEMBERS_Q = /* GraphQL */ `
  query ReorgTeamMembers($id: String!, $first: Int!, $after: String) {
    team(id: $id) {
      members(first: $first, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/** Short-lived per-run cache: a plan moves many issues between the same few
 *  teams, and every one would otherwise re-read the same privacy and members. */
const VIS_CACHE_MS = 30_000;
const visCache = new WeakMap<object, Map<string, { at: number; v: TeamVisibility }>>();

/** LIVE read of a team's privacy (and, when asked, its members, strict paging). */
async function readTeamVisibility(ctx: OpCtx, id: string, members: boolean): Promise<TeamVisibility> {
  const cache = visCache.get(ctx) ?? new Map();
  visCache.set(ctx, cache);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < VIS_CACHE_MS && (!members || hit.v.memberIds !== null)) return hit.v;
  const d = await reorgRaw<{ team: { id: string; key: string; private: boolean } | null }>(
    ctx.client, TEAM_PRIVACY_Q, { id }, ctx.pace,
  );
  if (!d.team) throw new Error(`team ${id} not found — cannot establish its visibility`);
  if (typeof d.team.private !== "boolean")
    throw new Error(`team ${id} returned no boolean private flag — refusing to assume it is public`);
  const memberIds =
    members && d.team.private
      ? (await paged<{ id: string }>(ctx.client, ctx.pace, TEAM_MEMBERS_Q, "team.members", { id }, undefined, true))
          .map((m) => m.id)
          .sort()
      : null;
  const v: TeamVisibility = { id: d.team.id, key: d.team.key, private: d.team.private, memberIds };
  cache.set(id, { at: Date.now(), v });
  return v;
}

/**
 * LIVE check of whether `op` changes visibility: what changes and between which
 * teams, or null. Reads privacy and membership from the teams themselves, never
 * from the census.
 */
async function visibilityInfo(ctx: OpCtx, op: ReorgOp): Promise<{ why: string; pair: string } | null> {
  if (op.op === "move-issue-team") {
    if (typeof op.to.teamId !== "string") return null;
    const live = await readIssue(ctx, op.target.id);
    const srcId = typeof live.teamId === "string" ? live.teamId : op.from.teamId;
    if (typeof srcId !== "string" || srcId === op.to.teamId) return null;
    const src = await readTeamVisibility(ctx, srcId, false);
    if (!src.private) return null;
    const dst = await readTeamVisibility(ctx, op.to.teamId, false);
    const why = dst.private
      ? moveVisibilityChange(
          await readTeamVisibility(ctx, srcId, true),
          await readTeamVisibility(ctx, op.to.teamId, true),
        )
      : moveVisibilityChange(src, dst);
    return why ? { why, pair: `${src.key} -> ${dst.key}` } : null;
  }
  if (op.op === "add-project-team") {
    const project = await readProject(ctx, op.target.id);
    const current = sortedStrings(project.teamIds);
    const added = sortedStrings(op.to.teamIds).filter((t) => !current.includes(t));
    if (added.length === 0 || current.length === 0) return null;
    const cur = await Promise.all(current.map((t) => readTeamVisibility(ctx, t, false)));
    if (!cur.every((t) => t.private)) return null;
    const add = await Promise.all(added.map((t) => readTeamVisibility(ctx, t, false)));
    const why = projectTeamAddVisibilityChange(cur, add);
    return why ? { why, pair: `${cur.map((t) => t.key).join("+")} -> ${add.map((t) => t.key).join("+")}` } : null;
  }
  return null;
}

export async function visibilityChange(ctx: OpCtx, op: ReorgOp): Promise<string | null> {
  return (await visibilityInfo(ctx, op))?.why ?? null;
}

/** LIVE count of source-team members who lose access through a private -> private move. */
async function accessLost(ctx: OpCtx, op: ReorgOp): Promise<number> {
  if (op.op !== "move-issue-team" || typeof op.to.teamId !== "string") return 0;
  const live = await readIssue(ctx, op.target.id);
  const srcId = typeof live.teamId === "string" ? live.teamId : op.from.teamId;
  if (typeof srcId !== "string" || srcId === op.to.teamId) return 0;
  const src = await readTeamVisibility(ctx, srcId, false);
  if (!src.private) return 0;
  const dst = await readTeamVisibility(ctx, op.to.teamId, false);
  if (!dst.private) return 0;
  return moveAccessLost(await readTeamVisibility(ctx, srcId, true), await readTeamVisibility(ctx, op.to.teamId, true));
}

/**
 * Refuse an op that changes visibility unless it carries allowVisibilityChange:
 * true. Returns the description of an ALLOWED change (so the caller can report
 * it), or null. Any failed read refuses: an unknown visibility is never public.
 */
export async function assertNoVisibilityChange(ctx: OpCtx, op: ReorgOp): Promise<string | null> {
  if (op.op !== "move-issue-team" && op.op !== "add-project-team") return null;
  const info = await visibilityInfo(ctx, op);
  if (!info) return null;
  if (op.allowVisibilityChange === true) return `${info.pair}: ${info.why}`;
  throw new Error(
    `seq ${op.seq} [${op.op}] ${op.target.identifier}: visibility change refused (${info.pair}): ${info.why}; ` +
      `set allowVisibilityChange: true on the rule to allow it`,
  );
}

/** Every workflow state with its owner link: inherited views are found by
 *  scanning (WorkflowStateFilter has no inheritedFrom comparator). */
const STATE_VIEWS_Q = /* GraphQL */ `
  query ReorgStateViews($first: Int!, $after: String) {
    workflowStates(first: $first, after: $after) {
      nodes { id name archivedAt inheritedFrom { id } team { id key } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Live inherited views of an owner state (archiving the owner archives all of
 *  them at once). Strict paging: a partial scan must not pass for complete. */
async function inheritedStateViews(ctx: OpCtx, ownerId: string): Promise<ReorgStateNode[]> {
  const all = await paged<ReorgStateNode>(
    ctx.client, ctx.pace, STATE_VIEWS_Q, "workflowStates", {}, undefined, true,
  );
  return all.filter((st) => st.inheritedFrom?.id === ownerId && st.archivedAt == null);
}

/** Workflow states inherit like labels: Linear archives an owner state together
 *  with every inherited view, and a view cannot be archived on its own. */
async function assertStateOwner(ctx: OpCtx, op: ReorgOp): Promise<void> {
  const live = await readState(ctx, op.target.id);
  if (live.inheritedFromId)
    throw new Error(
      `archive-state ${op.target.identifier}: inherited view (child of ${String(live.inheritedFromId)}) — act on the owner state`,
    );
}

/** A labelMap `created:<seq>` that names a create-team-label must target the
 *  move's destination team or its parent (workspace creates are fine anywhere).
 *  Reads only; throws naming both teams. `planned` is the plan's op list. */
async function assertLabelMapTeams(ctx: OpCtx, op: ReorgOp, planned: ReorgOp[]): Promise<void> {
  if (op.op !== "move-issue-team" || !hasLabelMap(op) || typeof op.to.teamId !== "string") return;
  let family: TeamFamily | null = null;
  for (const [src, ref] of Object.entries(op.to.labelMap as Record<string, unknown>)) {
    const r = String(ref);
    if (!r.startsWith(CREATED_REF_PREFIX)) continue;
    const create = planned.find((o) => o.seq === Number(r.slice(CREATED_REF_PREFIX.length)));
    if (!create || create.op !== "create-team-label") continue;
    family ??= await readTeamFamily(ctx, op.to.teamId);
    if (create.target.id !== op.to.teamId && create.target.id !== family.parentId)
      throw new Error(
        `seq ${op.seq} [move-issue-team] labelMap ${src} -> ${r}: create-team-label seq ${create.seq} targets team ` +
          `${create.target.identifier}, but the move's destination is ${family.key}` +
          `${family.parentKey ? ` (parent ${family.parentKey})` : ""} — the label must belong to the destination team or its parent`,
      );
  }
}

/** create-team-label: the name must be free across the destination team, its
 *  parent, its sub-teams and the workspace. `planned` (--check) lets a
 *  lower-seq planned rename-label count as freeing the name. */
async function assertCreateTeamLabelFree(ctx: OpCtx, op: ReorgOp, planned?: ReorgOp[]): Promise<void> {
  const name = String(op.to.name);
  const freed = planned ? plannedRenameFrees(planned, op.seq, name) : new Set<string>();
  const conflicts = await findLabelNameConflicts(ctx, op.target.id, name, freed);
  if (conflicts.length > 0)
    throw new Error(
      `seq ${op.seq} [create-team-label] "${name}": name taken by ${describeConflicts(conflicts)} ` +
        `(label names are unique across a team, its parent, its sub-teams and the workspace) — plan a rename-label with a lower seq first`,
    );
}

/** --check: the move op as apply will see it. created:<seq> refs resolve from
 *  the journal; a ref to a lower-seq PLANNED create becomes a `planned:<seq>`
 *  placeholder (not yet scope-checkable); anything else refuses. */
function withCheckResolvedLabelMap(op: ReorgOp, journal: JournalRecord[], planned: ReorgOp[]): ReorgOp {
  if (!hasLabelMap(op) || isRecord(op.to.labelMapResolved)) return op;
  const resolved: Record<string, string> = {};
  for (const [src, ref] of Object.entries(op.to.labelMap as Record<string, unknown>)) {
    const r = String(ref);
    try {
      resolved[src] = resolveCreatedRef(r, journal, op.seq);
    } catch (err) {
      const n = Number(r.slice(CREATED_REF_PREFIX.length));
      if (r.startsWith(CREATED_REF_PREFIX) && n < op.seq && planned.some((o) => o.seq === n && CREATE_LABEL_OPS.has(o.op))) {
        resolved[src] = `${PLANNED_REF_PREFIX}${n}`;
      } else {
        throw new Error(`seq ${op.seq} [move-issue-team] labelMap ${src} -> ${r}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { ...op, to: { ...op.to, labelMapResolved: resolved } };
}

const PLANNED_REF_PREFIX = "planned:";

/** Only empty states may be archived (plan §2c) — live read, refuse loudly
 *  instead of discovering Linear's refusal mid-phase. Archived issues count:
 *  they still reference the state. */
async function assertStateEmpty(ctx: OpCtx, op: ReorgOp): Promise<void> {
  await assertStateOwner(ctx, op);
  const views = await inheritedStateViews(ctx, op.target.id);
  if (views.length > 0) {
    ctx.onEvent?.({
      kind: "info",
      detail: `archive-state ${op.target.identifier}: will also archive ${views.length} inherited view(s): ${views
        .map((v) => `${v.team?.key ?? "?"}/${v.name}`)
        .join(", ")}`,
    });
    for (const v of views) {
      const dv = await reorgRaw<{ issues: { nodes: { id: string; identifier?: string }[] } }>(
        ctx.client, ISSUES_IN_STATE_Q, { id: v.id }, ctx.pace,
      );
      if (dv.issues.nodes.length > 0)
        throw new Error(
          `archive-state ${op.target.identifier}: inherited view ${v.team?.key ?? "?"}/${v.name} still holds issue(s) ` +
            `(${dv.issues.nodes.map((n) => n.identifier ?? n.id).join(", ")}) — move them first`,
        );
    }
  }
  const d = await reorgRaw<{ issues: { nodes: { id: string; identifier?: string; archivedAt?: string | null }[] } }>(
    ctx.client, ISSUES_IN_STATE_Q, { id: op.target.id }, ctx.pace,
  );
  const nodes = d.issues.nodes;
  if (nodes.length > 0) {
    const archived = nodes.filter((n) => n.archivedAt).map((n) => n.identifier ?? n.id);
    const note = archived.length
      ? ` (archived: ${archived.join(", ")}). Linear may allow archiving a state that holds only archived issues; the engine refuses conservatively`
      : "";
    throw new Error(
      `archive-state ${op.target.identifier}: ${nodes.length === 10 ? "10+" : nodes.length} issue(s) still in the state — move them first${note}`,
    );
  }
}

/** Live emptiness preconditions (plan §2c phase 6): 0 issues (archived
 *  included), 0 projects, 0 non-retired labels — read NOW, not from census. */
async function assertTeamEmpty(ctx: OpCtx, op: ReorgOp): Promise<void> {
  const issues = await reorgRaw<{ issues: { nodes: { id: string }[] } }>(
    ctx.client, TEAM_ISSUES_Q, { id: op.target.id }, ctx.pace,
  );
  if (issues.issues.nodes.length > 0)
    throw new Error(`delete-team ${op.target.identifier}: issues remain`);
  const labels = await paged<ReorgLabelNode>(
    ctx.client, ctx.pace, TEAM_LABELS_Q, "issueLabels", { id: op.target.id }, undefined, true,
  );
  const active = labels.filter((l) => l.retiredAt == null);
  if (active.length > 0)
    throw new Error(`delete-team ${op.target.identifier}: ${active.length} non-retired label(s) remain`);
  // Paginated, archived-inclusive — a team attached only to an archived
  // project (or past the first page) must still block the delete.
  const projects = await paged<{ id: string; teams: { nodes: { id: string }[] } }>(
    ctx.client, ctx.pace, TEAM_PROJECTS_Q, "projects", {}, undefined, true,
  );
  const member = projects.filter((p) => p.teams.nodes.some((t) => t.id === op.target.id));
  if (member.length > 0)
    throw new Error(`delete-team ${op.target.identifier}: ${member.length} project(s) still attached`);
}

/**
 * The reads an op's apply performs before its first write — also run by
 * --check, so a dry run surfaces what apply would refuse. READS ONLY; throws
 * with the refusal text. Skipped by the caller for ops whose live state
 * already equals the expected end state.
 */
export async function assertOpPreconditions(
  ctx: OpCtx,
  op: ReorgOp,
  journal: JournalRecord[],
  /** --check only: the whole plan, so planned lower-seq renames and creates count. */
  planned?: ReorgOp[],
): Promise<void> {
  if (op.op === "move-issue-team" && planned) {
    await assertLabelMapTeams(ctx, op, planned);
    op = withCheckResolvedLabelMap(op, journal, planned);
  }
  if (op.op === "relabel" || op.op === "move-issue-team") await assertNoInheritedWrites(ctx, op);
  if (op.op === "move-issue-team") await assertMovePreconditions(ctx, op, journal);
  await assertNoVisibilityChange(ctx, op);
  if (op.op === "create-team-label") await assertCreateTeamLabelFree(ctx, op, planned);
  if (op.op === "archive-state") await assertStateEmpty(ctx, op);
  if (op.op === "delete-team") await assertTeamEmpty(ctx, op);
}

// ---------------------------------------------------------------------------
// Compare helpers
// ---------------------------------------------------------------------------

export class ReorgMismatch extends Error {
  constructor(
    public readonly seq: number,
    public readonly diff: { expected: unknown; actual: unknown },
  ) {
    super(`op seq ${seq} verify mismatch: expected ${JSON.stringify(diff.expected)}, actual ${JSON.stringify(diff.actual)}`);
    this.name = "ReorgMismatch";
  }
}

/** Rollback refused before any write for this op (not a verify mismatch). */
export class RollbackRefused extends ReorgMismatch {
  constructor(seq: number, public readonly reason: string, diff: { expected: unknown; actual: unknown }) {
    super(seq, diff);
    this.message = `op seq ${seq} refused: ${reason}`;
  }
}

/** Keys of `expected` the live state fails to match (skips absent keys). */
function compareState(
  expected: Record<string, unknown>,
  live: Record<string, unknown>,
  keys: string[],
): string[] {
  const bad: string[] = [];
  for (const k of keys) {
    if (!(k in expected)) continue;
    if (JSON.stringify(expected[k]) !== JSON.stringify(live[k]))
      bad.push(`${k}: expected=${JSON.stringify(expected[k])} actual=${JSON.stringify(live[k])}`);
  }
  return bad;
}

/** Estimated request cost: pre-read + write + verify read per op; batch +1/batch. */
export function estimateRequests(ops: ReorgOp[]): number {
  const batchKeys = new Set<string>();
  let batched = 0;
  for (const o of ops) {
    if (o.batchKey) {
      batchKeys.add(o.batchKey);
      batched++;
    }
  }
  return (ops.length - batched) * 3 + batched + batchKeys.size * 2;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  phase?: number;
  apply: boolean;
  /** Dry-run PLUS a live drift pre-read of every target (no writes). */
  check?: boolean;
  resume: boolean;
  maxOps?: number;
  allowIrreversible: boolean;
  journalPath: string;
  /** Journals from earlier runs whose verify markers count for the phase gates
   *  (latest marker per phase wins across all journals). Read-only: their ops
   *  are never resumed, rolled back or written to. */
  priorJournalPaths?: string[];
  backupRecordPath?: string;
  pace: { bucket: TokenBucket; tracker: RateTracker };
  onEvent?: (ev: { kind: string; detail: string }) => void;
  /** Post-write verify re-read backoff in ms (default 500/1000/2000/4000). */
  verifyDelaysMs?: number[];
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  applied: number;
  skipped: number;
  dryRun: boolean;
  /** --check only: seqs whose live state drifted from `from`. */
  drifted: number[];
  /** --check / dry run: seqs apply would refuse (precondition reads or plan shape). */
  refused: number[];
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AppliedCheck {
  applied: boolean;
  /** move-issue-team only: the issue sits in the destination team. */
  cascade?: boolean;
  /** Why a move in the destination team is NOT already applied. */
  reason?: string;
}

const sameSet = (a: string[], b: string[]) => JSON.stringify(sortedStrings(a)) === JSON.stringify(sortedStrings(b));

/**
 * move-issue-team: moving a parent issue moves its sub-issues (same source
 * team) with it, so a later move of such a child finds it already in the
 * destination. That counts as applied only when the live issue equals the op's
 * FULL planned end state: team, project membership, destination state, and the
 * exact label set the apply path would have sent (computed from the recorded
 * source labels, because the live labels are post-move).
 */
async function moveAlreadyApplied(
  ctx: OpCtx,
  op: ReorgOp,
  live: Record<string, unknown>,
): Promise<AppliedCheck> {
  if (typeof op.to.teamId !== "string" || live.teamId !== op.to.teamId) return { applied: false };
  const no = (reason: string): AppliedCheck => ({
    applied: false,
    reason: `the issue is already in the destination team (likely moved by a parent's cascade) but ${reason}`,
  });
  if (typeof op.to.stateId !== "string") return no("the op has no to.stateId to confirm the end state against");
  if (live.stateId !== op.to.stateId)
    return no(`its state differs from the planned end state: expected=${JSON.stringify(op.to.stateId)} actual=${JSON.stringify(live.stateId)}`);
  const project = op.from.projectId ?? null;
  if ((live.projectId ?? null) !== project)
    return no(`its project membership did not survive: expected=${JSON.stringify(project)} actual=${JSON.stringify(live.projectId ?? null)}`);
  let want: string[];
  if (Array.isArray(op.to.labelIdsComputed)) want = sortedStrings(op.to.labelIdsComputed);
  else if (Array.isArray(op.from.labelIds)) want = await computeMoveLabelSet(ctx, op, sortedStrings(op.from.labelIds));
  else return no("no source labels were recorded to compute the expected label set from");
  const got = sortedStrings(live.labelIds);
  if (!sameSet(got, want)) {
    const missing = want.filter((l) => !got.includes(l));
    const extra = got.filter((l) => !want.includes(l));
    return no(
      `its labels differ from the planned set: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(extra)}`,
    );
  }
  return { applied: true, cascade: true };
}

/** True when `live` already equals the op's expected end state. Never vacuous:
 *  the expected state must constrain at least one compared key. A
 *  move-issue-team needs the full end state (see moveAlreadyApplied). */
async function isAlreadyApplied(
  ctx: OpCtx,
  def: OpDef,
  op: ReorgOp,
  live: Record<string, unknown>,
): Promise<AppliedCheck> {
  if (op.op === "move-issue-team") return moveAlreadyApplied(ctx, op, live);
  const expected = def.expectedPost(op);
  if (expected === null) return { applied: false };
  if (!def.compareKeys.some((k) => k in expected)) return { applied: false };
  return { applied: compareState(expected, live, def.compareKeys).length === 0 };
}

/** Re-read until the state matches `expected`, backing off between reads. */
async function readUntilMatches(
  ctx: OpCtx,
  def: OpDef,
  op: ReorgOp,
  expected: Record<string, unknown>,
  first?: Record<string, unknown>,
): Promise<{ live: Record<string, unknown>; bad: string[] }> {
  const delays = ctx.verifyDelaysMs ?? DEFAULT_VERIFY_DELAYS_MS;
  const sleep = ctx.sleep ?? realSleep;
  let live = first ?? (await def.readState(ctx, op));
  let bad = compareState(expected, live, def.compareKeys);
  for (let n = 0; bad.length && n < delays.length; n++) {
    ctx.onEvent?.({
      kind: "verify-retry",
      detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: post-write read differs; retry ${n + 1}/${delays.length} in ${delays[n]}ms`,
    });
    await sleep(delays[n]);
    live = await def.readState(ctx, op);
    bad = compareState(expected, live, def.compareKeys);
  }
  return { live, bad };
}

/** Re-read an issue's labels (with the read-lag backoff) until they equal
 *  `want`; returns the last labels seen. */
async function readLabelsUntil(
  ctx: OpCtx,
  op: ReorgOp,
  want: string[],
  first: Record<string, unknown>,
): Promise<string[]> {
  const delays = ctx.verifyDelaysMs ?? DEFAULT_VERIFY_DELAYS_MS;
  const sleep = ctx.sleep ?? realSleep;
  let got = sortedStrings(first.labelIds);
  for (let n = 0; JSON.stringify(got) !== JSON.stringify(want) && n < delays.length; n++) {
    ctx.onEvent?.({
      kind: "verify-retry",
      detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: labels differ after write; retry ${n + 1}/${delays.length} in ${delays[n]}ms`,
    });
    await sleep(delays[n]);
    got = sortedStrings((await readIssue(ctx, op.target.id)).labelIds);
  }
  return got;
}

/** Ops whose end state needs an id the write returns: a failed write cannot be
 *  verified by re-reading, so a write error is never accepted for them. */
const WRITE_ERROR_UNVERIFIABLE = new Set<string>([...CREATE_LABEL_OPS, "create-project-status"]);

/** After `def.apply` threw: did the planned end state land anyway? Only true
 *  when the end state is knowable without the write's output and a re-read
 *  (with the read-lag backoff) shows it. Any re-read failure means false. */
async function writeErrorLanded(
  ctx: OpCtx,
  def: OpDef,
  op: ReorgOp,
  liveBefore: Record<string, unknown>,
): Promise<boolean> {
  if (WRITE_ERROR_UNVERIFIABLE.has(op.op)) return false;
  const expected = def.expectedPost(op);
  try {
    if (expected === null) {
      // delete forms: only a not-found on the re-read counts as gone
      try {
        await def.readState(ctx, op);
      } catch (e) {
        return /not found/i.test(e instanceof Error ? e.message : String(e));
      }
      return false;
    }
    if (!def.compareKeys.some((k) => k in expected)) return false;
    // A no-op op (end state == pre-state) cannot show that the write landed.
    if (compareState(expected, liveBefore, def.compareKeys).length === 0) return false;
    const r = await readUntilMatches(ctx, def, op, expected);
    return r.bad.length === 0;
  } catch {
    return false;
  }
}

/** One op end-to-end: drift pre-read → preconditions → write → expected-state
 *  verify (never vacuous) → journal. Shared by runPlan and rollbackPhase. */
async function executeOne(
  ctx: OpCtx,
  op: ReorgOp,
  journal: JournalRecord[],
  journalPath: string,
): Promise<"applied" | "already-applied"> {
  // 0. resolve name: label refs (journal-created ids first, then live lookup)
  op = await resolveOpLabelRefs(ctx, journal, op);
  const def = OP_REGISTRY[op.op];

  // 1. live pre-read + drift check (scoped to the op's read coverage)
  const liveBefore = await def.readState(ctx, op);
  const drift = compareState(op.from, liveBefore, def.compareKeys);
  if (drift.length) {
    const done = await isAlreadyApplied(ctx, def, op, liveBefore);
    if (done.applied) {
      // An earlier write landed but was never journaled (or a parent's move
      // carried this issue along): record it, write nothing.
      const rec: JournalRecord = {
        seq: op.seq,
        phase: op.phase,
        op: op.op,
        original: op,
        before: op.from,
        after: liveBefore,
        at: new Date().toISOString(),
        ok: true,
        alreadyApplied: true,
        ...(done.cascade ? { cascade: true } : {}),
      };
      journalAppend(journalPath, rec);
      journal.push(rec);
      ctx.onEvent?.({
        kind: "already-applied",
        detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: live state already equals the expected end state; journaled, no write`,
      });
      return "already-applied";
    }
    const mismatch = new ReorgMismatch(op.seq, {
      expected: pick(op.from, def.compareKeys),
      actual: pick(liveBefore, def.compareKeys),
    });
    if (done.reason) mismatch.message += ` — ${done.reason}`;
    throw mismatch;
  }

  // 2. op-specific preconditions (live reads)
  if (op.target.type === "state" && liveBefore.inheritedFromId)
    throw new Error(
      `seq ${op.seq} [${op.op}]: target ${op.target.identifier} is an inherited state view ` +
        `(child of ${String(liveBefore.inheritedFromId)}) — act on the owner state`,
    );
  if (op.target.type === "label" && liveBefore.inheritedFromId)
    throw new Error(
      `seq ${op.seq} [${op.op}]: target ${op.target.identifier} is an inherited label ` +
        `(child of ${String(liveBefore.inheritedFromId)}) — Linear refuses writes on it; target the owner`,
    );
  if (op.op === "relabel" || op.op === "move-issue-team")
    await assertNoInheritedWrites(ctx, op);
  if (op.op === "move-issue-team") await assertMovePreconditions(ctx, op, journal);
  const allowedVis = await assertNoVisibilityChange(ctx, op);
  if (allowedVis)
    ctx.onEvent?.({
      kind: "visibility",
      detail: `visibility change (allowed) seq ${op.seq} [${op.op}] ${op.target.identifier}: ${allowedVis}`,
    });
  if (op.op === "create-team-label") await assertCreateTeamLabelFree(ctx, op);

  // 3. write. A thrown error is not proof the write failed (seen live: an
  // error reply after the end state had landed): re-read and accept an
  // applied end state; otherwise rethrow the original error unchanged.
  let writeError: string | undefined;
  try {
    await def.apply(ctx, op);
  } catch (err) {
    if (!(await writeErrorLanded(ctx, def, op, liveBefore))) throw err;
    writeError = err instanceof Error ? err.message : String(err);
    ctx.onEvent?.({
      kind: "write-error-applied",
      detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: write returned an error (${writeError}) but a re-read shows the expected end state; accepted`,
    });
  }

  // 4. expected end state vs a fresh re-read
  const expected = def.expectedPost(op);
  let liveAfter: Record<string, unknown> | null = null;
  if (expected === null) {
    // delete forms: the re-read must FAIL
    let present = false;
    try {
      await def.readState(ctx, op);
      present = true;
    } catch {
      // gone, as required
    }
    if (present)
      throw new ReorgMismatch(op.seq, { expected: "absent", actual: "still present" });
  } else {
    const r = await readUntilMatches(ctx, def, op, expected);
    liveAfter = r.live;
    if (r.bad.length)
      throw new ReorgMismatch(op.seq, {
        expected: pick(expected, def.compareKeys),
        actual: pick(liveAfter, def.compareKeys),
      });
  }

  // 5. move-issue-team post-checks: labels re-applied; destination state
  if (op.op === "move-issue-team" && liveAfter) {
    if (Array.isArray(op.to.labelIdsComputed)) {
      // labelMap move: the issue must carry EXACTLY the computed set
      const want = sortedStrings(op.to.labelIdsComputed);
      const got = await readLabelsUntil(ctx, op, want, liveAfter);
      if (JSON.stringify(got) !== JSON.stringify(want))
        throw new ReorgMismatch(op.seq, { expected: { labelIds: want }, actual: { labelIds: got } });
      liveAfter.labelIds = got;
    }
    const reapply = sortedStrings(op.to.reapplyLabelIds);
    const afterLabels = sortedStrings(liveAfter.labelIds);
    const missing = reapply.filter((l) => !afterLabels.includes(l));
    if (missing.length)
      throw new ReorgMismatch(op.seq, {
        expected: { reapplyLabelIds: reapply },
        actual: { labelIds: afterLabels, missing },
      });
    if (typeof op.to.stateId === "string" && liveAfter.stateId !== op.to.stateId) {
      // (c) state didn't land at the mapped destination — separate verified
      // set-state to the DESTINATION state (never the source's from.stateId)
      const fix: ReorgOp = {
        ...op,
        op: "set-state",
        from: { stateId: liveAfter.stateId },
        to: { stateId: op.to.stateId },
        evidence: `post-move destination-state correction for seq ${op.seq}`,
      };
      await OP_REGISTRY["set-state"].apply(ctx, fix);
      const fixed = await readIssue(ctx, op.target.id);
      if (fixed.stateId !== op.to.stateId)
        throw new ReorgMismatch(op.seq, {
          expected: { stateId: op.to.stateId },
          actual: { stateId: fixed.stateId },
        });
      liveAfter.stateId = op.to.stateId;
    }
  }

  // 6. journal (fsync) — carries the original op for rollback + cross-refs
  const rec: JournalRecord = {
    seq: op.seq,
    phase: op.phase,
    op: op.op,
    original: op,
    before: liveBefore,
    after: liveAfter ?? { absent: true },
    at: new Date().toISOString(),
    ok: true,
    ...(writeError !== undefined ? { writeErrorButApplied: true, writeError } : {}),
  };
  journalAppend(journalPath, rec);
  journal.push(rec);
  return "applied";
}

const BATCHABLE_OPS = new Set<string>(["relabel", "set-state"]);
const BATCH_MAX = 50;

/** The apply-time grouping, exactly: CONSECUTIVE ops with the same batchKey
 *  and op kind (relabel / set-state only), at most 50 per group. Every other
 *  op, and a lone batchable op, is a group of one (sequential path). Pure. */
export function batchGroups(ops: ReorgOp[]): ReorgOp[][] {
  const groups: ReorgOp[][] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    const group: ReorgOp[] = [op];
    i++;
    if (op.batchKey && BATCHABLE_OPS.has(op.op)) {
      while (
        i < ops.length &&
        ops[i].batchKey === op.batchKey &&
        ops[i].op === op.op &&
        group.length < BATCH_MAX
      ) {
        group.push(ops[i]);
        i++;
      }
    }
    groups.push(group);
  }
  return groups;
}

export interface MixedBatchGroup {
  key: string;
  seqs: number[];
  /** members whose raw `to` differs from the first member's */
  differing: number[];
}

/** Multi-member groups whose members' raw `to` are not all identical: the
 *  groups runBatch would throw on. Raw JSON, before any `name:` resolution,
 *  the same comparison runBatch makes. Pure. */
export function mixedBatchGroups(ops: ReorgOp[]): MixedBatchGroup[] {
  const out: MixedBatchGroup[] = [];
  for (const g of batchGroups(ops)) {
    if (g.length < 2) continue;
    const shape = JSON.stringify(g[0].to);
    const differing = g.filter((o) => JSON.stringify(o.to) !== shape).map((o) => o.seq);
    if (differing.length > 0)
      out.push({ key: String(g[0].batchKey), seqs: g.map((o) => o.seq), differing });
  }
  return out;
}

function mixedGroupRange(m: MixedBatchGroup): string {
  return `seq ${Math.min(...m.seqs)}..${Math.max(...m.seqs)}`;
}

function mixedGroupFinding(m: MixedBatchGroup): string {
  return `${mixedGroupRange(m)} batchKey ${m.key}: non-identical input at seq(s) ${m.differing.join(", ")}`;
}

export async function runPlan(
  client: LinearClient,
  plan: ReorgPlan,
  opts: ApplyOptions,
): Promise<RunResult> {
  let ops = plan.ops;
  if (opts.phase !== undefined) ops = ops.filter((o) => o.phase === opts.phase);

  const journal = journalRead(opts.journalPath);
  const done = opts.resume ? journalOkSeqs(journal) : new Set<number>();

  // resume-skip BEFORE the --max-ops slice, so a capped resume keeps advancing
  let skipped = 0;
  if (opts.resume) {
    const remaining: ReorgOp[] = [];
    for (const o of ops) {
      if (done.has(o.seq)) skipped++;
      else remaining.push(o);
    }
    ops = remaining;
  }
  if (opts.maxOps !== undefined) ops = ops.slice(0, opts.maxOps);

  const ctx: OpCtx = {
    client,
    pace: opts.pace,
    verifyDelaysMs: opts.verifyDelaysMs,
    sleep: opts.sleep,
    onEvent: opts.onEvent,
    priorMarkers: loadPriorMarkers(opts.priorJournalPaths),
  };

  // --check: dry-run PLUS a live drift pre-read per target; no writes.
  if (opts.check && !opts.apply) {
    const drifted: number[] = [];
    const refused: number[] = [];
    for (const op of ops) {
      const def = OP_REGISTRY[op.op];
      try {
        const live = await def.readState(ctx, op);
        if (op.target.type === "label" && live.inheritedFromId) {
          drifted.push(op.seq);
          opts.onEvent?.({
            kind: "drift",
            detail: `DRIFT seq ${op.seq} [${op.op}] ${op.target.identifier}: inherited label (child of ${String(live.inheritedFromId)}) — target the owner`,
          });
          continue;
        }
        const drift = compareState(op.from, live, def.compareKeys);
        const done = drift.length
          ? await isAlreadyApplied(ctx, def, await resolveOpLabelRefs(ctx, journal, op), live)
          : { applied: false };
        if (drift.length && done.applied) {
          opts.onEvent?.({
            kind: "check",
            detail: `already applied seq ${op.seq} [${op.op}] ${op.target.identifier}`,
          });
        } else if (drift.length) {
          drifted.push(op.seq);
          opts.onEvent?.({
            kind: "drift",
            detail: `DRIFT seq ${op.seq} [${op.op}] ${op.target.identifier}: ${drift.join("; ")}${"reason" in done && done.reason ? ` — ${done.reason}` : ""}`,
          });
        } else {
          // precondition READS apply would run before its first write: a
          // refusal here is its own finding class, distinct from drift
          try {
            await assertOpPreconditions(ctx, op, journal, plan.ops);
          } catch (err) {
            refused.push(op.seq);
            opts.onEvent?.({
              kind: "refuse",
              detail: `REFUSE seq ${op.seq} [${op.op}] ${op.target.identifier}: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
          opts.onEvent?.({ kind: "check", detail: `ok    seq ${op.seq} [${op.op}] ${op.target.identifier}` });
          const lost = await accessLost(ctx, op);
          if (lost > 0)
            opts.onEvent?.({
              kind: "check",
              detail: `info seq ${op.seq} [${op.op}] ${op.target.identifier}: ${lost} source member(s) lose access`,
            });
          if (op.allowVisibilityChange === true) {
            const why = await visibilityChange(ctx, op);
            if (why)
              opts.onEvent?.({
                kind: "check",
                detail: `visibility change (allowed) seq ${op.seq} [${op.op}] ${op.target.identifier}: ${why}`,
              });
          }
        }
      } catch (err) {
        drifted.push(op.seq);
        const msg = err instanceof Error ? err.message : String(err);
        // a name: ref that resolves to nothing because its create is planned
        // earlier in this plan and has not run: say so (still drift)
        let why = "";
        const unresolved = /labelRef "name:(.*)" resolves to nothing/.exec(msg);
        if (unresolved) {
          const pending = plan.ops.find(
            (o) =>
              o.op === "create-workspace-label" && o.seq < op.seq &&
              String(o.to.name) === unresolved[1] &&
              !journal.some((r) => r.ok && r.seq === o.seq),
          );
          if (pending)
            why = ` — ref "name:${unresolved[1]}" is unresolved because the planned create-workspace-label at seq ${pending.seq} has not run yet`;
        }
        opts.onEvent?.({
          kind: "drift",
          detail: `DRIFT seq ${op.seq} [${op.op}] ${op.target.identifier}: read failed: ${msg}${why}`,
        });
      }
    }
    // plan shape: apply refuses a mixed batch group, so check must too
    const mixed = mixedBatchGroups(ops);
    for (const m of mixed) {
      for (const q of m.seqs) if (!refused.includes(q)) refused.push(q);
      opts.onEvent?.({
        kind: "refuse",
        detail: `REFUSE ${mixedGroupFinding(m)} — apply refuses this group; give each distinct input its own batchKey`,
      });
    }
    // create-conflict preflight: a create-workspace-label fails at Linear if
    // ANY label (any scope) still carries the name. Planned rename-label ops
    // clear their targets' names, so they don't count as conflicts.
    for (const op of ops.filter((o) => o.op === "create-workspace-label")) {
      const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
        ctx.client, LABELS_BY_NAME_CI_Q, { name: op.to.name }, ctx.pace,
      );
      // Only a LOWER-seq rename to a DIFFERENT name frees (same rule as
      // create-team-label); the rename clears its target AND, by
      // propagation, every inherited child of that target.
      const freed = plannedRenameFrees(ops, op.seq, String(op.to.name));
      const conflicts = d.issueLabels.nodes.filter(
        (l) => !freed.has(l.id) && !(l.inheritedFrom && freed.has(l.inheritedFrom.id)),
      );
      if (conflicts.length > 0) {
        drifted.push(op.seq);
        opts.onEvent?.({
          kind: "drift",
          detail: `DRIFT seq ${op.seq} [create-workspace-label] "${String(op.to.name)}": name still taken by ${conflicts
            .map((l) => `${l.id}${l.team ? ` (team ${l.team.key})` : " (workspace)"}`)
            .join(", ")} — plan a rename-label first`,
        });
      }
    }
    opts.onEvent?.({
      kind: "budget",
      detail: `check: ${ops.length} op(s) pre-read live, ${drifted.length} drifted, ${refused.length} would be refused`,
    });
    return { applied: 0, skipped, dryRun: true, drifted, refused };
  }

  if (!opts.apply) {
    const dryRefused: number[] = [];
    for (const m of mixedBatchGroups(ops)) {
      for (const q of m.seqs) if (!dryRefused.includes(q)) dryRefused.push(q);
      opts.onEvent?.({
        kind: "refuse",
        detail: `REFUSE ${mixedGroupFinding(m)} — apply refuses this group; give each distinct input its own batchKey`,
      });
    }
    for (const op of ops) {
      const irreversibleNote = op.reversible
        ? ""
        : ` (IRREVERSIBLE, approval ${op.approval ?? "—"})`;
      opts.onEvent?.({
        kind: "dry",
        detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: ${JSON.stringify(op.from)} → ${JSON.stringify(op.to)}${irreversibleNote}`,
      });
      if (op.op === "archive-state") {
        // read-only: an owner state takes its inherited views with it
        try {
          const views = await inheritedStateViews(ctx, op.target.id);
          if (views.length > 0)
            opts.onEvent?.({
              kind: "info",
              detail: `  seq ${op.seq} archive-state ${op.target.identifier}: will also archive ${views.length} inherited view(s): ${views
                .map((v) => `${v.team?.key ?? "?"}/${v.name}`)
                .join(", ")}`,
            });
        } catch (err) {
          opts.onEvent?.({ kind: "info", detail: `  seq ${op.seq} archive-state: inherited-view lookup failed (${err instanceof Error ? err.message : String(err)})` });
        }
      }
    }
    opts.onEvent?.({
      kind: "budget",
      detail: `${ops.length} op(s), ≈${estimateRequests(ops)} request(s) at ${REORG_RATE_PER_HOUR}/h pace (add --check for a live drift pre-read)`,
    });
    return { applied: 0, skipped, dryRun: true, drifted: [], refused: dryRefused };
  }

  if (!opts.backupRecordPath)
    throw new Error("--apply requires --backup-record <path to backup.verified.json>");
  assertFreshBackup(opts.backupRecordPath);

  const irreversible = ops.filter((o) => !o.reversible);
  if (irreversible.length && !opts.allowIrreversible)
    throw new Error(
      `${irreversible.length} irreversible op(s) in scope (seq ${irreversible
        .map((o) => o.seq)
        .join(", ")}); ` +
        `re-run with --allow-irreversible after the deck approvals are confirmed`,
    );

  // Before ANY write: a labelMap that points at a create in the wrong team is a
  // plan defect, and the create (an earlier op) must not land for it.
  for (const m of plan.ops) await assertLabelMapTeams(ctx, m, plan.ops);
  // Same gate for plan shape: a mixed batch group would throw mid-run in
  // runBatch, after earlier groups already wrote. Group on the SLICED ops.
  const mixedGroups = mixedBatchGroups(ops);
  if (mixedGroups.length > 0)
    throw new Error(
      `refused before any write: ${mixedGroups.map(mixedGroupFinding).join("; ")}; give each distinct input its own batchKey`,
    );

  let applied = 0;
  for (const group of batchGroups(ops)) {
    if (group.length > 1) {
      await runBatch(ctx, group, opts, journal);
      applied += group.length;
      continue;
    }
    // single member — sequential path
    const op = group[0];
    const outcome = await executeOne(ctx, op, journal, opts.journalPath);
    applied++;
    opts.onEvent?.({
      kind: "applied",
      detail: `seq ${op.seq} [${op.op}] ${op.target.identifier} ${outcome === "already-applied" ? "ok (already applied)" : "ok"}`,
    });
  }
  return { applied, skipped, dryRun: false, drifted: [], refused: [] };
}

async function runBatch(
  ctx: OpCtx,
  group: ReorgOp[],
  opts: ApplyOptions,
  journal: JournalRecord[],
): Promise<void> {
  const first = group[0];
  // identical input across the group is a planner guarantee; assert it here
  const shape = JSON.stringify(first.to);
  for (const o of group)
    if (JSON.stringify(o.to) !== shape)
      throw new Error(`batchKey ${first.batchKey}: non-identical input at seq ${o.seq}`);

  // drift-check every member before the single write (refs resolved first)
  const befores = new Map<number, Record<string, unknown>>();
  const resolvedGroup: ReorgOp[] = [];
  const alreadyApplied = new Set<number>();
  for (const raw of group) {
    const op = await resolveOpLabelRefs(ctx, journal, raw);
    resolvedGroup.push(op);
    const def = OP_REGISTRY[op.op];
    const live = await def.readState(ctx, op);
    const drift = compareState(op.from, live, def.compareKeys);
    if (drift.length) {
      if (!(await isAlreadyApplied(ctx, def, op, live)).applied)
        throw new ReorgMismatch(op.seq, {
          expected: pick(op.from, def.compareKeys),
          actual: pick(live, def.compareKeys),
        });
      alreadyApplied.add(op.seq);
      ctx.onEvent?.({
        kind: "already-applied",
        detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: live state already equals the expected end state; excluded from the batch write`,
      });
    }
    befores.set(op.seq, live);
  }
  group = resolvedGroup;
  const toWrite = group.filter((o) => !alreadyApplied.has(o.seq));

  const resolvedFirst = resolvedGroup[0];
  const input: Record<string, unknown> =
    resolvedFirst.op === "set-state"
      ? { stateId: resolvedFirst.to.stateId }
      : { addedLabelIds: resolvedFirst.to.add ?? [], removedLabelIds: resolvedFirst.to.remove ?? [] };

  if (toWrite.length > 0)
    await reorgRaw(
      ctx.client,
      M.batchUpdate,
      { ids: toWrite.map((o) => o.target.id), input },
      ctx.pace,
    );

  // one filtered verify read for the whole batch (re-read with backoff while
  // any written member still differs: the read API can lag the write)
  interface BatchVerifyNode {
    id: string;
    state?: { id: string } | null;
    labels?: { nodes: { id: string }[] } | null;
  }
  const evaluate = (byId: Map<string, BatchVerifyNode>) => {
    const out = new Map<number, { actual: Record<string, unknown>; bad: string[]; expected: Record<string, unknown> | null }>();
    for (const op of toWrite) {
      const def = OP_REGISTRY[op.op];
      const n = byId.get(op.target.id);
      const actual: Record<string, unknown> = n
        ? {
            stateId: n.state?.id ?? null,
            labelIds: (n.labels?.nodes ?? []).map((l) => l.id).sort(),
          }
        : {};
      const expected = def.expectedPost(op);
      const bad: string[] = [];
      if (!n) {
        bad.push("missing from verify read");
      } else if (expected) {
        for (const k of def.compareKeys) {
          if (!(k in expected)) continue;
          if (JSON.stringify(expected[k]) !== JSON.stringify(actual[k]))
            bad.push(`${k}: expected=${JSON.stringify(expected[k])} actual=${JSON.stringify(actual[k])}`);
        }
      }
      out.set(op.seq, { actual, bad, expected });
    }
    return out;
  };
  const readBatch = async () => {
    const d = await reorgRaw<{ issues: { nodes: BatchVerifyNode[] } }>(
      ctx.client,
      `query ReorgBatchVerify($ids: [ID!]!) {
      issues(filter: { id: { in: $ids } }, includeArchived: true) {
        nodes { id state { id } labels { nodes { id } } }
      }
    }`,
      { ids: toWrite.map((o) => o.target.id) },
      ctx.pace,
    );
    return evaluate(new Map(d.issues.nodes.map((n) => [n.id, n])));
  };
  let results = new Map<number, { actual: Record<string, unknown>; bad: string[]; expected: Record<string, unknown> | null }>();
  if (toWrite.length > 0) {
    const delays = ctx.verifyDelaysMs ?? DEFAULT_VERIFY_DELAYS_MS;
    const sleep = ctx.sleep ?? realSleep;
    results = await readBatch();
    for (let n = 0; n < delays.length && [...results.values()].some((r) => r.bad.length); n++) {
      ctx.onEvent?.({
        kind: "verify-retry",
        detail: `batch ${String(first.batchKey)}: ${[...results.values()].filter((r) => r.bad.length).length} member(s) differ after the write; retry ${n + 1}/${delays.length} in ${delays[n]}ms`,
      });
      await sleep(delays[n]);
      results = await readBatch();
    }
  }

  // Journal EVERY member from the verify read — ok members with their actual
  // after state, the mismatching one marked ok:false — THEN stop. A mid-batch
  // mismatch never leaves writes unjournaled (resume/rollback depend on it).
  const failures: { op: ReorgOp; why: string; expected: unknown; actual: unknown }[] = [];
  for (const op of group) {
    const def = OP_REGISTRY[op.op];
    if (alreadyApplied.has(op.seq)) {
      const rec: JournalRecord = {
        seq: op.seq,
        phase: op.phase,
        op: op.op,
        original: op,
        before: op.from,
        after: befores.get(op.seq),
        at: new Date().toISOString(),
        ok: true,
        alreadyApplied: true,
      };
      journalAppend(opts.journalPath, rec);
      journal.push(rec);
      continue;
    }
    const { actual, bad, expected } = results.get(op.seq)!;
    const rec: JournalRecord = {
      seq: op.seq,
      phase: op.phase,
      op: op.op,
      original: op,
      before: befores.get(op.seq),
      after: actual,
      at: new Date().toISOString(),
      ok: bad.length === 0,
      ...(bad.length ? { error: bad.join("; ") } : {}),
    };
    journalAppend(opts.journalPath, rec);
    journal.push(rec);
    if (bad.length)
      failures.push({
        op,
        why: bad.join("; "),
        expected: expected ? pick(expected, def.compareKeys) : null,
        actual,
      });
  }
  if (failures.length) {
    const f = failures[0];
    throw new ReorgMismatch(f.op.seq, { expected: f.expected, actual: f.actual });
  }
}

// ---------------------------------------------------------------------------
// Verify — per-phase: journal completeness + live re-check of expected state
// ---------------------------------------------------------------------------

/** The label a create op made: journaled id first, then the (lower-cased) name. */
function createdLabel(eff: ReorgOp, rec: JournalRecord | undefined): { id: string | null; name: string } {
  const afterId = (rec?.after as Record<string, unknown> | undefined)?.labelId;
  const id = typeof eff.to.labelId === "string" ? eff.to.labelId : typeof afterId === "string" ? afterId : null;
  return { id, name: String(eff.to.name ?? "").toLowerCase() };
}

/**
 * After-the-fact verification compares an op's expected end state to the
 * live target, so an earlier op whose key a later applied op changed again
 * would always read as failed. Returns, for one op, the compared keys that a
 * LATER op (seq order) journaled ok has superseded, with the superseding seq.
 * Candidates are every ok journal row (deduped by seq), not only the plan's
 * ops. Superseding is per (target type, target id, key): an archive
 * supersedes only the keys it sets, and only a delete (target gone)
 * supersedes every key. A create's identity is the created label, not its
 * container: only a later rename, retire or delete of THAT label supersedes
 * it, never another create in the same team. A later op in a different phase
 * counts only when that phase's latest verify marker is green.
 */
function supersededKeys(
  op: ReorgOp,
  keys: string[],
  rec: JournalRecord | undefined,
  later: { op: ReorgOp; rec: JournalRecord | undefined }[],
  phase: number,
  phaseGreen: (phase: number) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  const isCreate = op.op === "create-team-label" || op.op === "create-workspace-label";
  const made = isCreate ? createdLabel(op, rec) : null;
  for (const { op: eff } of later) {
    if (eff.seq <= op.seq) continue;
    if (eff.phase !== phase && !phaseGreen(eff.phase)) continue;
    const ldef = OP_REGISTRY[eff.op];
    const lexp = ldef.expectedPost(eff);
    if (made) {
      if (eff.target.type !== "label") continue;
      const tail = eff.target.identifier.split("/").pop()?.toLowerCase();
      const same = made.id !== null ? eff.target.id === made.id : tail === made.name;
      if (!same) continue;
      const gone = lexp === null || eff.op === "rename-label" || (eff.op === "retire-or-delete-label" && lexp.retired === true);
      if (gone && keys.includes("labelId") && !out.has("labelId")) out.set("labelId", eff.seq);
      continue;
    }
    if (eff.target.type !== op.target.type || eff.target.id !== op.target.id) continue;
    for (const k of keys) {
      if (out.has(k)) continue;
      if (lexp === null || (ldef.compareKeys.includes(k) && k in lexp)) out.set(k, eff.seq);
    }
  }
  return out;
}

export async function verifyPhase(
  client: LinearClient,
  plan: ReorgPlan,
  phase: number,
  opts: {
    journalPath: string;
    pace: ApplyOptions["pace"];
    reportPath?: string;
    /** Earlier journals whose verify markers feed `gateGreen` (read-only). */
    priorJournalPaths?: string[];
  },
): Promise<{ ok: boolean; failures: string[]; gateGreen: boolean; superseded: string[] }> {
  const ops = plan.ops.filter((o) => o.phase === phase);
  const journal = journalRead(opts.journalPath);
  const okSeqs = journalOkSeqs(journal);
  const bySeq = new Map<number, JournalRecord>();
  for (const r of journal) if (typeof r.seq === "number") bySeq.set(r.seq, r);
  const failures: string[] = [];
  const superseded: string[] = [];
  const ctx: OpCtx = { client, pace: opts.pace };
  // Supersede candidates: every ok journal row (a later op may come from a
  // different plan file), deduped by seq, last row wins.
  const okRows = new Map<number, JournalRecord>();
  for (const r of journal) if (r.ok && typeof r.seq === "number") okRows.set(r.seq, r);
  const later: { op: ReorgOp; rec: JournalRecord | undefined }[] = [];
  for (const [seq, r] of okRows) {
    const o = r.original ?? plan.ops.find((p) => p.seq === seq);
    if (o) later.push({ op: o, rec: r });
  }
  const priorMarkers = loadPriorMarkers(opts.priorJournalPaths);
  const phaseGreen = (ph: number) => journalPhaseVerifiedAcross(priorMarkers, journal, ph);

  for (const op of ops) {
    const rec = bySeq.get(op.seq);
    if (!rec || !okSeqs.has(op.seq)) {
      failures.push(`seq ${op.seq} [${op.op}] ${op.target.identifier}: no ok journal entry`);
      continue;
    }
    // The journaled original carries any executor-resolved fields (created ids)
    const effective = rec.original ?? op;
    const def = OP_REGISTRY[effective.op];
    const expected = def.expectedPost(effective);
    // move-issue-team's destination state is enforced here (the executor's
    // correction owns it during apply; by verify time it must BE there)
    if (expected && effective.op === "move-issue-team" && typeof effective.to.stateId === "string")
      expected.stateId = effective.to.stateId;
    let checkKeys = def.compareKeys;
    if (expected !== null) {
      const sup = supersededKeys(effective, def.compareKeys.filter((k) => k in expected), rec, later, phase, phaseGreen);
      if (sup.size) {
        checkKeys = def.compareKeys.filter((k) => !sup.has(k));
        const by = [...new Set(sup.values())].sort((a, b) => a - b).join(", ");
        superseded.push(
          `seq ${op.seq} [${op.op}] ${op.target.identifier}: ${[...sup.keys()].join(", ")} superseded by seq ${by}`,
        );
        // every compared key superseded: nothing left to check live
        if (!def.compareKeys.some((k) => k in expected && !sup.has(k))) continue;
      }
    }
    try {
      const live = await def.readState(ctx, effective);
      if (expected === null) {
        failures.push(`seq ${op.seq} [${op.op}] ${op.target.identifier}: expected absent, still present`);
        continue;
      }
      const bad = compareState(expected, live, checkKeys);
      if (effective.op === "move-issue-team" && Array.isArray(effective.to.labelIdsComputed)) {
        const want = sortedStrings(effective.to.labelIdsComputed);
        if (JSON.stringify(sortedStrings(live.labelIds)) !== JSON.stringify(want))
          bad.push(`labelIds: expected=${JSON.stringify(want)} actual=${JSON.stringify(sortedStrings(live.labelIds))}`);
      }
      for (const b of bad)
        failures.push(`seq ${op.seq} [${op.op}] ${op.target.identifier}: ${b}`);
    } catch (err) {
      if (expected === null) continue; // gone, as required
      failures.push(
        `seq ${op.seq} [${op.op}] ${op.target.identifier}: re-read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const ok = failures.length === 0;
  const report = { phase, ok, ops: ops.length, failures, superseded, at: new Date().toISOString() };
  if (opts.reportPath) writeFsync(opts.reportPath, JSON.stringify(report, null, 2) + "\n", "w");
  const marker: JournalRecord = { seq: "verify", phase, ok, at: report.at };
  journalAppend(opts.journalPath, marker);
  // what the phase gate reads after this run: latest marker across all journals
  const gateGreen = journalPhaseVerifiedAcross(priorMarkers, [...journal, marker], phase);
  return { ok, failures, gateGreen, superseded };
}

// ---------------------------------------------------------------------------
// Rollback — inverse ops in reverse journal order, same per-write verify
// ---------------------------------------------------------------------------

/** Retirement status of a set of labels (rollback of a labelMap move). */
const LABELS_RETIRED_Q = /* GraphQL */ `
  query ReorgLabelsRetired($ids: [ID!]!) {
    issueLabels(filter: { id: { in: $ids } }, includeArchived: true, first: 250) { nodes { id name retiredAt } }
  }
`;

export interface RollbackOptions {
  /** A labelMap move's source labels may have been retired since; restore them
   *  (verified) before moving back instead of refusing. */
  restoreRetired?: boolean;
  pace: ApplyOptions["pace"];
  onEvent?: ApplyOptions["onEvent"];
  /** Write the inverse ops. Default false: preview only, zero mutation calls. */
  apply?: boolean;
  /** Preview plus a live pre-read of every target, reporting drift (no writes). */
  check?: boolean;
  /** Also invert rows journaled `alreadyApplied` (a change the tool never
   *  wrote, possibly a manual edit). Default false: they are skipped. */
  includeAlreadyApplied?: boolean;
  /** Post-write verify re-read backoff in ms (default 500/1000/2000/4000). */
  verifyDelaysMs?: number[];
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RollbackResult {
  /** Ops actually reverted (always 0 unless apply). */
  rolledBack: number;
  skipped: string[];
  /** Inverse ops in the order they would run / ran. */
  planned: number;
  /** Per-op drift lines from the live pre-read (check mode). */
  drifted: string[];
  dryRun: boolean;
}

/** The original op with keys the planner left out of from/to filled from the
 *  journaled live reads. The planner can emit a `from` without the compared
 *  field (rename-label carries {retired} but not the old name); the inverse is
 *  built from `from`, so without this it would restore an undefined value. The
 *  plan's own keys always win; only compareKeys are filled. */
function withJournaledState(rec: JournalRecord, orig: ReorgOp): ReorgOp {
  const keys = OP_REGISTRY[orig.op].compareKeys;
  const fill = (planned: Record<string, unknown>, live: Record<string, unknown> | undefined) => {
    const out = { ...planned };
    if (live && !("absent" in live))
      for (const k of keys) if (!(k in out) && k in live) out[k] = live[k];
    return out;
  };
  const st = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
  const out = { ...orig, from: fill(orig.from, st(rec.before)), to: fill(orig.to, st(rec.after)) };
  // A labelMap move restores the source labels the journal recorded BEFORE it
  // (the live truth), not the census copy in the plan.
  const before = st(rec.before);
  if (orig.op === "move-issue-team" && hasLabelMap(orig) && Array.isArray(before?.labelIds))
    out.from = { ...out.from, labelIds: sortedStrings(before.labelIds) };
  return out;
}

export async function rollbackPhase(
  client: LinearClient,
  journalPath: string,
  phase: number,
  opts: RollbackOptions,
): Promise<RollbackResult> {
  const journal = journalRead(journalPath)
    .filter((r) => r.ok && typeof r.seq === "number" && r.phase === phase)
    .reverse();
  const skipped: string[] = [];
  const drifted: string[] = [];
  let rolledBack = 0;
  let planned = 0;
  const write = opts.apply === true;
  const ctx: OpCtx = {
    client,
    pace: opts.pace,
    verifyDelaysMs: opts.verifyDelaysMs,
    sleep: opts.sleep,
    onEvent: opts.onEvent,
  };

  // Pass 1: build and validate every inverse before any write, so a journal
  // that cannot be inverted refuses the whole rollback instead of half of it.
  const steps: { rec: JournalRecord; orig: ReorgOp; inv: ReorgOp; restore: { id: string; name: string }[] }[] = [];
  for (const rec of journal) {
    const orig = rec.original;
    if (rec.alreadyApplied && !opts.includeAlreadyApplied) {
      skipped.push(
        `seq ${String(rec.seq)}${orig ? ` [${orig.op}]` : ""}: already applied before this run (not written by the tool); pass --include-already-applied to invert it`,
      );
      continue;
    }
    if (!orig) {
      skipped.push(`seq ${String(rec.seq)}: journal record lacks the original op — cannot invert`);
      continue;
    }
    const def = OP_REGISTRY[orig.op];
    const inv = def.inverse(withJournaledState(rec, orig));
    if (!inv) {
      skipped.push(`seq ${String(rec.seq)} [${orig.op}]: no inverse op (manual restore required)`);
      continue;
    }
    const post = OP_REGISTRY[inv.op].expectedPost(inv);
    const missing = post ? Object.keys(post).filter((k) => post[k] === undefined) : [];
    if (missing.length)
      throw new RollbackRefused(
        Number(rec.seq),
        `cannot invert ${orig.op}: field ${missing.map((k) => `"${k}"`).join(", ")} was recorded by neither the plan nor the journal`,
        { expected: { missingFields: missing }, actual: "not recorded" },
      );
    // The source labels a labelMap move restores must be usable: a label retired
    // since the move cannot be re-applied. Refuse (or restore with the flag).
    let restore: { id: string; name: string }[] = [];
    if (inv.op === "move-issue-team" && Array.isArray(inv.to.labelIdsComputed) && inv.to.labelIdsComputed.length > 0) {
      const d = await reorgRaw<{ issueLabels: { nodes: { id: string; name: string; retiredAt?: string | null }[] } }>(
        ctx.client, LABELS_RETIRED_Q, { ids: sortedStrings(inv.to.labelIdsComputed) }, ctx.pace,
      );
      restore = d.issueLabels.nodes.filter((l) => l.retiredAt != null).map((l) => ({ id: l.id, name: l.name }));
      if (restore.length > 0 && !opts.restoreRetired)
        throw new RollbackRefused(
          Number(rec.seq),
          `source label(s) retired since the move: ${restore.map((l) => `"${l.name}" (${l.id})`).join(", ")} — ` +
            `restore them (issueLabelRestore) or re-run with --restore-retired`,
          { expected: { retired: false }, actual: { retired: restore.map((l) => l.id) } },
        );
    }
    steps.push({ rec, orig, inv, restore });
  }

  // Live pre-read: the target must be in the state the journal says the forward
  // op left it in. Unreadable or changed targets are problems, never a pass.
  const preRead = async (
    rec: JournalRecord,
    orig: ReorgOp,
    inv: ReorgOp,
  ): Promise<{ line: string; error: ReorgMismatch } | "cascade" | null> => {
    const invDef = OP_REGISTRY[inv.op];
    const target = inv.target.identifier || inv.target.id;
    const head = `seq ${String(rec.seq)} [${orig.op}] ${target}`;
    let live: Record<string, unknown>;
    try {
      live = await invDef.readState(ctx, inv);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        line: `${head}: unreadable (${msg})`,
        error: new RollbackRefused(inv.seq, `target ${target} could not be read before the write: ${msg}`, {
          expected: pick(inv.from, invDef.compareKeys),
          actual: `unreadable: ${msg}`,
        }),
      };
    }
    const bad = compareState(inv.from, live, invDef.compareKeys);
    if (!bad.length) return null;
    // Inverting a parent's move carries its sub-issues back too: a child whose
    // live state already equals ITS inverse's full end state needs no write.
    const done: AppliedCheck =
      inv.op === "move-issue-team" ? await isAlreadyApplied(ctx, invDef, inv, live) : { applied: false };
    if (done.applied) return "cascade";
    const error = new ReorgMismatch(inv.seq, {
      expected: pick(inv.from, invDef.compareKeys),
      actual: pick(live, invDef.compareKeys),
    });
    if (done.reason) error.message += ` — ${done.reason}`;
    return { line: `${head}: ${bad.join("; ")}${done.reason ? ` — ${done.reason}` : ""}`, error };
  };

  // Pass 2 (--apply): read every target and refuse before the FIRST write if any
  // is unreadable or drifted. A target touched by several ops is read once, for
  // the op processed first; later ops on it expect the earlier rollback's state
  // and are re-checked just before their own write below.
  if (write) {
    const seen = new Set<string>();
    for (const { rec, orig, inv } of steps) {
      const key = `${inv.target.type}:${inv.target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const problem = await preRead(rec, orig, inv);
      if (problem && problem !== "cascade") throw problem.error;
    }
  }

  for (const { rec, orig, inv, restore } of steps) {
    planned++;
    // Dispatch on the INVERSE op's kind — an inverse may be a different op
    // (remove-project-team rolls back via add-project-team).
    const invDef = OP_REGISTRY[inv.op];
    const target = inv.target.identifier || inv.target.id;
    const intent = `seq ${String(rec.seq)} [${orig.op}] ${target}: ${JSON.stringify(pick(inv.from, invDef.compareKeys))} -> ${JSON.stringify(pick(inv.to, invDef.compareKeys))}`;

    if (write || opts.check) {
      const problem = await preRead(rec, orig, inv);
      if (problem === "cascade") {
        opts.onEvent?.({
          kind: "rollback",
          detail: `already reverted ${intent}: the issue was carried back by a parent's move`,
        });
        if (write) rolledBack++;
        continue;
      }
      if (problem) {
        if (write) throw problem.error;
        drifted.push(problem.line);
      }
    }
    if (!write) {
      for (const l of restore)
        opts.onEvent?.({ kind: "rollback", detail: `would restore retired label "${l.name}" (${l.id}) first` });
      opts.onEvent?.({ kind: "rollback", detail: `would revert ${intent}` });
      continue;
    }
    for (const l of restore) {
      await mutate(ctx, "issueLabelRestore", M.labelRestore, { id: l.id });
      const back = await readLabel(ctx, l.id);
      if (back.retired !== false)
        throw new ReorgMismatch(inv.seq, { expected: { label: l.id, retired: false }, actual: { retired: back.retired } });
      opts.onEvent?.({ kind: "rollback", detail: `restored retired label "${l.name}" (${l.id})` });
    }

    await invDef.apply(ctx, inv);
    const expected = invDef.expectedPost(inv);
    if (expected === null) {
      try {
        await invDef.readState(ctx, inv);
        throw new ReorgMismatch(inv.seq, { expected: "absent", actual: "still present" });
      } catch (err) {
        if (err instanceof ReorgMismatch) throw err;
        // read failed = absent, as required
      }
    } else {
      const { live, bad } = await readUntilMatches(ctx, invDef, inv, expected);
      if (bad.length)
        throw new ReorgMismatch(inv.seq, {
          expected: pick(expected, invDef.compareKeys),
          actual: pick(live, invDef.compareKeys),
        });
      if (inv.op === "move-issue-team" && Array.isArray(inv.to.labelIdsComputed)) {
        const want = sortedStrings(inv.to.labelIdsComputed);
        const got = await readLabelsUntil(ctx, inv, want, live);
        if (JSON.stringify(got) !== JSON.stringify(want))
          throw new ReorgMismatch(inv.seq, { expected: { labelIds: want }, actual: { labelIds: got } });
      }
    }
    rolledBack++;
    opts.onEvent?.({ kind: "rollback", detail: `reverted ${intent}` });
  }
  return { rolledBack, skipped, planned, drifted, dryRun: !write };
}

// ---------------------------------------------------------------------------
// Census — the read-only snapshot the planner consumes (everything paginated)
// ---------------------------------------------------------------------------

export interface CensusOptions {
  teamKeys?: string[];
  limit?: number;
}

export interface CensusIssue {
  id: string;
  identifier: string;
  teamId: string | null;
  teamKey: string | null;
  stateId: string | null;
  labelIds: string[];
  projectId: string | null;
  cycleId: string | null;
  archived: boolean;
}

export interface CensusLabel extends ReorgLabelNode {
  teamKey?: string | null;
  issueCount: number;
  /** Owner label id when this is an inherited (sub-team) copy. */
  inheritedFromId: string | null;
}

export interface CensusTeamNode extends ReorgTeamNode {
  name: string;
  /** Team.private at census time. The planner refuses a census without it. */
  private: boolean;
  /** Member user ids, read for private teams only. */
  memberIds?: string[];
  archivedAt?: string | null;
  issueCount?: number | null;
  parent?: { id: string; key: string } | null;
  states?: { nodes: (ReorgStateNode & { position: number })[] } | null;
}

export interface CensusData {
  workspace: { id: string; urlKey: string };
  teams: CensusTeamNode[];
  issues: CensusIssue[];
  workspaceLabels: CensusLabel[];
  teamLabels: CensusLabel[];
  projects: ReorgProjectNode[];
  initiatives: ReorgInitiativeNode[];
  generatedAt: string;
  rateBudget: { limit: number; remaining: number };
  /**
   * True when `--limit` capped what was fetched, so every count here is a
   * lower bound rather than a total, OR when a non-strict scan stopped on a
   * cursor that did not advance (a stalled scan would otherwise pass for a
   * complete one). The cap is applied while paging (a deliberate smoke-path
   * cheapness), so a consumer cannot tell a partial census from a small
   * workspace without this flag. `partialReasons` says which cause(s) applied.
   */
  partial: boolean;
  /** Why `partial` is true: the `--limit` cap and/or one entry per stalled connection. */
  partialReasons?: string[];
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Generic first:100 cursor loop (the pull.ts pattern) with an optional cap. */
async function paged<T>(
  client: LinearClient,
  pace: ApplyOptions["pace"],
  query: string,
  connection: string,
  vars: Record<string, unknown>,
  limit?: number,
  /** Emptiness/lookup probes: a stuck cursor throws instead of ending the scan
   *  (a partial read must not pass for a complete one). */
  strict = false,
  /** Non-strict only: called when the cursor stalls and the scan is cut short. */
  onStall?: (connection: string, cursor: string) => void,
): Promise<T[]> {
  // A bad cap is a usage error, not a silently unbounded scan. The previous
  // `limit &&` guard treated 0 as "no limit" and NaN as falsy, so both fetched
  // the whole workspace and exited 0.
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw usageError("--limit must be a positive integer.");
  }
  const out: T[] = [];
  let after: string | null = null;
  do {
    const d: Record<string, Page<T>> = await reorgRaw<Record<string, Page<T>>>(
      client, query, { ...vars, first: 100, after }, pace,
    );
    // `connection` may be a dotted path ("project.initiativeToProjects")
    let page: Page<T> | undefined = d as unknown as Page<T>;
    for (const key of connection.split("."))
      page = (page as unknown as Record<string, Page<T> | undefined> | null | undefined)?.[key];
    if (!page) throw new Error(`graphql: no ${connection} in the response`);
    out.push(...(page.nodes ?? []));
    const next = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor ?? null : null;
    // A cursor that does not advance would loop forever.
    if (strict && next !== null && next === after)
      throw new Error(`graphql: ${connection} cursor did not advance (stuck at ${next}) — refusing to treat a partial read as complete`);
    if (!strict && next !== null && next === after) onStall?.(connection, next);
    after = next !== null && next === after ? null : next;
    // Stop fetching as soon as the cap is met. Unlike a user-facing listing,
    // census `--limit` is a smoke-test cap on what is FETCHED: it exists to
    // keep a probe cheap against the shared request budget, and `--help`
    // documents the resulting counts as lower bounds. Draining every page
    // first would defeat the flag — a capped census went from ~2s to >120s
    // and burned 1000+ requests. Page-bound is correct here, by design.
    if (limit !== undefined && out.length >= limit) return out.slice(0, limit);
  } while (after);
  return out;
}

const CENSUS_ISSUES_Q = /* GraphQL */ `
  query ReorgCensusIssues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, includeArchived: true) {
      nodes {
        id
        identifier
        state { id }
        labels { nodes { id } }
        project { id }
        cycle { id }
        team { id key }
        archivedAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CENSUS_LABELS_Q = /* GraphQL */ `
  query ReorgCensusLabels($first: Int!, $after: String) {
    issueLabels(first: $first, after: $after) {
      nodes { id name retiredAt team { id key } inheritedFrom { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CENSUS_PROJECTS_Q = /* GraphQL */ `
  query ReorgCensusProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after, includeArchived: true) {
      nodes {
        id name targetDate archivedAt trashed
        status { id name }
        lead { id }
        teams { nodes { id key } }
        initiatives { nodes { id } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CENSUS_INITIATIVES_Q = /* GraphQL */ `
  query ReorgCensusInitiatives($first: Int!, $after: String) {
    initiatives(first: $first, after: $after, includeArchived: true) {
      nodes { id name archivedAt owner { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CENSUS_TEAMS_Q = /* GraphQL */ `
  query ReorgCensusTeams($first: Int!, $after: String, $filter: TeamFilter) {
    teams(first: $first, after: $after, includeArchived: true, filter: $filter) {
      nodes {
        id key name triageEnabled archivedAt issueCount private
        parent { id key }
        states { nodes { id name type position archivedAt inheritedFrom { id } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Snapshot the workspace structure: teams (+ states), ALL issues (the planner
 * needs them for relabel/move/archive/set-state ops), labels with per-label
 * issue counts, projects, initiatives. Everything paginates (first:100).
 * Read-only. `--team` scopes teams/issues/projects; `--limit` caps the smoke
 * path.
 */
export async function census(
  client: LinearClient,
  opts: CensusOptions,
  pace: ApplyOptions["pace"],
): Promise<CensusData> {
  const partialReasons: string[] = [];
  const onStall = (connection: string, cursor: string) =>
    partialReasons.push(`${connection}: cursor did not advance (stuck at ${cursor}); scan ended early, counts are lower bounds`);
  const teams = await paged<CensusTeamNode>(
    client, pace, CENSUS_TEAMS_Q, "teams",
    opts.teamKeys?.length ? { filter: { key: { in: opts.teamKeys } } } : {},
    opts.limit, false, onStall,
  );
  for (const t of teams) {
    if (typeof t.private !== "boolean")
      throw new Error(`census: team ${t.key} returned no boolean private flag — refusing to treat it as public`);
    if (t.private)
      t.memberIds = (
        await paged<{ id: string }>(client, pace, TEAM_MEMBERS_Q, "team.members", { id: t.id }, undefined, true)
      ).map((m) => m.id).sort();
  }

  const issueFilter = opts.teamKeys?.length
    ? { filter: { team: { key: { in: opts.teamKeys } } } }
    : {};
  const rawIssues = await paged<{
    id: string;
    identifier: string;
    state?: { id: string } | null;
    labels?: { nodes: { id: string }[] } | null;
    project?: { id: string } | null;
    cycle?: { id: string } | null;
    team?: { id: string; key: string } | null;
    archivedAt?: string | null;
  }>(client, pace, CENSUS_ISSUES_Q, "issues", issueFilter, opts.limit, false, onStall);

  const issues: CensusIssue[] = rawIssues.map((i) => ({
    id: i.id,
    identifier: i.identifier,
    teamId: i.team?.id ?? null,
    teamKey: i.team?.key ?? null,
    stateId: i.state?.id ?? null,
    labelIds: (i.labels?.nodes ?? []).map((l) => l.id).sort(),
    projectId: i.project?.id ?? null,
    cycleId: i.cycle?.id ?? null,
    archived: i.archivedAt != null,
  }));

  // per-label issue counts derived from the census issues (no extra requests)
  const countByLabel = new Map<string, number>();
  for (const i of issues)
    for (const l of i.labelIds) countByLabel.set(l, (countByLabel.get(l) ?? 0) + 1);

  const rawLabels = await paged<ReorgLabelNode>(client, pace, CENSUS_LABELS_Q, "issueLabels", {}, undefined, false, onStall);
  const withCounts: CensusLabel[] = rawLabels.map((l) => ({
    ...l,
    teamKey: l.team?.key ?? null,
    issueCount: countByLabel.get(l.id) ?? 0,
    inheritedFromId: l.inheritedFrom?.id ?? null,
  }));
  const workspaceLabels = withCounts.filter((l) => l.team == null);
  const teamLabelsAll = withCounts.filter((l) => l.team != null);
  const scoped = opts.teamKeys?.length
    ? teamLabelsAll.filter((l) => opts.teamKeys!.includes(l.teamKey ?? ""))
    : teamLabelsAll;
  // Owners of in-scope inherited labels are ALWAYS included, even when the
  // owner sits outside the team filter — the planner's owner grouping,
  // refusal lookup and child mapping silently break without them.
  const have = new Set(scoped.map((l) => l.id));
  const neededOwners = new Set(
    scoped.map((l) => l.inheritedFromId).filter((x): x is string => Boolean(x)),
  );
  for (const l of teamLabelsAll) {
    if (neededOwners.has(l.id) && !have.has(l.id)) {
      scoped.push(l);
      have.add(l.id);
    }
  }
  const teamLabels = scoped;

  const projectsAll = await paged<ReorgProjectNode>(
    client, pace, CENSUS_PROJECTS_Q, "projects", {}, opts.limit, false, onStall,
  );
  const projects = opts.teamKeys?.length
    ? projectsAll.filter((p) =>
        (p.teams?.nodes ?? []).some((t) => opts.teamKeys!.includes(t.key)),
      )
    : projectsAll;

  const initiatives = await paged<ReorgInitiativeNode>(
    client, pace, CENSUS_INITIATIVES_Q, "initiatives", {}, undefined, false, onStall,
  );

  const org = await reorgRaw<{ organization: { id: string; urlKey: string } }>(
    client,
    `query ReorgOrg { organization { id urlKey } }`,
    {},
    pace,
  );

  return {
    workspace: org.organization,
    teams,
    issues,
    workspaceLabels,
    teamLabels,
    projects,
    initiatives,
    generatedAt: new Date().toISOString(),
    rateBudget: pace.tracker.snapshot,
    partial: opts.limit !== undefined || partialReasons.length > 0,
    ...(opts.limit !== undefined || partialReasons.length > 0
      ? {
          partialReasons: [
            ...(opts.limit !== undefined ? ["--limit capped what was fetched; counts are lower bounds"] : []),
            ...partialReasons,
          ],
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Plan generation — rules file + census → plan ops
// ---------------------------------------------------------------------------

export interface ReorgRule {
  phase: number;
  op: ReorgOpKind;
  /** Selector into the census: {entity, where: {k: v}, teamKey?}. The entity
   *  "none" is for creation ops (target does not exist yet). */
  match: { entity: string; where: Record<string, unknown>; teamKey?: string };
  to: Record<string, unknown>;
  evidence: string;
  reversible?: boolean;
  approval?: string;
  batchKey?: string;
  /** Opt in to a visibility change (see {@link ReorgOp.allowVisibilityChange}). */
  allowVisibilityChange?: boolean;
  /** create-label rules only: a local name a move rule's `to.labelMap` can
   *  reference as `created:<ref>`; the planner rewrites it to `created:<seq>`
   *  once the final op order is fixed. */
  ref?: string;
}

/**
 * from-completeness invariant: every field an op's `to` changes must have a
 * census anchor in `from` (a rollback recovering a name from the journal is
 * the failure this prevents). Throws on the first incomplete op.
 */
export function assertFromAnchors(ops: ReorgOp[]): void {
  const REQUIRED_FROM: Record<string, string[]> = {
    "create-workspace-label": ["labelId"],
    "create-team-label": ["labelId"],
    "relabel": ["labelIds"],
    "rename-label": ["name", "retired"],
    "retire-or-delete-label": ["retired"],
    "set-state": ["stateId"],
    "enable-triage": ["triageEnabled"],
    "archive-state": ["archived"],
    "set-project-status": ["statusId"],
    "set-project-lead": ["leadId"],
    "set-project-target": ["targetDate"],
    "add-project-team": ["teamIds"],
    "remove-project-team": ["teamIds"],
    "move-project-initiative": ["initiativeIds"],
    "set-initiative-owner": ["ownerId"],
    "archive-issue": ["archived"],
    "archive-project": ["archived", "trashed"],
    "archive-initiative": ["archived"],
    "move-issue-team": ["teamId", "stateId", "labelIds", "projectId", "cycleId"],
    "create-project-status": ["statusId"],
    "delete-team": [],
  };
  for (const op of ops) {
    if (!(op.op in REQUIRED_FROM))
      throw new Error(
        `plan op seq ${op.seq}: unknown op kind "${op.op}" — add its from-field requirements to REQUIRED_FROM`,
      );
    const missing = REQUIRED_FROM[op.op].filter((k) => !(k in op.from));
    if (missing.length)
      throw new Error(
        `plan op seq ${op.seq} [${op.op}] ${op.target.identifier}: from is missing ${missing.join(", ")} ` +
          `(every changed field needs a census anchor)`,
      );
  }
}

/**
 * Planner-side visibility pass (census data only; apply and --check re-read live).
 * Throws, listing every team pair, when a visibility-changing op has no opt-in.
 */
function planVisibility(ops: ReorgOp[], censusData: CensusData): { rows: VisibilityPairCount[]; notes: string[] } {
  const teams = new Map(censusData.teams.map((t) => [t.id, t] as const));
  const vis = (id: string): TeamVisibility => {
    const t = teams.get(id);
    if (!t || typeof t.private !== "boolean")
      throw new Error(
        `census has no privacy for team ${id} — re-run reorg census (it records Team.private) before planning team moves`,
      );
    return { id: t.id, key: t.key, private: t.private, memberIds: t.memberIds ?? null };
  };
  const refusedOps: string[] = [];
  const lostBy = new Map<string, { ops: number; lost: number }>();
  const rows = new Map<string, VisibilityPairCount & { why: string; sample: string[] }>();
  for (const op of ops) {
    let why: string | null = null;
    let pair: [string, string] | null = null;
    if (op.op === "move-issue-team" && typeof op.from.teamId === "string" && typeof op.to.teamId === "string") {
      const src = vis(op.from.teamId);
      const dst = vis(op.to.teamId);
      why = moveVisibilityChange(src, dst);
      pair = [src.key, dst.key];
      const lost = moveAccessLost(src, dst);
      if (lost > 0) {
        const n = lostBy.get(`${src.key} -> ${dst.key}`) ?? { ops: 0, lost };
        n.ops++;
        lostBy.set(`${src.key} -> ${dst.key}`, n);
      }
    } else if (op.op === "add-project-team") {
      const current = sortedStrings(op.from.teamIds);
      const added = sortedStrings(op.to.teamIds).filter((t) => !current.includes(t));
      const cur = current.map(vis);
      why = projectTeamAddVisibilityChange(cur, added.map(vis));
      pair = [cur.map((t) => t.key).join("+"), added.map((t) => vis(t).key).join("+")];
    }
    if (!why || !pair) continue;
    const allowed = op.allowVisibilityChange === true;
    const k = `${op.op}|${pair[0]}|${pair[1]}|${allowed}`;
    const row = rows.get(k) ?? { from: pair[0], to: pair[1], kind: op.op as VisibilityPairCount["kind"], count: 0, allowed, why, sample: [] };
    row.count++;
    if (row.sample.length < 3) row.sample.push(op.target.identifier);
    if (!allowed) refusedOps.push(`seq ${op.seq} ${op.target.identifier} ${pair[0]} -> ${pair[1]}: ${why}`);
    rows.set(k, row);
  }
  const all = [...rows.values()];
  const refused = all.filter((r) => !r.allowed);
  if (refused.length > 0) {
    // One line: the CLI prints only the first line of an error message.
    const shown = refusedOps.slice(0, 20);
    throw new Error(
      `plan refused: ${refusedOps.length} op(s) would change visibility without allowVisibilityChange: true on their rule. ` +
        `Team pairs: ${refused.map((r) => `${r.kind} ${r.from} -> ${r.to} x${r.count}`).join("; ")}. ` +
        `Ops: ${shown.join(" | ")}${refusedOps.length > shown.length ? ` | ... and ${refusedOps.length - shown.length} more` : ""}` +
        (all.length > refused.length
          ? `. Allowed: ${all.filter((r) => r.allowed).map((r) => `${r.from} -> ${r.to} x${r.count}`).join("; ")}`
          : ""),
    );
  }
  return {
    rows: all.map(({ from, to, kind, count, allowed }) => ({ from, to, kind, count, allowed })),
    notes: [...lostBy].map(([pair, n]) => `${pair}: ${n.lost} source member(s) lose access (${n.ops} move(s))`),
  };
}

/**
 * Turn declarative rules + a census snapshot into concrete ops. `from` is
 * captured from the census here — that capture is what makes the executor
 * drift-safe. A rule that matches nothing is an error (a typo, not a no-op).
 * add-project-team rules take `to.teamId`; the planner computes the FULL
 * `to.teamIds` (census membership + the added id) the mutation requires.
 */
export function planFromRules(
  rules: ReorgRule[],
  censusData: CensusData,
  meta: ReorgPlanMeta,
): ReorgPlan {
  const ops: ReorgOp[] = [];
  const warnings: string[] = [];
  const labelById = new Map(
    [...censusData.workspaceLabels, ...censusData.teamLabels].map((l) => [l.id, l] as const),
  );
  const stateById = new Map(
    censusData.teams.flatMap((t) => (t.states?.nodes ?? []).map((s) => [s.id, { ...s, teamKey: t.key }] as const)),
  );
  let seq = 0;
  const refSeq = new Map<string, number>(); // rule ref -> index in `ops`
  for (const rule of rules) {
    // Writes target owner labels only — a rule naming an inherited label id is
    // refused at plan time (Linear: "Cannot update inherited labels").
    const whereId = rule.match.where.id;
    if (
      typeof whereId === "string" &&
      (rule.match.entity === "team-label" || rule.match.entity === "workspace-label")
    ) {
      const l = labelById.get(whereId);
      if (l?.inheritedFromId)
        throw new Error(
          `rule "${rule.evidence}" targets inherited label ${l.name} (${whereId}), child of ${l.inheritedFromId} — target the owner`,
        );
    }
    // Same for a rule naming an inherited workflow-state view by id.
    if (typeof whereId === "string" && rule.match.entity === "team-state") {
      const s = stateById.get(whereId);
      if (s?.inheritedFrom?.id)
        throw new Error(
          `rule "${rule.evidence}" targets inherited state ${s.teamKey}/${s.name} (${whereId}), child of ${s.inheritedFrom.id} — act on the owner state`,
        );
    }
    const targets = selectTargets(rule, censusData);
    if (targets.length === 0)
      throw new Error(
        `rule matched nothing: ${rule.op} where ${JSON.stringify(rule.match.where)} (${rule.evidence})`,
      );
    // archive-state is never reversible — coerce and require approval
    if (rule.op === "archive-state" && !rule.approval)
      throw new Error(
        `archive-state rule needs an approval id (no unarchive exists): ${rule.evidence}`,
      );
    assertArchiveProjectNotTrash(rule.op, rule.to, `rule "${rule.evidence}"`);
    if (rule.op === "create-team-label") {
      if (rule.match.entity !== "team")
        throw new Error(`create-team-label rule needs match.entity "team" (the destination team): ${rule.evidence}`);
      if (typeof rule.to.name !== "string" || !rule.to.name)
        throw new Error(`create-team-label rule needs to.name: ${rule.evidence}`);
      if (targets.length !== 1 && rule.ref)
        throw new Error(`create-team-label rule with ref "${rule.ref}" matched ${targets.length} teams — a ref names exactly one op`);
    }
    for (const t of targets) {
      seq++;
      const to = { ...rule.to };
      if (rule.op === "add-project-team" && typeof to.teamId === "string" && !to.teamIds) {
        const current = sortedStrings(t.from.teamIds);
        to.teamIds = [...new Set([...current, to.teamId])].sort();
      }
      if (rule.ref) {
        if (refSeq.has(rule.ref)) throw new Error(`duplicate rule ref "${rule.ref}"`);
        refSeq.set(rule.ref, ops.length);
      }
      ops.push({
        seq,
        phase: rule.phase,
        op: rule.op,
        target: t.target,
        // creation-by-team: the target is the existing team, the absence
        // anchor is the (not yet created) label
        from: rule.op === "create-team-label" ? { labelId: null } : t.from,
        to,
        evidence: rule.evidence,
        reversible: rule.op === "archive-state" ? false : (rule.reversible ?? true),
        ...(rule.approval ? { approval: rule.approval } : {}),
        ...(rule.batchKey ? { batchKey: rule.batchKey } : {}),
        ...(rule.allowVisibilityChange === true ? { allowVisibilityChange: true } : {}),
      });
    }
  }
  // batchKey contract is "identical input": two batchable ops under one key
  // with different `to` can never run as one batch (apply refuses it).
  {
    const firstByKey = new Map<string, ReorgOp>();
    for (const o of ops) {
      if (!o.batchKey || !BATCHABLE_OPS.has(o.op)) continue;
      const id = `${o.op}\u0000${o.batchKey}`;
      const first = firstByKey.get(id);
      if (!first) firstByKey.set(id, o);
      else if (JSON.stringify(first.to) !== JSON.stringify(o.to))
        throw new Error(
          `batchKey "${o.batchKey}" [${o.op}] is shared by ops with different input: seq ${first.seq} ("${first.evidence}") vs seq ${o.seq} ("${o.evidence}"); ` +
            `a batchKey means identical input — give each distinct input its own batchKey`,
        );
    }
  }
  const { rows: visibility, notes } = planVisibility(ops, censusData);

  // Warnings: a team scheduled for deletion must not be referenced by other
  // rules nor still listed on census projects (the phase-5c dependency).
  const deletedKeys = new Set(
    rules.filter((r) => r.op === "delete-team").map((r) => r.match.where.key as string),
  );
  if (deletedKeys.size > 0) {
    const deletedIds = new Set(
      censusData.teams.filter((t) => deletedKeys.has(t.key)).map((t) => t.id),
    );
    for (const r of rules) {
      if (
        (r.op === "add-project-team" || r.op === "remove-project-team") &&
        typeof r.to.teamId === "string" && deletedIds.has(r.to.teamId)
      )
        warnings.push(
          `rule "${r.evidence}" references team ${r.to.teamId} which this plan deletes — order or drop it`,
        );
    }
    for (const p of censusData.projects) {
      const stillOn = (p.teams?.nodes ?? []).filter((t) => deletedIds.has(t.id));
      // suppressed when the same plan already removes that team from this
      // project (by-id remove-project-team rule)
      const covered = new Set(
        rules
          .filter((r) => r.op === "remove-project-team" && typeof r.match.where.id === "string")
          .map((r) => `${String(r.match.where.id)}:${String(r.to.teamId)}`),
      );
      const uncovered = stillOn.filter((t) => !covered.has(`${p.id}:${t.id}`));
      if (uncovered.length > 0)
        warnings.push(
          `project "${p.name}" still lists to-be-deleted team(s) ${uncovered.map((t) => t.key).join(", ")} (phase 5 must remove them)`,
        );
    }
  }
  assertFromAnchors(ops);

  // relabel child mapping: a sub-team issue carries the CHILD id of an owner
  // label — removing the owner means removing the child the issue carries.
  const issueById = new Map(censusData.issues.map((i) => [i.id, i] as const));
  const childrenOf = new Map<string, string[]>();
  for (const l of censusData.teamLabels) {
    if (!l.inheritedFromId) continue;
    if (!labelById.has(l.inheritedFromId))
      throw new Error(
        `census carries inherited label ${l.name} (${l.id}) without its owner ${l.inheritedFromId} — re-run the census (owners are always included now)`,
      );
    const arr = childrenOf.get(l.inheritedFromId) ?? [];
    arr.push(l.id);
    childrenOf.set(l.inheritedFromId, arr);
  }
  for (const op of ops) {
    if (op.op !== "relabel" || op.target.type !== "issue") continue;
    const issue = issueById.get(op.target.id);
    if (!issue) continue;
    op.to.remove = sortedStrings(op.to.remove).map((rid) => {
      const kids = childrenOf.get(rid);
      if (!kids) return rid;
      // prefer the child belonging to the issue's own team (a sub-team issue
      // carries its team's child), then any carried child, then the id as-is
      const ownTeam = kids.find((k) => labelById.get(k)?.team?.id === issue.teamId);
      return ownTeam ?? kids.find((k) => issue.labelIds.includes(k)) ?? rid;
    });
  }

  // Phase-1 ordering invariant: rename-label → create-workspace-label →
  // relabel → retire-or-delete-label. Linear enforces label-name uniqueness
  // across workspace AND team scope, so a create fails while any team copy
  // carries the name; renames clear the names first. Stable within phases.
  const PHASE1_RANK: Record<string, number> = {
    "rename-label": 0,
    "create-workspace-label": 1,
    "relabel": 2,
    "retire-or-delete-label": 3,
  };
  const ordered = [...ops].sort(
    (a, b) =>
      a.phase - b.phase ||
      (a.phase === 1 ? (PHASE1_RANK[a.op] ?? 99) - (PHASE1_RANK[b.op] ?? 99) : 0),
  );
  // Phase-5 ordering invariant: rename-label → create-team-label →
  // add-project-team → move-issue-team. Only these four kinds are reordered,
  // among the slots they already occupy; every other op keeps its place.
  const PHASE5_RANK: Record<string, number> = {
    "rename-label": 0,
    "create-team-label": 1,
    "add-project-team": 2,
    "move-issue-team": 3,
  };
  const slots = ordered.flatMap((o, i) => (o.phase === 5 && o.op in PHASE5_RANK ? [i] : []));
  const sorted = slots
    .map((i) => ordered[i])
    .sort((a, b) => PHASE5_RANK[a.op] - PHASE5_RANK[b.op]);
  slots.forEach((slot, k) => { ordered[slot] = sorted[k]; });
  ordered.forEach((o, i) => { o.seq = i + 1; });

  // labelMap: prune each move's map to the labels that issue carries (by id or
  // an inherited child of the key), then rewrite created:<rule ref> to the
  // final created:<seq>. A ref must point at an earlier create op.
  const refToOp = new Map<string, ReorgOp>();
  for (const [ref, idx] of refSeq) refToOp.set(ref, ops[idx]);
  for (const op of ordered) {
    if (op.op !== "move-issue-team" || !isRecord(op.to.labelMap)) continue;
    const carried = new Set(sortedStrings(op.from.labelIds));
    const next: Record<string, string> = {};
    for (const [src, ref] of Object.entries(op.to.labelMap)) {
      let r = String(ref);
      if (r.startsWith(CREATED_REF_PREFIX) && !/^created:\d+$/.test(r)) {
        const target = refToOp.get(r.slice(CREATED_REF_PREFIX.length));
        if (!target) throw new Error(`labelMap ref "${r}" names no create-team-label rule ref`);
        if (target.seq >= op.seq) throw new Error(`labelMap ref "${r}" resolves to seq ${target.seq}, not before the move at seq ${op.seq}`);
        r = `${CREATED_REF_PREFIX}${target.seq}`;
        const dest = censusData.teams.find((t) => t.id === op.to.teamId);
        if (dest && target.target.id !== dest.id && target.target.id !== dest.parent?.id)
          throw new Error(
            `labelMap ref "${ref}": create-team-label targets team ${target.target.identifier}, but the move's destination is ` +
              `${dest.key}${dest.parent ? ` (parent ${dest.parent.key})` : ""} — the label must belong to the destination team or its parent`,
          );
      }
      const onIssue = carried.has(src) || (childrenOf.get(src) ?? []).some((k) => carried.has(k));
      if (onIssue) next[src] = r;
    }
    op.to.labelMap = next;
    if (Object.keys(next).length === 0 && !Array.isArray(op.to.reapplyLabelIds)) op.to.reapplyLabelIds = [];
  }
  return { meta, ops: ordered, warnings, ...(visibility.length ? { visibility } : {}), ...(notes.length ? { notes } : {}) };
}

function selectTargets(
  rule: ReorgRule,
  censusData: CensusData,
): { target: ReorgTarget; from: Record<string, unknown> }[] {
  const where = rule.match.where;
  const hit = (obj: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => JSON.stringify(obj[k]) === JSON.stringify(v));

  switch (rule.match.entity) {
    case "none": {
      // creation ops — the target does not exist; one synthetic target per rule.
      // The from anchor keys the kind: labels anchor labelId, statuses statusId.
      const key = rule.op === "create-project-status" ? "statusId" : "labelId";
      return [{
        target: {
          type: rule.op === "create-project-status" ? "project" : "label",
          id: `new:${String(rule.to.name ?? "unnamed")}`,
          identifier: String(rule.to.name ?? "unnamed"),
        },
        from: { [key]: null },
      }];
    }
    case "team": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const t of censusData.teams) {
        if (!hit({ key: t.key, name: t.name, triageEnabled: t.triageEnabled === true, archived: t.archivedAt != null })) continue;
        out.push({
          target: { type: "team", id: t.id, identifier: t.key },
          from: { triageEnabled: t.triageEnabled === true },
        });
      }
      return out;
    }
    case "issue": {
      // label/labelId are handled here, not by the generic hit
      const { label: _label, labelId: _labelId, ...genericWhere } = where;
      const genericHit = (obj: Record<string, unknown>) =>
        Object.entries(genericWhere).every(([k, v]) => JSON.stringify(obj[k]) === JSON.stringify(v));
      const labelName = typeof where.label === "string" ? where.label : null;
      const labelId = typeof where.labelId === "string" ? where.labelId : null;
      // an owner label id matches issues carrying any of its inherited children
      const labelIdSet: Set<string> | null = !labelId
        ? null
        : new Set([
            labelId,
            ...censusData.teamLabels.filter((l) => l.inheritedFromId === labelId).map((l) => l.id),
          ]);
      const nameIds: Set<string> | null = !labelName
        ? null
        : new Set(
            [...censusData.workspaceLabels, ...censusData.teamLabels]
              .filter((l) => l.name === labelName)
              .map((l) => l.id),
          );
      if (nameIds !== null && nameIds.size === 0)
        throw new Error(`issue selector: no census label named "${labelName}"`);
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const i of censusData.issues) {
        if (!genericHit({
          identifier: i.identifier, teamKey: i.teamKey, stateId: i.stateId,
          projectId: i.projectId, archived: i.archived,
        })) continue;
        if (labelIdSet && !i.labelIds.some((l) => labelIdSet.has(l))) continue;
        if (nameIds && !i.labelIds.some((l) => nameIds.has(l))) continue;
        out.push({
          target: { type: "issue", id: i.id, identifier: i.identifier },
          from: {
            teamId: i.teamId,
            stateId: i.stateId,
            labelIds: i.labelIds,
            projectId: i.projectId,
            cycleId: i.cycleId,
            archived: i.archived,
          },
        });
      }
      return out;
    }
    case "workspace-label": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const l of censusData.workspaceLabels) {
        if (!hit({ name: l.name, retired: l.retiredAt != null, issueCount: l.issueCount })) continue;
        out.push({
          target: { type: "label", id: l.id, identifier: l.name },
          from: { retired: l.retiredAt != null, name: l.name, inheritedFromId: l.inheritedFromId },
        });
      }
      return out;
    }
    case "team-label": {
      // Inherited (sub-team) copies never match — Linear refuses writes on
      // them. Owner usage sums its children (a zero-issue owner whose children
      // carry issues is NOT zero-issue).
      const childCount = new Map<string, number>();
      for (const l of censusData.teamLabels) {
        if (l.inheritedFromId)
          childCount.set(l.inheritedFromId, (childCount.get(l.inheritedFromId) ?? 0) + l.issueCount);
      }
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const l of censusData.teamLabels) {
        if (l.inheritedFromId) continue;
        if (rule.match.teamKey && l.teamKey !== rule.match.teamKey) continue;
        const effectiveCount = l.issueCount + (childCount.get(l.id) ?? 0);
        if (!hit({ name: l.name, retired: l.retiredAt != null, issueCount: effectiveCount })) continue;
        out.push({
          target: { type: "label", id: l.id, identifier: `${l.teamKey}/${l.name}` },
          // name is the rename drift anchor; inheritedFromId proves ownership
          from: { retired: l.retiredAt != null, name: l.name, inheritedFromId: l.inheritedFromId },
        });
      }
      return out;
    }
    case "team-state": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const t of censusData.teams) {
        if (rule.match.teamKey && t.key !== rule.match.teamKey) continue;
        for (const s of t.states?.nodes ?? []) {
          if (!hit({ name: s.name, type: s.type, archived: s.archivedAt != null })) continue;
          // Inherited views never match (as inherited labels): Linear mirrors
          // the owner, and an owner archive takes its views with it.
          if (s.inheritedFrom?.id) continue;
          out.push({
            target: { type: "state", id: s.id, identifier: `${t.key}/${s.name}` },
            from: { archived: s.archivedAt != null },
          });
        }
      }
      return out;
    }
    case "project": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const p of censusData.projects) {
        if (!hit({ id: p.id, name: p.name, archived: p.archivedAt != null, trashed: p.trashed === true })) continue;
        out.push({
          target: { type: "project", id: p.id, identifier: p.name },
          from: {
            statusId: p.status?.id ?? null,
            leadId: p.lead?.id ?? null,
            targetDate: p.targetDate ?? null,
            archived: p.archivedAt != null,
            trashed: p.trashed === true,
            teamIds: (p.teams?.nodes ?? []).map((x) => x.id).sort(),
            initiativeIds: (p.initiatives?.nodes ?? []).map((x) => x.id).sort(),
          },
        });
      }
      // Duplicate project names exist in the wild — a name selector hitting
      // several is refused, not fanned out (select by id instead).
      if (out.length > 1 && typeof where.name === "string" && !where.id)
        throw new Error(
          `project selector: name "${where.name}" matches ${out.length} projects — select by id`,
        );
      return out;
    }
    case "initiative": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const it of censusData.initiatives) {
        if (!hit({ id: it.id, name: it.name, archived: it.archivedAt != null })) continue;
        out.push({
          target: { type: "initiative", id: it.id, identifier: it.name },
          from: { archived: it.archivedAt != null, ownerId: it.owner?.id ?? null },
        });
      }
      if (out.length > 1 && typeof where.name === "string" && !where.id)
        throw new Error(
          `initiative selector: name "${where.name}" matches ${out.length} initiatives — select by id`,
        );
      return out;
    }
    default:
      throw new Error(`unknown rule entity ${rule.match.entity}`);
  }
}
