/**
 * reorg — a generic, plan-file-driven Linear workspace reorganization engine.
 *
 * The estate's rules (team maps, label maps, status rules) live OUTSIDE this
 * repo; this module ships the schema, the op registry, the journaled executor,
 * the pacing, and the verification machinery — nothing workspace-specific.
 *
 * Pipeline: `reorg census` → `reorg plan --rules <file>` → human review →
 * `reorg apply <plan> --phase N [--apply] [--resume]`. Dry-run is the default;
 * `--apply` additionally requires a fresh backup record (see
 * {@link assertFreshBackup}) and gates irreversible ops behind
 * `--allow-irreversible` + a per-op `approval` id.
 *
 * Executor contract (per op, strictly sequential):
 *   pre-read target (abort if live ≠ op.from) → write inside withRetry →
 *   re-read by a DIFFERENT query → compare to op.to → append to applied.jsonl
 *   (fsync). First mismatch stops the run with exit 3. `--resume` skips
 *   journaled-ok seqs. Ops sharing a `batchKey` (identical input) go through
 *   `issueBatchUpdate` in batches of ≤ 50, verified by one filtered read.
 *
 * The Linear MCP is never used. Pacing: token bucket at 2000 req/h plus
 * X-RateLimit-*-Remaining header reads (the SDK exposes response headers on
 * rawRequest), sleeping to reset under 10 %.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";

// ---------------------------------------------------------------------------
// Plan file schema
// ---------------------------------------------------------------------------

export const REORG_OPS = [
  "create-workspace-label",
  "relabel",
  "retire-or-delete-label",
  "set-state",
  "enable-triage",
  "archive-state",
  "set-project-status",
  "set-project-lead",
  "set-project-target",
  "add-project-team",
  "move-project-initiative",
  "archive-issue",
  "archive-project",
  "archive-initiative",
  "move-issue-team",
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
  /** Linear UUID of the target entity. */
  id: string;
  /** Human handle for reports (issue identifier, team key, label name…). */
  identifier: string;
}

export interface ReorgOp {
  seq: number;
  phase: number;
  op: ReorgOpKind;
  target: ReorgTarget;
  /** Live state captured at census time; the executor aborts on drift. */
  from: Record<string, unknown>;
  /** Expected state after the write; the post-write re-read must match. */
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
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Parse + validate a reorg plan file (header `_meta` line + one op per line). */
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
    if (typeof o.evidence !== "string") throw new Error(`${where}: evidence required`);
    if (typeof o.reversible !== "boolean") throw new Error(`${where}: reversible required`);
    if (o.reversible === false) {
      if (o.phase !== 6) throw new Error(`${where}: reversible:false ops are phase-6 only`);
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
  return { meta, ops: ops.sort((a, b) => a.seq - b.seq) };
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
  return records.some((r) => r.seq === "verify" && r.phase === phase && r.ok === true);
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
}

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
  trashed?: boolean | null;
  teams?: { nodes: { id: string }[] } | null;
  initiatives?: { nodes: { id: string }[] } | null;
}

interface ReorgInitiativeNode {
  id: string;
  name: string;
  archivedAt?: string | null;
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
    issueLabel(id: $id) { id name retiredAt }
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
      trashed
      teams { nodes { id } }
      initiatives { nodes { id } }
    }
  }
`;

const INITIATIVE_STATE_Q = /* GraphQL */ `
  query ReorgInitiativeState($id: String!) {
    initiative(id: $id) { id name archivedAt }
  }
`;

const TEAM_STATE_Q = /* GraphQL */ `
  query ReorgTeamState($id: String!) {
    team(id: $id) { id key triageEnabled }
  }
`;

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
  return { retired: d.issueLabel.retiredAt != null, name: d.issueLabel.name };
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
    trashed: p.trashed === true,
    teamIds: (p.teams?.nodes ?? []).map((t) => t.id).sort(),
    initiativeIds: (p.initiatives?.nodes ?? []).map((x) => x.id).sort(),
  };
}

async function readInitiative(ctx: OpCtx, id: string): Promise<Record<string, unknown>> {
  const d = await reorgRaw<{ initiative: ReorgInitiativeNode | null }>(
    ctx.client, INITIATIVE_STATE_Q, { id }, ctx.pace,
  );
  if (!d.initiative) throw new Error(`initiative ${id} not found`);
  return { archived: d.initiative.archivedAt != null };
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

// ---------------------------------------------------------------------------
// Op registry — read (drift check + verify), apply (mutation), inverse
// ---------------------------------------------------------------------------

interface OpDef {
  /** Live read used for the from-drift check AND the post-write compare. */
  readState(ctx: OpCtx, op: ReorgOp): Promise<Record<string, unknown>>;
  /** The write. */
  apply(ctx: OpCtx, op: ReorgOp): Promise<void>;
  /** Inverse op for rollback, or null when no inverse exists. */
  inverse(op: ReorgOp): ReorgOp | null;
  /** Which `to` keys this op compares on the post-write re-read. */
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
  projectArchive: /* GraphQL */ `mutation ReorgProjectArchive($id: String!) {
    projectArchive(id: $id) { success } }`,
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
};

export const OP_REGISTRY: Record<ReorgOpKind, OpDef> = {
  "create-workspace-label": {
    compareKeys: ["labelId"],
    // Creation target does not exist yet; the drift check asserts absence via
    // the planner's from.labelId === null, so the live read is a no-op.
    async readState() {
      return { labelId: null };
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
      // The created id is discovered by a name re-read (different query than
      // the mutation payload) and lands in the journal's `after`.
      const d = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
        ctx.client,
        `query ReorgFindLabel($name: String!) {
          issueLabels(filter: { name: { eq: $name } }) { nodes { id name retiredAt } } }`,
        { name: op.to.name },
        ctx.pace,
      );
      const found = d.issueLabels.nodes[0]?.id;
      if (!found) throw new Error(`created label "${String(op.to.name)}" not found on re-read`);
      op.to.labelId = found;
    },
    inverse: () => null, // inverse of create is delete — irreversible; retire by hand
  },

  "relabel": {
    compareKeys: ["labelIds"],
    readState: (ctx, op) => readIssue(ctx, op.target.id),
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
      return {
        ...op,
        from: op.to,
        to: { add: op.to.remove ?? [], remove: op.to.add ?? [] },
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "retire-or-delete-label": {
    compareKeys: ["retired"],
    readState: (ctx, op) => readLabel(ctx, op.target.id),
    async apply(ctx, op) {
      if (op.to.retired === false) {
        // restore — the rollback path of a retire
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
    async apply(ctx, op) {
      await mutate(ctx, "workflowStateArchive", M.stateArchive, { id: op.target.id });
    },
    inverse: () => null, // no unarchive — recreate is the undo (operator-acknowledged)
  },

  "set-project-status": {
    compareKeys: ["statusId"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
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
    async apply(ctx, op) {
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { leadId: op.to.leadId },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { leadId: op.from.leadId ?? null }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "set-project-target": {
    compareKeys: ["targetDate"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    async apply(ctx, op) {
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { targetDate: op.to.targetDate },
      });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { targetDate: op.from.targetDate ?? null }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "add-project-team": {
    // from.teamIds is the FULL pre-add list — sending only the new id would
    // replace the membership, so the input is always from + the added id.
    compareKeys: ["teamIds"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    async apply(ctx, op) {
      const current = Array.isArray(op.from.teamIds) ? op.from.teamIds : [];
      await mutate(ctx, "projectUpdate", M.projectUpdate, {
        id: op.target.id,
        input: { teamIds: [...new Set([...current, op.to.teamId])] },
      });
    },
    inverse(op) {
      const current = Array.isArray(op.from.teamIds) ? op.from.teamIds : [];
      return {
        ...op,
        from: { teamIds: [...new Set([...current, op.to.teamId])].sort() },
        to: { teamIds: current },
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "move-project-initiative": {
    // to: { fromInitiativeToProjectId?, toInitiativeId? } — remove the old join
    // row, create the new one; verify compares the project's initiativeIds.
    compareKeys: ["initiativeIds"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    async apply(ctx, op) {
      if (typeof op.to.fromInitiativeToProjectId === "string") {
        await mutate(ctx, "initiativeToProjectDelete", M.initiativeToProjectDelete, {
          id: op.to.fromInitiativeToProjectId,
        });
      }
      if (typeof op.to.toInitiativeId === "string") {
        await mutate(ctx, "initiativeToProjectCreate", M.initiativeToProjectCreate, {
          input: { initiativeId: op.to.toInitiativeId, projectId: op.target.id },
        });
      }
    },
    inverse(op) {
      return {
        ...op,
        from: op.to,
        to: {
          // the re-created join gets a fresh id; verify compares membership
          toInitiativeId: op.from.initiativeId ?? null,
        },
        evidence: `rollback of seq ${op.seq}`,
      };
    },
  },

  "archive-issue": {
    compareKeys: ["archived"],
    readState: (ctx, op) => readIssue(ctx, op.target.id),
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
    compareKeys: ["trashed"],
    readState: (ctx, op) => readProject(ctx, op.target.id),
    async apply(ctx, op) {
      // archiveProject is deprecated → trash semantics, restorable via
      // projectUnarchive. The phase-3 canary settles which mutation plans emit.
      const restoring = op.to.trashed === false;
      await mutate(ctx, restoring ? "projectUnarchive" : "projectArchive",
        restoring ? M.projectUnarchive : M.projectArchive, { id: op.target.id });
    },
    inverse(op) {
      return { ...op, from: op.to, to: { trashed: false }, evidence: `rollback of seq ${op.seq}` };
    },
  },

  "archive-initiative": {
    compareKeys: ["archived"],
    readState: (ctx, op) => readInitiative(ctx, op.target.id),
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
    compareKeys: ["teamId", "labelIds", "projectId"],
    readState: (ctx, op) => readIssue(ctx, op.target.id),
    async apply(ctx, op) {
      await mutate(ctx, "issueUpdate", M.issueUpdate, {
        id: op.target.id,
        input: {
          teamId: op.to.teamId,
          // The move drops team labels; the mapped workspace replacements are
          // re-sent in the same input (precondition a).
          addedLabelIds: op.to.reapplyLabelIds ?? [],
          // Destination state sent in the same input when known (phase 5).
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

  "delete-team": {
    compareKeys: [],
    // Terminal op; the census precondition (0 issues/projects/labels) is the
    // from-check, enforced by the phase-6 plan review.
    async readState() {
      return {};
    },
    async apply(ctx, op) {
      await mutate(ctx, "teamDelete", M.teamDelete, { id: op.target.id });
    },
    inverse: () => null, // 30-day grace via the UI; never an inverse op
  },
};

// ---------------------------------------------------------------------------
// move-issue-team preconditions (plan §2b a–d)
// ---------------------------------------------------------------------------

/**
 * Enforced by the executor immediately before a move-issue-team write:
 *  (a) phase 1 verified green in the journal AND the op carries the mapped
 *      workspace label ids to re-send (the move drops team labels);
 *  (b) the destination team is in the issue's project teamIds — either the
 *      census-time from.projectTeamIds already lists it, or the journal holds
 *      an ok add-project-team for that project with a lower seq;
 *  (c) phase 2 verified green (destination state predictable);
 *  (d) the issue's cycleId was captured in op.from (journaled first).
 */
export function assertMovePreconditions(op: ReorgOp, journal: JournalRecord[]): void {
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

  const projectId = op.from.projectId;
  const destTeam = op.to.teamId;
  if (typeof projectId !== "string" || typeof destTeam !== "string") return; // project-less: (b) n/a
  const censusHad =
    Array.isArray(op.from.projectTeamIds) && op.from.projectTeamIds.includes(destTeam);
  const added = journal.some(
    (r) =>
      r.ok &&
      r.op === "add-project-team" &&
      typeof r.seq === "number" &&
      r.seq < op.seq &&
      r.original?.target.id === projectId &&
      Array.isArray(r.original.to.teamIds) &&
      r.original.to.teamIds.includes(destTeam),
  );
  if (!censusHad && !added)
    fail(
      `(b) destination team ${destTeam} is not in project ${projectId} teamIds ` +
        `and no earlier add-project-team op landed it`,
    );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  phase?: number;
  apply: boolean;
  resume: boolean;
  maxOps?: number;
  allowIrreversible: boolean;
  journalPath: string;
  backupRecordPath?: string;
  pace: { bucket: TokenBucket; tracker: RateTracker };
  onEvent?: (ev: { kind: string; detail: string }) => void;
}

export class ReorgMismatch extends Error {
  constructor(
    public readonly seq: number,
    public readonly diff: { expected: unknown; actual: unknown },
  ) {
    super(`op seq ${seq} verify mismatch`);
    this.name = "ReorgMismatch";
  }
}

/** Keys of `from` that differ live, rendered for the abort message. `keys`
 * scopes the comparison to what the op's read actually returns — `from` may
 * carry census context (projectTeamIds, cycleId) that the read omits. */
function drifted(
  from: Record<string, unknown>,
  live: Record<string, unknown>,
  keys: string[],
): string[] {
  const bad: string[] = [];
  for (const k of keys) {
    if (!(k in from)) continue;
    if (JSON.stringify(from[k]) !== JSON.stringify(live[k]))
      bad.push(`${k}: census=${JSON.stringify(from[k])} live=${JSON.stringify(live[k])}`);
  }
  return bad;
}

/** Keys of `to` the live state fails to match after the write. */
function matches(
  to: Record<string, unknown>,
  live: Record<string, unknown>,
  keys: string[],
): string[] {
  const bad: string[] = [];
  for (const k of keys) {
    if (!(k in to)) continue;
    if (JSON.stringify(to[k]) !== JSON.stringify(live[k]))
      bad.push(`${k}: expected=${JSON.stringify(to[k])} actual=${JSON.stringify(live[k])}`);
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

export async function runPlan(
  client: LinearClient,
  plan: ReorgPlan,
  opts: ApplyOptions,
): Promise<{ applied: number; skipped: number; dryRun: boolean }> {
  let ops = plan.ops;
  if (opts.phase !== undefined) ops = ops.filter((o) => o.phase === opts.phase);
  if (opts.maxOps !== undefined) ops = ops.slice(0, opts.maxOps);

  const journal = journalRead(opts.journalPath);
  const done = opts.resume ? journalOkSeqs(journal) : new Set<number>();
  const ctx: OpCtx = { client, pace: opts.pace };

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
      detail: `${ops.length} op(s), ≈${estimateRequests(ops)} request(s) at ${REORG_RATE_PER_HOUR}/h pace`,
    });
    return { applied: 0, skipped: 0, dryRun: true };
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
  let skipped = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];

    if (done.has(op.seq)) {
      skipped++;
      i++;
      continue;
    }

    // Batch run: same batchKey, batchable kind, ≤ 50, identical input.
    if (op.batchKey && (op.op === "relabel" || op.op === "set-state")) {
      const group: ReorgOp[] = [];
      let j = i;
      while (
        j < ops.length &&
        ops[j].batchKey === op.batchKey &&
        ops[j].op === op.op &&
        !done.has(ops[j].seq) &&
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

    const def = OP_REGISTRY[op.op];

    // 1. pre-read + drift check (scoped to the op's read coverage)
    const liveBefore = await def.readState(ctx, op);
    const drift = drifted(op.from, liveBefore, def.compareKeys);
    if (drift.length)
      throw new ReorgMismatch(op.seq, {
        expected: pick(op.from, def.compareKeys),
        actual: pick(liveBefore, def.compareKeys),
      });

    // 2. op-specific preconditions
    if (op.op === "move-issue-team") assertMovePreconditions(op, journal);

    // 3. write
    await def.apply(ctx, op);

    // 4. re-read by a different query + compare
    const liveAfter = await def.readState(ctx, op);
    const bad = matches(op.to, liveAfter, def.compareKeys);
    if (bad.length)
      throw new ReorgMismatch(op.seq, {
        expected: pick(op.to, def.compareKeys),
        actual: pick(liveAfter, def.compareKeys),
      });

    // 5. move-issue-team post-checks: projectId unchanged; labels re-applied;
    //    state corrected via a separate verified set-state when it drifted
    if (op.op === "move-issue-team") {
      if (op.from.projectId && liveAfter.projectId !== op.from.projectId)
        throw new ReorgMismatch(op.seq, {
          expected: { projectId: op.from.projectId },
          actual: { projectId: liveAfter.projectId },
        });
      const reapply = Array.isArray(op.to.reapplyLabelIds) ? op.to.reapplyLabelIds : [];
      const afterLabels = Array.isArray(liveAfter.labelIds) ? liveAfter.labelIds : [];
      const missing = reapply.filter((l) => !afterLabels.includes(l));
      if (missing.length)
        throw new ReorgMismatch(op.seq, {
          expected: { reapplyLabelIds: reapply },
          actual: { labelIds: afterLabels, missing },
        });
      if (!op.to.stateId && op.from.stateId && liveAfter.stateId !== op.from.stateId) {
        // (c) the state drifted in the move — separate verified set-state
        const fix: ReorgOp = {
          ...op,
          op: "set-state",
          from: { stateId: liveAfter.stateId },
          to: { stateId: op.from.stateId },
          evidence: `post-move state correction for seq ${op.seq}`,
        };
        await OP_REGISTRY["set-state"].apply(ctx, fix);
        const fixed = await readIssue(ctx, op.target.id);
        if (fixed.stateId !== op.from.stateId)
          throw new ReorgMismatch(op.seq, {
            expected: { stateId: op.from.stateId },
            actual: { stateId: fixed.stateId },
          });
      }
    }

    // 6. journal (fsync) — carries the original op for rollback + cross-refs
    const rec: JournalRecord = {
      seq: op.seq,
      phase: op.phase,
      op: op.op,
      original: op,
      before: liveBefore,
      after: liveAfter,
      at: new Date().toISOString(),
      ok: true,
    };
    journalAppend(opts.journalPath, rec);
    journal.push(rec);
    applied++;
    opts.onEvent?.({
      kind: "applied",
      detail: `seq ${op.seq} [${op.op}] ${op.target.identifier} ok`,
    });
    i++;
  }
  return { applied, skipped, dryRun: false };
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

  // drift-check every member before the single write
  const befores = new Map<number, Record<string, unknown>>();
  for (const op of group) {
    const def = OP_REGISTRY[op.op];
    const live = await def.readState(ctx, op);
    const drift = drifted(op.from, live, def.compareKeys);
    if (drift.length)
      throw new ReorgMismatch(op.seq, {
        expected: pick(op.from, def.compareKeys),
        actual: pick(live, def.compareKeys),
      });
    befores.set(op.seq, live);
  }

  const input: Record<string, unknown> =
    first.op === "set-state"
      ? { stateId: first.to.stateId }
      : { addedLabelIds: first.to.add ?? [], removedLabelIds: first.to.remove ?? [] };

  await reorgRaw(
    ctx.client,
    M.batchUpdate,
    { ids: group.map((o) => o.target.id), input },
    ctx.pace,
  );

  // one filtered verify read for the whole batch
  interface BatchVerifyNode {
    id: string;
    state?: { id: string } | null;
    labels?: { nodes: { id: string }[] } | null;
  }
  const d = await reorgRaw<{ issues: { nodes: BatchVerifyNode[] } }>(
    ctx.client,
    `query ReorgBatchVerify($ids: [ID!]!) {
      issues(filter: { id: { in: $ids } }) {
        nodes { id state { id } labels { nodes { id } } }
      }
    }`,
    { ids: group.map((o) => o.target.id) },
    ctx.pace,
  );
  const byId = new Map(d.issues.nodes.map((n) => [n.id, n]));
  for (const op of group) {
    const n = byId.get(op.target.id);
    if (!n) throw new ReorgMismatch(op.seq, { expected: "present", actual: "missing" });
    if (op.op === "set-state" && op.to.stateId && n.state?.id !== op.to.stateId)
      throw new ReorgMismatch(op.seq, {
        expected: { stateId: op.to.stateId },
        actual: { stateId: n.state?.id },
      });
    if (op.op === "relabel") {
      const have = new Set((n.labels?.nodes ?? []).map((l) => l.id));
      const add = Array.isArray(op.to.add) ? op.to.add : [];
      const remove = Array.isArray(op.to.remove) ? op.to.remove : [];
      for (const a of add)
        if (!have.has(a as string))
          throw new ReorgMismatch(op.seq, { expected: `label ${String(a)} present`, actual: "absent" });
      for (const r of remove)
        if (have.has(r as string))
          throw new ReorgMismatch(op.seq, { expected: `label ${String(r)} absent`, actual: "present" });
    }
    const rec: JournalRecord = {
      seq: op.seq,
      phase: op.phase,
      op: op.op,
      original: op,
      before: befores.get(op.seq),
      after: { batched: true, batchKey: op.batchKey },
      at: new Date().toISOString(),
      ok: true,
    };
    journalAppend(opts.journalPath, rec);
    journal.push(rec);
  }
}

// ---------------------------------------------------------------------------
// Verify — per-phase: journal completeness + live re-check of every op's `to`
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
  const failures: string[] = [];
  const ctx: OpCtx = { client, pace: opts.pace };

  for (const op of ops) {
    if (!okSeqs.has(op.seq)) {
      failures.push(`seq ${op.seq} [${op.op}] ${op.target.identifier}: no ok journal entry`);
      continue;
    }
    try {
      const def = OP_REGISTRY[op.op];
      const live = await def.readState(ctx, op);
      const bad = matches(op.to, live, def.compareKeys);
      for (const b of bad)
        failures.push(`seq ${op.seq} [${op.op}] ${op.target.identifier}: ${b}`);
    } catch (err) {
      // delete-team targets no longer exist — that IS the end state
      if (op.op === "delete-team") continue;
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

export async function rollbackPhase(
  client: LinearClient,
  journalPath: string,
  phase: number,
  opts: { pace: ApplyOptions["pace"]; onEvent?: ApplyOptions["onEvent"] },
): Promise<{ rolledBack: number; skipped: string[] }> {
  const journal = journalRead(journalPath)
    .filter((r) => r.ok && typeof r.seq === "number" && r.phase === phase)
    .reverse();
  const skipped: string[] = [];
  let rolledBack = 0;
  const ctx: OpCtx = { client, pace: opts.pace };

  for (const rec of journal) {
    const orig = rec.original;
    if (!orig) {
      skipped.push(`seq ${String(rec.seq)}: journal record lacks the original op — cannot invert`);
      continue;
    }
    const def = OP_REGISTRY[orig.op];
    const inv = def.inverse(orig);
    if (!inv) {
      skipped.push(`seq ${String(rec.seq)} [${orig.op}]: no inverse op (manual restore required)`);
      continue;
    }
    await def.apply(ctx, inv);
    const live = await def.readState(ctx, inv);
    const bad = matches(inv.to, live, def.compareKeys);
    if (bad.length)
      throw new ReorgMismatch(inv.seq, {
        expected: pick(inv.to, def.compareKeys),
        actual: pick(live, def.compareKeys),
      });
    rolledBack++;
    opts.onEvent?.({
      kind: "rollback",
      detail: `seq ${String(rec.seq)} [${orig.op}] reverted`,
    });
  }
  return { rolledBack, skipped };
}

// ---------------------------------------------------------------------------
// Census — the read-only snapshot the planner consumes
// ---------------------------------------------------------------------------

export interface CensusOptions {
  teamKeys?: string[];
  limit?: number;
}

export interface CensusData {
  workspace: { id: string; urlKey: string };
  teams: CensusTeamNode[];
  workspaceLabels: ReorgLabelNode[];
  projects: ReorgProjectNode[];
  initiatives: ReorgInitiativeNode[];
  generatedAt: string;
  rateBudget: { limit: number; remaining: number };
}

interface CensusTeamNode extends ReorgTeamNode {
  name: string;
  archivedAt?: string | null;
  issueCount?: number | null;
  labels?: { nodes: ReorgLabelNode[] } | null;
  states?: { nodes: (ReorgStateNode & { position: number })[] } | null;
}

interface CensusTeamsPage {
  teams: {
    nodes: CensusTeamNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/**
 * Snapshot the workspace structure: teams (+ states/labels/issue counts),
 * workspace labels, projects, initiatives. Read-only. `--team` and `--limit`
 * bound the smoke path.
 */
export async function census(
  client: LinearClient,
  opts: CensusOptions,
  pace: ApplyOptions["pace"],
): Promise<CensusData> {
  const teamFilter = opts.teamKeys?.length
    ? `, filter: { key: { in: [${opts.teamKeys.map((k) => JSON.stringify(k)).join(",")}] } }`
    : "";

  const teams: CensusTeamNode[] = [];
  let after: string | null = null;
  do {
    const d: CensusTeamsPage = await reorgRaw<CensusTeamsPage>(
      client,
      `query ReorgCensusTeams($first: Int!, $after: String) {
        teams(first: $first, after: $after, includeArchived: true${teamFilter}) {
          nodes {
            id key name triageEnabled archivedAt issueCount
            labels { nodes { id name retiredAt } }
            states { nodes { id name type position archivedAt } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: Math.min(opts.limit ?? 50, 50), after },
      pace,
    );
    teams.push(...d.teams.nodes);
    after = d.teams.pageInfo.hasNextPage ? d.teams.pageInfo.endCursor : null;
    if (opts.limit && teams.length >= opts.limit) break;
  } while (after);

  const ws = await reorgRaw<{ issueLabels: { nodes: ReorgLabelNode[] } }>(
    client,
    `query ReorgCensusWsLabels {
      issueLabels(filter: { team: { null: true } }, first: 250) { nodes { id name retiredAt } }
    }`,
    {},
    pace,
  );

  const projects = await reorgRaw<{ projects: { nodes: ReorgProjectNode[] } }>(
    client,
    `query ReorgCensusProjects($first: Int!) {
      projects(first: $first, includeArchived: true) {
        nodes {
          id name targetDate trashed
          status { id name }
          lead { id }
          teams { nodes { id } }
          initiatives { nodes { id } }
        }
      }
    }`,
    { first: Math.min(opts.limit ?? 100, 100) },
    pace,
  );

  const initiatives = await reorgRaw<{ initiatives: { nodes: ReorgInitiativeNode[] } }>(
    client,
    `query ReorgCensusInitiatives {
      initiatives(first: 100, includeArchived: true) { nodes { id name archivedAt } }
    }`,
    {},
    pace,
  );

  const org = await reorgRaw<{ organization: { id: string; urlKey: string } }>(
    client,
    `query ReorgOrg { organization { id urlKey } }`,
    {},
    pace,
  );

  return {
    workspace: org.organization,
    teams: opts.limit ? teams.slice(0, opts.limit) : teams,
    workspaceLabels: ws.issueLabels.nodes,
    projects: projects.projects.nodes,
    initiatives: initiatives.initiatives.nodes,
    generatedAt: new Date().toISOString(),
    rateBudget: pace.tracker.snapshot,
  };
}

// ---------------------------------------------------------------------------
// Plan generation — rules file + census → plan ops
// ---------------------------------------------------------------------------

export interface ReorgRule {
  phase: number;
  op: ReorgOpKind;
  /** Selector into the census: {entity, where: {k: v}, teamKey?}. */
  match: { entity: string; where: Record<string, unknown>; teamKey?: string };
  to: Record<string, unknown>;
  evidence: string;
  reversible?: boolean;
  approval?: string;
  batchKey?: string;
}

/**
 * Turn declarative rules + a census snapshot into concrete ops. `from` is
 * captured from the census here — that capture is what makes the executor
 * drift-safe. A rule that matches nothing is an error (a typo, not a no-op).
 */
export function planFromRules(
  rules: ReorgRule[],
  censusData: CensusData,
  meta: ReorgPlanMeta,
): ReorgPlan {
  const ops: ReorgOp[] = [];
  let seq = 0;
  for (const rule of rules) {
    const targets = selectTargets(rule, censusData);
    if (targets.length === 0)
      throw new Error(
        `rule matched nothing: ${rule.op} where ${JSON.stringify(rule.match.where)} (${rule.evidence})`,
      );
    for (const t of targets) {
      seq++;
      ops.push({
        seq,
        phase: rule.phase,
        op: rule.op,
        target: t.target,
        from: t.from,
        to: rule.to,
        evidence: rule.evidence,
        reversible: rule.reversible ?? true,
        ...(rule.approval ? { approval: rule.approval } : {}),
        ...(rule.batchKey ? { batchKey: rule.batchKey } : {}),
      });
    }
  }
  return { meta, ops };
}

function selectTargets(
  rule: ReorgRule,
  censusData: CensusData,
): { target: ReorgTarget; from: Record<string, unknown> }[] {
  const where = rule.match.where;
  const hit = (obj: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => JSON.stringify(obj[k]) === JSON.stringify(v));

  switch (rule.match.entity) {
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
    case "workspace-label": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const l of censusData.workspaceLabels) {
        if (!hit({ name: l.name, retired: l.retiredAt != null })) continue;
        out.push({
          target: { type: "label", id: l.id, identifier: l.name },
          from: { retired: l.retiredAt != null },
        });
      }
      return out;
    }
    case "team-label": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const t of censusData.teams) {
        if (rule.match.teamKey && t.key !== rule.match.teamKey) continue;
        for (const l of t.labels?.nodes ?? []) {
          if (!hit({ name: l.name, retired: l.retiredAt != null })) continue;
          out.push({
            target: { type: "label", id: l.id, identifier: `${t.key}/${l.name}` },
            from: { retired: l.retiredAt != null },
          });
        }
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
        if (!hit({ name: p.name, trashed: p.trashed === true })) continue;
        out.push({
          target: { type: "project", id: p.id, identifier: p.name },
          from: {
            statusId: p.status?.id ?? null,
            leadId: p.lead?.id ?? null,
            targetDate: p.targetDate ?? null,
            teamIds: (p.teams?.nodes ?? []).map((x) => x.id).sort(),
            initiativeIds: (p.initiatives?.nodes ?? []).map((x) => x.id).sort(),
          },
        });
      }
      return out;
    }
    case "initiative": {
      const out: { target: ReorgTarget; from: Record<string, unknown> }[] = [];
      for (const it of censusData.initiatives) {
        if (!hit({ name: it.name, archived: it.archivedAt != null })) continue;
        out.push({
          target: { type: "initiative", id: it.id, identifier: it.name },
          from: { archived: it.archivedAt != null },
        });
      }
      return out;
    }
    default:
      throw new Error(`unknown rule entity ${rule.match.entity}`);
  }
}
