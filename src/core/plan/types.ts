/**
 * Saga Spec 0040 Plan Types and Data Models.
 * Compatible with cerebral-work/saga plan files (.saga/plans/*.toml).
 */

export type OnHaltPolicy = "cancel-dependents" | "halt-all";

export type StepKind = "impl" | "verify" | "test" | "gate";

export type AgentRole = "probe" | "builder" | "critic" | "main_session";

export interface SagaPlanFlow {
  name: string;
  description?: string;
  merge_on_green?: boolean;
  merge_wait_secs?: number;
  max_concurrency?: number;
  open_prs?: boolean;
  pr_base?: string;
  on_halt?: OnHaltPolicy;
  critic_agent?: string;
  builder_model?: string;
  halt_paths?: string[];
}

export interface SagaPlanStep {
  id: string;
  title: string;
  kind: StepKind | string;
  agent?: string;
  deps?: string[];
  verify_cmd?: string[];
  prompt?: string;
  gate?: string;
  duration?: number;
  ready_cmd?: string[];
  ready_max_wait_secs?: number;
  timeout_secs?: number;
}

export interface SagaPlan {
  flow: SagaPlanFlow;
  steps: SagaPlanStep[];
}

export interface CpmStepSchedule {
  id: string;
  role: AgentRole;
  duration: number;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  slack: number;
  critical: boolean;
  wave: number;
}

export interface CpmScheduleResult {
  schema: "saga.plan.v1";
  flow: string;
  max_concurrency: number;
  total_duration: number;
  waves: string[][];
  steps: CpmStepSchedule[];
}

export interface PlanGenerateOptions {
  name?: string;
  description?: string;
  maxConcurrency?: number;
  prBase?: string;
  onHalt?: OnHaltPolicy;
  mergeOnGreen?: boolean;
  mergeWaitSecs?: number;
  openPrs?: boolean;
  criticAgent?: string;
  builderModel?: string;
  team?: string[];
  project?: string;
  milestone?: string;
  labels?: string[];
  state?: string;
  priority?: number;
  openOnly?: boolean;
  includeClosed?: boolean;
  addCritic?: boolean;
  defaultVerifyCmd?: string[];
  from?: "beads" | "linear" | "auto";
}
