/**
 * Beads integration data models and field mapping definitions.
 * Compatible with gastownhall/beads specification.
 */

export type BeadsStatus = "open" | "in_progress" | "closed" | "blocked" | "deferred";
export type BeadsIssueType = "task" | "bug" | "feature" | "epic" | "chore";
export type BeadsDependencyType = "blocks" | "related" | "duplicates" | "parent-child" | "discovered-from";

export interface BeadsDependency {
  id?: string;
  issue_id: string; // The issue that has the dependency
  depends_on_id: string; // The issue that is depended upon (e.g. blocker)
  type: BeadsDependencyType;
  created_at?: string;
  created_by?: string;
  metadata?: string;
}

export interface BeadsIssue {
  id: string; // e.g. "CER-101" or "bd-a1b2"
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  spec_id?: string;

  status: BeadsStatus;
  priority: number; // 0=critical/P0, 1=high/P1, 2=medium/P2, 3=low/P3, 4=backlog/P4
  issue_type?: BeadsIssueType;
  is_blocked?: boolean;

  assignee?: string;
  owner?: string;
  estimated_minutes?: number;

  created_at: string;
  created_by?: string;
  updated_at: string;
  started_at?: string;
  closed_at?: string;
  close_reason?: string;
  closed_by_session?: string;

  due_at?: string;
  defer_until?: string;

  external_ref?: string; // Canonical URL or Linear issue identifier (e.g. "CER-101")
  source_system?: string; // "linear"
  source_repo?: string;

  labels?: string[];
  dependencies?: BeadsDependency[];
  metadata?: Record<string, unknown>;
}

export interface BeadsMetadata {
  backend: "linearctl" | "http" | "dolt";
  version: string;
  last_sync?: string;
  team_id?: string;
  team_ids?: string[];
  project_id?: string;
  id_mode?: "linear" | "hash";
  sync_relations?: boolean;
}

export interface BeadsConfig {
  linear?: {
    team_id?: string;
    team_ids?: string[];
    project_id?: string;
    last_sync?: string;
    id_mode?: "linear" | "hash";
    priority_map?: Record<number, number>;
    state_map?: Record<string, BeadsStatus>;
    label_type_map?: Record<string, BeadsIssueType>;
    relation_map?: Record<string, BeadsDependencyType>;
  };
}

export interface BeadsSyncOptions {
  pull?: boolean;
  push?: boolean;
  preferLocal?: boolean;
  preferLinear?: boolean;
  team?: string[];
  project?: string;
  useCache?: boolean;
  dryRun?: boolean;
  threshold?: string; // Staleness threshold e.g. "20m"
}

export interface BeadsSyncStats {
  pulled: number;
  created: number;
  updated: number;
  pushed: number;
  pushedCreated: number;
  pushedUpdated: number;
  conflicts: number;
  readyCount: number;
  totalLocal: number;
  durationMs: number;
}

/**
 * Priority Mapping:
 * Linear 1 (Urgent) -> Beads 0 (Critical)
 * Linear 2 (High)   -> Beads 1 (High)
 * Linear 3 (Medium) -> Beads 2 (Medium)
 * Linear 4 (Low)    -> Beads 3 (Low)
 * Linear 0 (None)   -> Beads 4 (Backlog)
 */
export function linearPriorityToBeads(linearPriority: number | null | undefined): number {
  switch (linearPriority) {
    case 1:
      return 0; // Critical
    case 2:
      return 1; // High
    case 3:
      return 2; // Medium
    case 4:
      return 3; // Low
    case 0:
    default:
      return 4; // Backlog / None
  }
}

export function beadsPriorityToLinear(beadsPriority: number): number {
  switch (beadsPriority) {
    case 0:
      return 1; // Urgent
    case 1:
      return 2; // High
    case 2:
      return 3; // Medium
    case 3:
      return 4; // Low
    case 4:
    default:
      return 0; // None
  }
}

/**
 * State Mapping:
 * Linear state type: backlog, unstarted -> Beads "open"
 * Linear state type: started -> Beads "in_progress"
 * Linear state type: completed, canceled -> Beads "closed"
 */
export function linearStateTypeToBeads(stateType: string | null | undefined): BeadsStatus {
  switch (stateType?.toLowerCase()) {
    case "started":
      return "in_progress";
    case "completed":
    case "canceled":
      return "closed";
    case "backlog":
    case "unstarted":
    default:
      return "open";
  }
}

export function beadsStatusToLinearStateType(status: BeadsStatus): "unstarted" | "started" | "completed" {
  switch (status) {
    case "in_progress":
      return "started";
    case "closed":
      return "completed";
    case "open":
    case "blocked":
    case "deferred":
    default:
      return "unstarted";
  }
}

/**
 * Infer Beads issue type from Linear labels or parent structure.
 */
export function inferIssueType(labels: string[], hasChildren: boolean = false): BeadsIssueType {
  if (hasChildren) return "epic";
  const normalized = labels.map((l) => l.toLowerCase());
  if (normalized.some((l) => l.includes("bug") || l.includes("defect") || l.includes("fix"))) {
    return "bug";
  }
  if (normalized.some((l) => l.includes("feat") || l.includes("feature") || l.includes("enhancement"))) {
    return "feature";
  }
  if (normalized.some((l) => l.includes("epic") || l.includes("initiative"))) {
    return "epic";
  }
  if (normalized.some((l) => l.includes("chore") || l.includes("maintenance") || l.includes("refactor"))) {
    return "chore";
  }
  return "task";
}
