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

/** True when the journal carries a green verify marker for the phase. */
export function journalPhaseVerified(records: JournalRecord[], phase: number): boolean {
  // The LATEST marker for the phase decides: a later red revokes an earlier green.
  let latest: JournalRecord | undefined;
  for (const r of records) if (r.seq === "verify" && r.phase === phase) latest = r;
  return latest?.ok === true;
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
    workflowState(id: $id) { id name type archivedAt }
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
    issueLabels(filter: { name: { eq: $name }, team: { null: true } }) {
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
  return { ...op, to };
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
  return { archived: d.workflowState.archivedAt != null };
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

/** All-scopes labels by exact name — the --check create-conflict preflight. */
const LABELS_BY_NAME_ALL_SCOPES_Q = /* GraphQL */ `
  query ReorgLabelsByNameAllScopes($name: String!) {
    issueLabels(filter: { name: { eq: $name } }, first: 250) {
      nodes { id name team { id key } inheritedFrom { id } }
    }
  }
`;

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

/** Every project status (few; paginated) — projectStatuses takes no filter. */
const PROJECT_STATUSES_Q = /* GraphQL */ `
  query ReorgProjectStatuses($first: Int!, $after: String) {
    projectStatuses(first: $first, after: $after) {
      nodes { id name type }
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
      await mutate(ctx, "issueLabelCreate", M.labelCreate, {
        input: {
          name: op.to.name,
          color: op.to.color ?? "#999999",
          ...(typeof op.to.description === "string" ? { description: op.to.description } : {}),
          // no teamId → workspace-scoped label
        },
      });
      const live = await OP_REGISTRY["create-workspace-label"].readState(ctx, op);
      if (typeof live.labelId !== "string")
        throw new Error(`created label "${String(op.to.name)}" not found on re-read`);
      op.to.labelId = live.labelId; // journal `after` carries the created id
    },
    inverse: () => null, // inverse of create is delete — irreversible; retire by hand
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
      await mutate(ctx, "issueUpdate", M.issueUpdate, {
        id: op.target.id,
        input: {
          teamId: op.to.teamId,
          // The move drops team labels; the mapped workspace replacements are
          // re-sent in the same input (precondition a).
          addedLabelIds: op.to.reapplyLabelIds ?? [],
          // Destination state sent in the same input when the plan maps one.
          ...(op.to.stateId ? { stateId: op.to.stateId } : {}),
        },
      });
    },
    inverse(op) {
      // Move back to the original team. The identifier changes AGAIN (the old
      // one keeps resolving) — recorded in the identifier map, not restored.
      return {
        ...op,
        from: op.to,
        to: {
          teamId: op.from.teamId,
          reapplyLabelIds: op.from.labelIds ?? [],
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
      await mutate(ctx, "projectStatusCreate", M.projectStatusCreate, {
        input: {
          name: op.to.name,
          color: op.to.color ?? "#999999",
          type: op.to.type,
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
  const written = [...sortedStrings(op.to.add), ...sortedStrings(op.to.reapplyLabelIds)]
    .filter((id) => !id.startsWith(LABEL_REF_PREFIX)); // name: refs resolve workspace-scoped only
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
  if (!journalPhaseVerified(journal, 1))
    fail("(a) phase-1 verify is not green in the journal");
  if (!Array.isArray(op.to.reapplyLabelIds))
    fail("(a) to.reapplyLabelIds missing — the mapped workspace labels must be re-sent in the move input");
  if (!journalPhaseVerified(journal, 2))
    fail("(c) phase-2 verify is not green in the journal");
  if (!("cycleId" in op.from)) fail("(d) from.cycleId not captured at census");

  // (a) live label check: every TEAM-scoped label on the issue must already
  // have been swapped for a workspace replacement by a journaled relabel.
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
    for (const l of teamScoped) {
      const swapped = journal.some(
        (r) =>
          r.ok &&
          r.op === "relabel" &&
          r.original?.target.id === op.target.id &&
          sortedStrings(r.original.to.remove).includes(l.id) &&
          sortedStrings(r.original.to.add).every((a) => reapply.has(a)),
      );
      if (!swapped)
        fail(
          `(a) team label "${l.name}" (${l.id}) is live on ${op.target.identifier} with no ` +
            `journaled relabel to a workspace replacement — phase 1 is incomplete for this issue`,
        );
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

/** Only empty states may be archived (plan §2c) — live read, refuse loudly
 *  instead of discovering Linear's refusal mid-phase. Archived issues count:
 *  they still reference the state. */
async function assertStateEmpty(ctx: OpCtx, op: ReorgOp): Promise<void> {
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
): Promise<void> {
  if (op.op === "relabel" || op.op === "move-issue-team") await assertNoInheritedWrites(ctx, op);
  if (op.op === "move-issue-team") await assertMovePreconditions(ctx, op, journal);
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
  /** --check only: seqs whose apply-time precondition reads would refuse. */
  refused: number[];
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when `live` already equals the op's expected end state. Never vacuous:
 *  the expected state must constrain at least one compared key. move-issue-team
 *  is excluded (its end state is also checked via label/state post-steps). */
function isAlreadyApplied(
  def: OpDef,
  op: ReorgOp,
  live: Record<string, unknown>,
): boolean {
  if (op.op === "move-issue-team") return false;
  const expected = def.expectedPost(op);
  if (expected === null) return false;
  if (!def.compareKeys.some((k) => k in expected)) return false;
  return compareState(expected, live, def.compareKeys).length === 0;
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
    if (isAlreadyApplied(def, op, liveBefore)) {
      // An earlier write landed but was never journaled: record it, write nothing.
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
      };
      journalAppend(journalPath, rec);
      journal.push(rec);
      ctx.onEvent?.({
        kind: "already-applied",
        detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: live state already equals the expected end state; journaled, no write`,
      });
      return "already-applied";
    }
    throw new ReorgMismatch(op.seq, {
      expected: pick(op.from, def.compareKeys),
      actual: pick(liveBefore, def.compareKeys),
    });
  }

  // 2. op-specific preconditions (live reads)
  if (op.target.type === "label" && liveBefore.inheritedFromId)
    throw new Error(
      `seq ${op.seq} [${op.op}]: target ${op.target.identifier} is an inherited label ` +
        `(child of ${String(liveBefore.inheritedFromId)}) — Linear refuses writes on it; target the owner`,
    );
  if (op.op === "relabel" || op.op === "move-issue-team")
    await assertNoInheritedWrites(ctx, op);
  if (op.op === "move-issue-team") await assertMovePreconditions(ctx, op, journal);

  // 3. write
  await def.apply(ctx, op);

  // 4. expected end state vs a fresh re-read
  const expected = def.expectedPost(op);
  let liveAfter: Record<string, unknown> | null = null;
  if (expected === null) {
    // delete forms: the re-read must FAIL
    try {
      await def.readState(ctx, op);
    } catch {
      liveAfter = null; // gone, as required
    }
    if (liveAfter !== null)
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
  };
  journalAppend(journalPath, rec);
  journal.push(rec);
  return "applied";
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
        if (drift.length && isAlreadyApplied(def, op, live)) {
          opts.onEvent?.({
            kind: "check",
            detail: `already applied seq ${op.seq} [${op.op}] ${op.target.identifier}`,
          });
        } else if (drift.length) {
          drifted.push(op.seq);
          opts.onEvent?.({
            kind: "drift",
            detail: `DRIFT seq ${op.seq} [${op.op}] ${op.target.identifier}: ${drift.join("; ")}`,
          });
        } else {
          // precondition READS apply would run before its first write: a
          // refusal here is its own finding class, distinct from drift
          try {
            await assertOpPreconditions(ctx, op, journal);
          } catch (err) {
            refused.push(op.seq);
            opts.onEvent?.({
              kind: "refuse",
              detail: `REFUSE seq ${op.seq} [${op.op}] ${op.target.identifier}: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
          opts.onEvent?.({ kind: "check", detail: `ok    seq ${op.seq} [${op.op}] ${op.target.identifier}` });
        }
      } catch (err) {
        drifted.push(op.seq);
        opts.onEvent?.({
          kind: "drift",
          detail: `DRIFT seq ${op.seq} [${op.op}] ${op.target.identifier}: read failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
    // create-conflict preflight: a create-workspace-label fails at Linear if
    // ANY label (any scope) still carries the name. Planned rename-label ops
    // clear their targets' names, so they don't count as conflicts.
    const renamedAway = new Set(
      ops.filter((o) => o.op === "rename-label").map((o) => o.target.id),
    );
    for (const op of ops.filter((o) => o.op === "create-workspace-label")) {
      const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
        ctx.client, LABELS_BY_NAME_ALL_SCOPES_Q, { name: op.to.name }, ctx.pace,
      );
      // planned renames clear their targets AND, by propagation, every
      // inherited child of those targets
      const conflicts = d.issueLabels.nodes.filter(
        (l) => !renamedAway.has(l.id) && !(l.inheritedFrom && renamedAway.has(l.inheritedFrom.id)),
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
    for (const op of ops) {
      const irreversibleNote = op.reversible
        ? ""
        : ` (IRREVERSIBLE, approval ${op.approval ?? "—"})`;
      opts.onEvent?.({
        kind: "dry",
        detail: `seq ${op.seq} [${op.op}] ${op.target.identifier}: ${JSON.stringify(op.from)} → ${JSON.stringify(op.to)}${irreversibleNote}`,
      });
    }
    opts.onEvent?.({
      kind: "budget",
      detail: `${ops.length} op(s), ≈${estimateRequests(ops)} request(s) at ${REORG_RATE_PER_HOUR}/h pace (add --check for a live drift pre-read)`,
    });
    return { applied: 0, skipped, dryRun: true, drifted: [], refused: [] };
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

  let applied = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];

    // Batch run: same batchKey, batchable kind, ≤ 50, identical input.
    if (op.batchKey && (op.op === "relabel" || op.op === "set-state")) {
      const group: ReorgOp[] = [];
      let j = i;
      while (
        j < ops.length &&
        ops[j].batchKey === op.batchKey &&
        ops[j].op === op.op &&
        group.length < 50
      ) {
        group.push(ops[j]);
        j++;
      }
      if (group.length > 1) {
        await runBatch(ctx, group, opts, journal);
        applied += group.length;
        i = j;
        continue;
      }
      // single member — falls through to the sequential path
    }

    const outcome = await executeOne(ctx, op, journal, opts.journalPath);
    applied++;
    opts.onEvent?.({
      kind: "applied",
      detail: `seq ${op.seq} [${op.op}] ${op.target.identifier} ${outcome === "already-applied" ? "ok (already applied)" : "ok"}`,
    });
    i++;
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
      if (!isAlreadyApplied(def, op, live))
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

export async function verifyPhase(
  client: LinearClient,
  plan: ReorgPlan,
  phase: number,
  opts: { journalPath: string; pace: ApplyOptions["pace"]; reportPath?: string },
): Promise<{ ok: boolean; failures: string[] }> {
  const ops = plan.ops.filter((o) => o.phase === phase);
  const journal = journalRead(opts.journalPath);
  const okSeqs = journalOkSeqs(journal);
  const bySeq = new Map<number, JournalRecord>();
  for (const r of journal) if (typeof r.seq === "number") bySeq.set(r.seq, r);
  const failures: string[] = [];
  const ctx: OpCtx = { client, pace: opts.pace };

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
    try {
      const live = await def.readState(ctx, effective);
      if (expected === null) {
        failures.push(`seq ${op.seq} [${op.op}] ${op.target.identifier}: expected absent, still present`);
        continue;
      }
      const bad = compareState(expected, live, def.compareKeys);
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
  const report = { phase, ok, ops: ops.length, failures, at: new Date().toISOString() };
  if (opts.reportPath) writeFsync(opts.reportPath, JSON.stringify(report, null, 2) + "\n", "w");
  journalAppend(opts.journalPath, { seq: "verify", phase, ok, at: report.at });
  return { ok, failures };
}

// ---------------------------------------------------------------------------
// Rollback — inverse ops in reverse journal order, same per-write verify
// ---------------------------------------------------------------------------

export interface RollbackOptions {
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
  return { ...orig, from: fill(orig.from, st(rec.before)), to: fill(orig.to, st(rec.after)) };
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
  const steps: { rec: JournalRecord; orig: ReorgOp; inv: ReorgOp }[] = [];
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
    steps.push({ rec, orig, inv });
  }

  // Live pre-read: the target must be in the state the journal says the forward
  // op left it in. Unreadable or changed targets are problems, never a pass.
  const preRead = async (
    rec: JournalRecord,
    orig: ReorgOp,
    inv: ReorgOp,
  ): Promise<{ line: string; error: ReorgMismatch } | null> => {
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
    return {
      line: `${head}: ${bad.join("; ")}`,
      error: new ReorgMismatch(inv.seq, {
        expected: pick(inv.from, invDef.compareKeys),
        actual: pick(live, invDef.compareKeys),
      }),
    };
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
      if (problem) throw problem.error;
    }
  }

  for (const { rec, orig, inv } of steps) {
    planned++;
    // Dispatch on the INVERSE op's kind — an inverse may be a different op
    // (remove-project-team rolls back via add-project-team).
    const invDef = OP_REGISTRY[inv.op];
    const target = inv.target.identifier || inv.target.id;
    const intent = `seq ${String(rec.seq)} [${orig.op}] ${target}: ${JSON.stringify(pick(inv.from, invDef.compareKeys))} -> ${JSON.stringify(pick(inv.to, invDef.compareKeys))}`;

    if (write || opts.check) {
      const problem = await preRead(rec, orig, inv);
      if (problem) {
        if (write) throw problem.error;
        drifted.push(problem.line);
      }
    }
    if (!write) {
      opts.onEvent?.({ kind: "rollback", detail: `would revert ${intent}` });
      continue;
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
   * lower bound rather than a total. The cap is applied while paging (a
   * deliberate smoke-path cheapness), so a consumer cannot tell a capped
   * census from a small workspace without this flag.
   */
  partial: boolean;
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
        id key name triageEnabled archivedAt issueCount
        parent { id key }
        states { nodes { id name type position archivedAt } }
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
  const teams = await paged<CensusTeamNode>(
    client, pace, CENSUS_TEAMS_Q, "teams",
    opts.teamKeys?.length ? { filter: { key: { in: opts.teamKeys } } } : {},
    opts.limit,
  );

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
  }>(client, pace, CENSUS_ISSUES_Q, "issues", issueFilter, opts.limit);

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

  const rawLabels = await paged<ReorgLabelNode>(client, pace, CENSUS_LABELS_Q, "issueLabels", {});
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
    client, pace, CENSUS_PROJECTS_Q, "projects", {}, opts.limit,
  );
  const projects = opts.teamKeys?.length
    ? projectsAll.filter((p) =>
        (p.teams?.nodes ?? []).some((t) => opts.teamKeys!.includes(t.key)),
      )
    : projectsAll;

  const initiatives = await paged<ReorgInitiativeNode>(
    client, pace, CENSUS_INITIATIVES_Q, "initiatives", {},
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
    partial: opts.limit !== undefined,
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
}

/**
 * from-completeness invariant: every field an op's `to` changes must have a
 * census anchor in `from` (a rollback recovering a name from the journal is
 * the failure this prevents). Throws on the first incomplete op.
 */
export function assertFromAnchors(ops: ReorgOp[]): void {
  const REQUIRED_FROM: Record<string, string[]> = {
    "create-workspace-label": ["labelId"],
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
  let seq = 0;
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
    for (const t of targets) {
      seq++;
      const to = { ...rule.to };
      if (rule.op === "add-project-team" && typeof to.teamId === "string" && !to.teamIds) {
        const current = sortedStrings(t.from.teamIds);
        to.teamIds = [...new Set([...current, to.teamId])].sort();
      }
      ops.push({
        seq,
        phase: rule.phase,
        op: rule.op,
        target: t.target,
        from: t.from,
        to,
        evidence: rule.evidence,
        reversible: rule.op === "archive-state" ? false : (rule.reversible ?? true),
        ...(rule.approval ? { approval: rule.approval } : {}),
        ...(rule.batchKey ? { batchKey: rule.batchKey } : {}),
      });
    }
  }

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
  ordered.forEach((o, i) => { o.seq = i + 1; });
  return { meta, ops: ordered, warnings };
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
