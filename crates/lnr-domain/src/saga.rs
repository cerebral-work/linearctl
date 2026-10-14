//! Saga workflow and flow graph domain models borrowed from `researchd` (`science/src/saga.rs`).
//!
//! Provides zero-I/O domain abstractions for multi-step DAG flows, activity
//! kinds, evidence tiers, gate classifications, Critical Path Method (CPM)
//! forward/backward scheduling, and $U_3$-bounded execution wave planning.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::error::DomainError;

/// Activity kind categorizing the execution mode of a Saga step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    /// Verification or testing activity that executes checks or assertions.
    #[default]
    #[serde(alias = "test")]
    Verify,
    /// Implementation or generation activity modifying state.
    Impl,
    /// Gate activity requiring operator or algorithmic sign-off.
    Gate,
    /// Ingestion activity parsing external papers, preprints, or claims.
    Ingest,
    /// Grounding or retrieval activity querying XERJ code indices and reference repositories.
    #[serde(alias = "xerj", alias = "grounding")]
    Ground,
}

/// Verification evidence tiers classifying claim certainty.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceTier {
    /// Self-asserted claim or synthetic simulation with no reproducible receipt.
    #[default]
    Asserted,
    /// Tested in local automated suite or benchmark environment.
    Tested,
    /// Verified with zero exit code, deterministic seed receipt, and signed provenance.
    Verified,
}

/// Gate kind classifying sign-off requirements.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateKind {
    /// Explicit human operator approval (e.g. `heimdal:approval`).
    Approval,
    /// Evidence tier threshold requirement (e.g. `tier:verified`).
    EvidenceThreshold,
    /// Automated safety invariant check.
    SafetyCheck,
    /// Custom named gate identifier.
    Named(String),
}

/// Metadata header describing a Saga flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlowMetadata {
    /// Unique name of the flow.
    pub name: String,
    /// Human-readable description of the flow's purpose.
    #[serde(default)]
    pub description: Option<String>,
}

/// Specification for a single step within a Saga flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SagaStep {
    /// Unique identifier for this step within the flow.
    pub id: String,
    /// Human-readable title of the step.
    pub title: String,
    /// Category of activity.
    #[serde(default)]
    pub kind: ActivityKind,
    /// Optional agent persona or executor designation (e.g. `"auto"`, `"scribe"`).
    #[serde(default)]
    pub agent: Option<String>,
    /// Predecessor step IDs that must complete before this step runs.
    #[serde(default)]
    pub deps: Vec<String>,
    /// Estimated duration or cost weight in seconds (default: `1`).
    #[serde(default = "default_step_duration")]
    pub duration_secs: u64,
    /// Command line arguments for verifying or executing this step.
    #[serde(default)]
    pub verify_cmd: Vec<String>,
    /// Prompt or descriptive guidance text for the step.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Gate identifier if this step requires gated approval.
    #[serde(default)]
    pub gate: Option<String>,
    /// Optional XERJ query string for grounding activities.
    #[serde(default)]
    pub xerj_query: Option<String>,
    /// Optional XERJ index prefix (defaults to `"ref"`).
    #[serde(default)]
    pub xerj_prefix: Option<String>,
}

const fn default_step_duration() -> u64 {
    1
}

impl SagaStep {
    /// Create a new Saga step with minimal required parameters.
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        kind: ActivityKind,
        deps: Vec<String>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            kind,
            agent: None,
            deps,
            duration_secs: 1,
            verify_cmd: Vec::new(),
            prompt: None,
            gate: None,
            xerj_query: None,
            xerj_prefix: None,
        }
    }

    /// Builder method to specify step duration in seconds.
    #[must_use]
    pub fn with_duration_secs(mut self, duration: u64) -> Self {
        self.duration_secs = duration.max(1);
        self
    }

    /// Builder method to attach a verification command.
    #[must_use]
    pub fn with_verify_cmd(mut self, cmd: Vec<String>) -> Self {
        self.verify_cmd = cmd;
        self
    }

    /// Builder method to attach an operator gate.
    #[must_use]
    pub fn with_gate(mut self, gate: impl Into<String>) -> Self {
        self.gate = Some(gate.into());
        self
    }

    /// Builder method to attach an agent persona.
    #[must_use]
    pub fn with_agent(mut self, agent: impl Into<String>) -> Self {
        self.agent = Some(agent.into());
        self
    }

    /// Builder method to attach a prompt.
    #[must_use]
    pub fn with_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }
}

/// Receipt generated when a compensating action is performed during rollback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompensationReceipt {
    /// Identifier of the step being compensated.
    pub step_id: String,
    /// Title of the activity compensated.
    pub activity_title: String,
    /// Descriptive summary of the compensation action taken.
    pub action_taken: String,
    /// Execution status of compensation (`"succeeded"`, `"failed"`).
    pub status: String,
    /// Optional content hash of the rollback evidence.
    #[serde(default)]
    pub receipt_hash: Option<String>,
}

impl CompensationReceipt {
    /// Create a new compensation receipt.
    #[must_use]
    pub fn new(
        step_id: impl Into<String>,
        activity_title: impl Into<String>,
        action_taken: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self {
            step_id: step_id.into(),
            activity_title: activity_title.into(),
            action_taken: action_taken.into(),
            status: status.into(),
            receipt_hash: None,
        }
    }
}

/// Critical Path Method (CPM) timing and slack metrics for a single step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CpmMetrics {
    /// Earliest time the step can start (`ES`).
    pub early_start: u64,
    /// Earliest time the step can finish (`EF = ES + duration`).
    pub early_finish: u64,
    /// Latest time the step can start without delaying project makespan (`LS`).
    pub late_start: u64,
    /// Latest time the step can finish without delaying project makespan (`LF`).
    pub late_finish: u64,
    /// Total slack (`LS - ES`).
    pub total_slack: u64,
    /// Free slack (`min(ES of successors) - EF`).
    pub free_slack: u64,
    /// True if `total_slack == 0`.
    pub is_critical: bool,
}

/// Complete Critical Path Method (CPM) schedule for a [`FlowGraph`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CpmSchedule {
    /// Total minimum project duration in seconds.
    pub makespan: u64,
    /// Topologically ordered step IDs on the critical path (`total_slack == 0`).
    pub critical_path: Vec<String>,
    /// Per-step CPM metrics keyed by step ID.
    pub metrics: HashMap<String, CpmMetrics>,
}

/// Default flow maximum concurrency when unspecified or zero ($U_3 = 3$).
pub const DEFAULT_MAX_CONCURRENCY: usize = 3;

/// Role of an agent assigned to execute a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    /// Fast probe or validation runner (clippy, fmt, checks, test runner).
    Probe,
    /// Implementation builder modifying state or authoring artifacts.
    Builder,
    /// Adversarial reviewer inspecting changes and receipts.
    Critic,
    /// Main session executor or operator gate.
    MainSession,
}

/// Classify a [`SagaStep`] into an [`AgentRole`] based on activity kind and agent persona.
#[must_use]
pub fn classify_step(step: &SagaStep) -> AgentRole {
    if step.kind == ActivityKind::Gate || step.gate.is_some() {
        return AgentRole::MainSession;
    }
    if let Some(agent) = &step.agent {
        match agent.to_ascii_lowercase().as_str() {
            "probe" | "prober" | "verifier" | "observer" | "harvester" | "research-explorer"
            | "auto" | "fast" | "lint" => return AgentRole::Probe,
            "critic" | "review" | "reviewer" | "falsifier" | "evaluator" => {
                return AgentRole::Critic
            }
            "builder" | "impl" | "scientist" | "proponent" | "grounder" | "scribe"
            | "synthesis-writer" | "mutator" | "harness" | "executor" => return AgentRole::Builder,
            "main" | "operator" => return AgentRole::MainSession,
            _ => {}
        }
    }
    match step.kind {
        ActivityKind::Verify => {
            let id = step.id.to_ascii_lowercase();
            let title = step.title.to_ascii_lowercase();
            if id.contains("review")
                || id.contains("critic")
                || id.contains("falsif")
                || title.contains("review")
                || title.contains("critic")
                || title.contains("falsif")
            {
                AgentRole::Critic
            } else {
                AgentRole::Probe
            }
        }
        ActivityKind::Impl => AgentRole::Builder,
        ActivityKind::Gate => AgentRole::MainSession,
        ActivityKind::Ingest | ActivityKind::Ground => AgentRole::Probe,
    }
}

/// A step assigned to an execution wave with CPM metrics and role classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaveStep {
    /// Unique step identifier.
    pub id: String,
    /// Critical Path Method metrics for this step.
    pub cpm: CpmMetrics,
    /// Agent role assigned to execute this step.
    pub role: AgentRole,
}

/// A set of steps runnable concurrently within $U_3$ concurrency constraints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionWave {
    /// 0-based wave index in execution sequence.
    pub wave_index: usize,
    /// Steps assigned to this wave.
    pub steps: Vec<WaveStep>,
}

/// Complete $U_3$-bounded wave execution plan for a [`FlowGraph`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WavePlan {
    /// Ordered execution waves.
    pub waves: Vec<ExecutionWave>,
    /// Underlying CPM schedule.
    pub cpm: CpmSchedule,
    /// Maximum concurrency enforced per wave.
    pub max_concurrency: usize,
}

/// Validated Directed Acyclic Graph (DAG) of Saga steps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FlowGraph {
    /// Name of the flow.
    pub name: String,
    /// Description of the flow.
    #[serde(default)]
    pub description: Option<String>,
    /// All steps in this flow graph.
    pub steps: Vec<SagaStep>,
}

impl FlowGraph {
    /// Build and validate a new [`FlowGraph`] from steps.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError`] if the flow name or any step ID is empty, if duplicate
    /// step IDs exist, if a declared dependency is missing, or if the graph contains a cycle.
    pub fn new(
        name: impl Into<String>,
        description: Option<String>,
        steps: Vec<SagaStep>,
    ) -> Result<Self, DomainError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(DomainError::InvalidFlow(
                "flow name cannot be empty".to_string(),
            ));
        }

        let mut id_set = HashSet::new();
        for step in &steps {
            if step.id.trim().is_empty() {
                return Err(DomainError::InvalidFlow(
                    "step id cannot be empty".to_string(),
                ));
            }
            if !id_set.insert(&step.id) {
                return Err(DomainError::InvalidFlow(format!(
                    "duplicate step id {:?}",
                    step.id
                )));
            }
        }

        for step in &steps {
            for dep in &step.deps {
                if !id_set.contains(dep) {
                    return Err(DomainError::MissingDependency {
                        step: step.id.clone(),
                        missing: dep.clone(),
                    });
                }
            }
        }

        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();

        for step in &steps {
            in_degree.insert(&step.id, step.deps.len());
            for dep in &step.deps {
                adjacency.entry(dep.as_str()).or_default().push(&step.id);
            }
        }

        let mut queue: VecDeque<&str> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&id, _)| id)
            .collect();

        let mut visited = 0;
        while let Some(node) = queue.pop_front() {
            visited += 1;
            if let Some(neighbors) = adjacency.get(node) {
                for &neighbor in neighbors {
                    if let Some(deg) = in_degree.get_mut(neighbor) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(neighbor);
                        }
                    }
                }
            }
        }

        if visited != steps.len() {
            return Err(DomainError::CyclicDependency(name));
        }

        Ok(Self {
            name,
            description,
            steps,
        })
    }

    /// Return steps in deterministic topologically sorted order.
    #[must_use]
    pub fn topological_order(&self) -> Vec<&SagaStep> {
        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();

        for step in &self.steps {
            in_degree.insert(&step.id, step.deps.len());
            for dep in &step.deps {
                adjacency.entry(dep.as_str()).or_default().push(&step.id);
            }
        }

        let mut initial: Vec<&str> = in_degree
            .iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&id, _)| id)
            .collect();
        initial.sort_unstable();
        let mut queue: VecDeque<&str> = initial.into_iter().collect();

        let mut order = Vec::with_capacity(self.steps.len());
        let step_map: HashMap<&str, &SagaStep> =
            self.steps.iter().map(|s| (s.id.as_str(), s)).collect();

        while let Some(node) = queue.pop_front() {
            if let Some(&step) = step_map.get(node) {
                order.push(step);
            }
            if let Some(neighbors) = adjacency.get(node) {
                let mut ready = Vec::new();
                for &neighbor in neighbors {
                    if let Some(deg) = in_degree.get_mut(neighbor) {
                        *deg -= 1;
                        if *deg == 0 {
                            ready.push(neighbor);
                        }
                    }
                }
                ready.sort_unstable();
                for r in ready {
                    queue.push_back(r);
                }
            }
        }

        order
    }

    /// Calculate Critical Path Method (CPM) metrics for all steps in the flow graph.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError`] if the graph cannot be scheduled.
    pub fn compute_cpm(&self) -> Result<CpmSchedule, DomainError> {
        if self.steps.is_empty() {
            return Ok(CpmSchedule {
                makespan: 0,
                critical_path: Vec::new(),
                metrics: HashMap::new(),
            });
        }

        let topo = self.topological_order();

        let mut successors: HashMap<&str, Vec<&str>> = HashMap::new();
        for step in &self.steps {
            for dep in &step.deps {
                successors
                    .entry(dep.as_str())
                    .or_default()
                    .push(step.id.as_str());
            }
        }

        let mut early_start: HashMap<&str, u64> = HashMap::new();
        let mut early_finish: HashMap<&str, u64> = HashMap::new();

        for step in &topo {
            let duration = step.duration_secs.max(1);
            let es = step
                .deps
                .iter()
                .filter_map(|dep| early_finish.get(dep.as_str()).copied())
                .max()
                .unwrap_or(0);
            let ef = es + duration;
            early_start.insert(step.id.as_str(), es);
            early_finish.insert(step.id.as_str(), ef);
        }

        let makespan = early_finish.values().copied().max().unwrap_or(0);

        let mut late_start: HashMap<&str, u64> = HashMap::new();
        let mut late_finish: HashMap<&str, u64> = HashMap::new();

        for step in topo.iter().rev() {
            let duration = step.duration_secs.max(1);
            let lf = match successors.get(step.id.as_str()) {
                Some(succs) if !succs.is_empty() => succs
                    .iter()
                    .filter_map(|succ| late_start.get(*succ).copied())
                    .min()
                    .unwrap_or(makespan),
                _ => makespan,
            };
            let ls = lf.saturating_sub(duration);
            late_finish.insert(step.id.as_str(), lf);
            late_start.insert(step.id.as_str(), ls);
        }

        let mut metrics = HashMap::new();
        let mut critical_path = Vec::new();

        for step in &topo {
            let id = step.id.as_str();
            let es = early_start.get(id).copied().unwrap_or(0);
            let ef = early_finish.get(id).copied().unwrap_or(0);
            let ls = late_start.get(id).copied().unwrap_or(0);
            let lf = late_finish.get(id).copied().unwrap_or(0);
            let total_slack = ls.saturating_sub(es);
            let free_slack = match successors.get(id) {
                Some(succs) if !succs.is_empty() => {
                    let min_succ_es = succs
                        .iter()
                        .filter_map(|succ| early_start.get(*succ).copied())
                        .min()
                        .unwrap_or(makespan);
                    min_succ_es.saturating_sub(ef)
                }
                _ => makespan.saturating_sub(ef),
            };
            let is_critical = total_slack == 0;

            if is_critical {
                critical_path.push(step.id.clone());
            }

            metrics.insert(
                step.id.clone(),
                CpmMetrics {
                    early_start: es,
                    early_finish: ef,
                    late_start: ls,
                    late_finish: lf,
                    total_slack,
                    free_slack,
                    is_critical,
                },
            );
        }

        Ok(CpmSchedule {
            makespan,
            critical_path,
            metrics,
        })
    }

    /// Plan wave execution respecting dependencies and max concurrency ($U_3$ algorithm).
    ///
    /// # Errors
    ///
    /// Returns [`DomainError`] if a cyclic dependency prevents wave assignment.
    pub fn wave_plan(&self, max_concurrency: usize) -> Result<WavePlan, DomainError> {
        let max_concurrency = if max_concurrency == 0 {
            DEFAULT_MAX_CONCURRENCY
        } else {
            max_concurrency
        };
        let cpm = self.compute_cpm()?;
        let mut assigned: HashSet<String> = HashSet::new();
        let mut waves: Vec<ExecutionWave> = Vec::new();

        while assigned.len() < self.steps.len() {
            let mut eligible: Vec<&SagaStep> = self
                .steps
                .iter()
                .filter(|s| !assigned.contains(&s.id))
                .filter(|s| s.deps.iter().all(|d| assigned.contains(d)))
                .collect();

            if eligible.is_empty() {
                return Err(DomainError::CyclicDependency(self.name.clone()));
            }

            eligible.sort_by(|a, b| {
                let Some(ca) = cpm.metrics.get(&a.id) else {
                    return a.id.cmp(&b.id);
                };
                let Some(cb) = cpm.metrics.get(&b.id) else {
                    return a.id.cmp(&b.id);
                };
                cb.is_critical
                    .cmp(&ca.is_critical)
                    .then_with(|| ca.total_slack.cmp(&cb.total_slack))
                    .then_with(|| ca.early_start.cmp(&cb.early_start))
                    .then_with(|| a.id.cmp(&b.id))
            });

            let mut wave_steps = Vec::new();
            for step in eligible.into_iter().take(max_concurrency) {
                if let Some(m) = cpm.metrics.get(&step.id) {
                    wave_steps.push(WaveStep {
                        id: step.id.clone(),
                        cpm: m.clone(),
                        role: classify_step(step),
                    });
                }
            }

            for s in &wave_steps {
                assigned.insert(s.id.clone());
            }

            waves.push(ExecutionWave {
                wave_index: waves.len(),
                steps: wave_steps,
            });
        }

        Ok(WavePlan {
            waves,
            cpm,
            max_concurrency,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn flow_graph_cpm_and_u3_wave_plan() {
        let s1 = SagaStep::new("domain", "Build domain", ActivityKind::Impl, vec![])
            .with_duration_secs(2);
        let s2 = SagaStep::new(
            "cli",
            "Build CLI",
            ActivityKind::Impl,
            vec!["domain".into()],
        )
        .with_duration_secs(3);
        let s3 = SagaStep::new(
            "xtask",
            "Build xtask",
            ActivityKind::Verify,
            vec!["domain".into()],
        )
        .with_duration_secs(1);
        let s4 = SagaStep::new(
            "gate",
            "Sign-off",
            ActivityKind::Gate,
            vec!["cli".into(), "xtask".into()],
        )
        .with_duration_secs(1)
        .with_gate("linear:code-review");

        let fg = FlowGraph::new("lnr-build", None, vec![s1, s2, s3, s4]).unwrap();
        let wp = fg.wave_plan(3).unwrap();
        assert_eq!(wp.cpm.makespan, 6);
        assert_eq!(wp.cpm.critical_path, vec!["domain", "cli", "gate"]);
        assert_eq!(wp.waves.len(), 3);
        assert_eq!(wp.waves[1].steps.len(), 2);
    }
}
