//! Organizational workstream orchestration, Design Structure Matrix (DSM) tearing,
//! Steiner process-loss modeling, Hackman team audits, and Goldratt Drum-Buffer-Rope (DBR)
//! queueing admission borrowed from `researchd` (`science/src/workstream.rs`).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Canonical estate wave width limit ($U_3$: at most 3 concurrent subagents per wave).
pub const ESTATE_WAVE_CONCURRENCY_CAP: usize = 3;

/// Default maximum utilization threshold ($\rho_{\max} = 0.80$) before Goldratt Drum-Buffer-Rope holds new admissions.
pub const DEFAULT_DBR_MAX_UTILIZATION: f64 = 0.80;

/// Steiner (1972) structural taxonomy of group tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SteinerTaskKind {
    /// Potential productivity sums across members ($P_{\text{pot}} = \sum c_i$).
    Additive,
    /// Potential productivity equals the strongest member ($P_{\text{pot}} = \max c_i$).
    Disjunctive,
    /// Potential productivity is bounded by the bottleneck member ($P_{\text{pot}} = \min c_i$).
    Conjunctive,
    /// Potential productivity averages across independent judgements ($P_{\text{pot}} = \frac{1}{n}\sum c_i$).
    Compensatory,
}

/// Parameters governing Steiner (1972) process losses across a multi-agent wave.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessLossModel {
    /// Structural task classification.
    pub task_kind: SteinerTaskKind,
    /// Per-link pairwise communication/coordination overhead coefficient ($\alpha \ge 0$).
    pub coordination_loss_per_pair: f64,
    /// Per-additional-agent alignment/drift loss fraction ($\beta \in [0, 1]$).
    pub alignment_drift_rate: f64,
}

/// Quantitative evaluation of Steiner's equation $P_{\text{actual}} = P_{\text{potential}} - L_{\text{coord}} - L_{\text{motiv}}$.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessLossEvaluation {
    /// Structural task classification evaluated.
    pub task_kind: SteinerTaskKind,
    /// Number of agents in the wave ($n$).
    pub team_size: usize,
    /// Number of pairwise communication links $\binom{n}{2} = n(n-1)/2$.
    pub communication_links: usize,
    /// Theoretical potential productivity ($P_{\text{potential}}$).
    pub potential_productivity: f64,
    /// Total coordination loss ($L_{\text{coordination}}$).
    pub coordination_loss: f64,
    /// Total motivation / alignment drift loss ($L_{\text{motivation}}$).
    pub motivation_loss: f64,
    /// Realized net productivity ($P_{\text{actual}}$).
    pub actual_productivity: f64,
    /// True if `team_size <= ESTATE_WAVE_CONCURRENCY_CAP` ($n \le 3$).
    pub within_u3_wave_cap: bool,
}

impl ProcessLossModel {
    /// Construct a new [`ProcessLossModel`].
    #[must_use]
    pub fn new(
        task_kind: SteinerTaskKind,
        coordination_loss_per_pair: f64,
        alignment_drift_rate: f64,
    ) -> Self {
        Self {
            task_kind,
            coordination_loss_per_pair: coordination_loss_per_pair.max(0.0),
            alignment_drift_rate: alignment_drift_rate.clamp(0.0, 1.0),
        }
    }

    /// Evaluate potential and actual productivity for a team with member capacities `member_capacities`.
    #[must_use]
    pub fn evaluate(&self, member_capacities: &[f64]) -> ProcessLossEvaluation {
        let n = member_capacities.len();
        if n == 0 {
            return ProcessLossEvaluation {
                task_kind: self.task_kind,
                team_size: 0,
                communication_links: 0,
                potential_productivity: 0.0,
                coordination_loss: 0.0,
                motivation_loss: 0.0,
                actual_productivity: 0.0,
                within_u3_wave_cap: true,
            };
        }

        let clean_caps: Vec<f64> = member_capacities.iter().map(|c| c.max(0.0)).collect();
        let sum: f64 = clean_caps.iter().sum();

        let potential_productivity = match self.task_kind {
            SteinerTaskKind::Additive => sum,
            SteinerTaskKind::Disjunctive => clean_caps.iter().copied().fold(0.0_f64, f64::max),
            SteinerTaskKind::Conjunctive => {
                clean_caps.iter().copied().fold(f64::INFINITY, f64::min)
            }
            SteinerTaskKind::Compensatory => sum / (n as f64),
        };

        let communication_links = (n * (n - 1)) / 2;
        let coordination_loss = self.coordination_loss_per_pair * (communication_links as f64);
        let motivation_loss = self.alignment_drift_rate * ((n - 1) as f64) * potential_productivity;
        let actual_productivity =
            (potential_productivity - coordination_loss - motivation_loss).max(0.0);

        ProcessLossEvaluation {
            task_kind: self.task_kind,
            team_size: n,
            communication_links,
            potential_productivity,
            coordination_loss,
            motivation_loss,
            actual_productivity,
            within_u3_wave_cap: n <= ESTATE_WAVE_CONCURRENCY_CAP,
        }
    }
}

/// Hackman (2002) five structural conditions required for team effectiveness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HackmanCondition {
    /// Condition 1: Stable, explicit membership boundaries (`herdr` panes + Cortex roles).
    RealBoundedTeam,
    /// Condition 2: Unambiguous EARS specifications and binary pass/fail verification criteria.
    CompellingDirection,
    /// Condition 3: Small wave size ($n \le 3$), clear Maker-Critic role separation, and $\le 15$-line digest norms.
    EnablingStructure,
    /// Condition 4: Reliable access to Transactive Memory (`Reverie`, `XERJ`, R2 CAS).
    SupportiveContext,
    /// Condition 5: Scheduled process consultation (`/wrap` honesty audits, principal gates).
    ExpertCoaching,
}

/// Input configuration for auditing an agent team against Hackman's five conditions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HackmanTeamAudit {
    /// Team or dyad identifier.
    pub team_id: String,
    /// Condition 1: Explicit role identities and workspace isolation boundaries exist.
    pub real_bounded_team: bool,
    /// Condition 2: EARS specification or falsifiable hypothesis with `verify_cmd` is bound.
    pub compelling_direction: bool,
    /// Condition 3: Wave size satisfies $n \le 3$ and Maker/Critic context isolation holds.
    pub enabling_structure: bool,
    /// Condition 4: `Reverie`, `XERJ`, and R2/Cortex handoff surfaces are reachable.
    pub supportive_context: bool,
    /// Condition 5: Critic gate and rollback hooks are active.
    pub expert_coaching: bool,
}

/// Result of evaluating a [`HackmanTeamAudit`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HackmanAuditReport {
    /// Audited team identifier.
    pub team_id: String,
    /// Number of satisfied conditions (out of 5).
    pub satisfied_count: usize,
    /// True if all 5 Hackman effectiveness conditions hold.
    pub ready: bool,
    /// List of unsatisfied conditions blocking high-reliability execution.
    pub missing_conditions: Vec<HackmanCondition>,
}

impl HackmanTeamAudit {
    /// Evaluate all five Hackman conditions and produce a structured [`HackmanAuditReport`].
    #[must_use]
    pub fn evaluate(&self) -> HackmanAuditReport {
        let mut missing = Vec::new();
        if !self.real_bounded_team {
            missing.push(HackmanCondition::RealBoundedTeam);
        }
        if !self.compelling_direction {
            missing.push(HackmanCondition::CompellingDirection);
        }
        if !self.enabling_structure {
            missing.push(HackmanCondition::EnablingStructure);
        }
        if !self.supportive_context {
            missing.push(HackmanCondition::SupportiveContext);
        }
        if !self.expert_coaching {
            missing.push(HackmanCondition::ExpertCoaching);
        }
        let satisfied_count = 5 - missing.len();
        HackmanAuditReport {
            team_id: self.team_id.clone(),
            satisfied_count,
            ready: missing.is_empty(),
            missing_conditions: missing,
        }
    }
}

/// Steward (1981) / Eppinger & Browning (2012) Design Structure Matrix (DSM) coupling classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkstreamCoupling {
    /// Neither workstream depends on the other; can run in parallel.
    Independent,
    /// One-way dependency; must execute sequentially across waves.
    Sequential,
    /// Mutual / cyclic dependency; requires Wave-0 zero-I/O interface tearing.
    Coupled,
}

/// Pairwise coupling relationship between two organizational workstreams in a DSM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkstreamPairRelation {
    /// First workstream identifier.
    pub workstream_a: String,
    /// Second workstream identifier.
    pub workstream_b: String,
    /// Classified DSM coupling regime.
    pub coupling: WorkstreamCoupling,
}

/// Design Structure Matrix (DSM) representing dependencies across organizational workstreams or crates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkstreamDsm {
    /// Ordered list of workstream identifiers.
    pub workstreams: Vec<String>,
    /// Directed dependency map: `dependencies[u]` contains every workstream `v` that `u` depends on.
    pub dependencies: BTreeMap<String, BTreeSet<String>>,
}

/// Complete analysis of a [`WorkstreamDsm`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkstreamDsmAnalysis {
    /// Pairwise coupling classifications for all distinct workstream pairs $(a, b)$ with $a < b$.
    pub pair_relations: Vec<WorkstreamPairRelation>,
    /// Workstream pairs that participate in a mutual/transitive feedback cycle requiring Wave-0 contract tearing.
    pub coupled_pairs_requiring_tearing: Vec<(String, String)>,
    /// True if the workstream graph is acyclic (no `Coupled` feedback loops).
    pub is_tear_free_dag: bool,
}

impl WorkstreamDsm {
    /// Construct a new [`WorkstreamDsm`] from workstream names and `(dependent, prerequisite)` pairs.
    #[must_use]
    pub fn new(workstreams: Vec<String>, edges: Vec<(String, String)>) -> Self {
        let mut unique_ws = BTreeSet::new();
        let mut ordered = Vec::new();
        for ws in workstreams {
            if unique_ws.insert(ws.clone()) {
                ordered.push(ws);
            }
        }
        let mut dependencies: BTreeMap<String, BTreeSet<String>> = ordered
            .iter()
            .map(|w| (w.clone(), BTreeSet::new()))
            .collect();

        for (dep, prereq) in edges {
            if unique_ws.insert(dep.clone()) {
                ordered.push(dep.clone());
            }
            if unique_ws.insert(prereq.clone()) {
                ordered.push(prereq.clone());
            }
            dependencies.entry(prereq.clone()).or_default();
            if dep != prereq {
                dependencies.entry(dep).or_default().insert(prereq);
            }
        }

        Self {
            workstreams: ordered,
            dependencies,
        }
    }

    /// Check whether `source` transitively depends on `target`.
    #[must_use]
    pub fn depends_transitively(&self, source: &str, target: &str) -> bool {
        let mut visited = BTreeSet::new();
        let mut stack = vec![source.to_string()];
        while let Some(curr) = stack.pop() {
            if let Some(prereqs) = self.dependencies.get(&curr) {
                for next in prereqs {
                    if next == target {
                        return true;
                    }
                    if visited.insert(next.clone()) {
                        stack.push(next.clone());
                    }
                }
            }
        }
        false
    }

    /// Analyze the DSM to classify all workstream pairs into `Independent`, `Sequential`, or `Coupled`.
    #[must_use]
    pub fn analyze(&self) -> WorkstreamDsmAnalysis {
        let mut sorted = self.workstreams.clone();
        sorted.sort();

        let mut pair_relations = Vec::new();
        let mut coupled_pairs_requiring_tearing = Vec::new();

        for i in 0..sorted.len() {
            for j in (i + 1)..sorted.len() {
                let a = &sorted[i];
                let b = &sorted[j];
                let a_dep_b = self.depends_transitively(a, b);
                let b_dep_a = self.depends_transitively(b, a);

                let coupling = match (a_dep_b, b_dep_a) {
                    (true, true) => {
                        coupled_pairs_requiring_tearing.push((a.clone(), b.clone()));
                        WorkstreamCoupling::Coupled
                    }
                    (true, false) | (false, true) => WorkstreamCoupling::Sequential,
                    (false, false) => WorkstreamCoupling::Independent,
                };

                pair_relations.push(WorkstreamPairRelation {
                    workstream_a: a.clone(),
                    workstream_b: b.clone(),
                    coupling,
                });
            }
        }

        WorkstreamDsmAnalysis {
            pair_relations,
            is_tear_free_dag: coupled_pairs_requiring_tearing.is_empty(),
            coupled_pairs_requiring_tearing,
        }
    }
}

/// Goldratt (1984) Drum-Buffer-Rope (DBR) admission control decision for a workstream queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbrAdmissionDecision {
    /// Utilization and review buffer are within bounds; Rope admits the next workstream wave.
    Admit,
    /// Review gate buffer is full; Rope holds upstream fabrication until pending reviews clear.
    HoldBufferFull,
    /// Utilization exceeds the DBR safe operating threshold ($\rho > \rho_{\max}$); hold admission.
    HoldUtilizationCliff,
    /// Arrival rate equals or exceeds bottleneck capacity ($\rho \ge 1.0$); queue is mathematically unstable.
    RejectUnstableQueue,
}

/// Input parameters for evaluating Little's Law, Kingman's VUT equation, and DBR Rope admission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkstreamQueueConfig {
    /// Active work-in-progress count ($\text{WIP} = L$).
    pub active_wip: usize,
    /// Current items waiting in the Drum review buffer.
    pub current_buffer_depth: usize,
    /// Maximum allowed items in the Drum review buffer.
    pub max_buffer_depth: usize,
    /// Mean workstream arrival rate ($\lambda > 0$, items per hour).
    pub arrival_rate_per_hour: f64,
    /// Bottleneck (Drum) service rate ($\mu > 0$, items per hour).
    pub service_rate_per_hour: f64,
    /// Coefficient of variation of inter-arrival times ($c_a \ge 0$).
    pub arrival_cv: f64,
    /// Coefficient of variation of service times ($c_s \ge 0$).
    pub service_cv: f64,
    /// Maximum safe utilization before Rope throttling ($\rho_{\max}$, e.g. `0.80`).
    pub max_safe_utilization: f64,
}

/// Computed queueing metrics and Drum-Buffer-Rope admission verdict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkstreamQueueMetrics {
    /// Bottleneck utilization $\rho = \lambda / \mu$.
    pub utilization_rho: f64,
    /// Little's Law average cycle time $W = \text{WIP} / \lambda$ (in hours).
    pub littles_law_cycle_time_hours: f64,
    /// Kingman VUT expected queue wait time $W_q$ (in hours), or `None` if $\rho \ge 1.0$.
    pub kingman_queue_wait_hours: Option<f64>,
    /// Mean service time $\tau = 1 / \mu$ (in hours).
    pub mean_service_time_hours: f64,
    /// Drum-Buffer-Rope admission decision.
    pub admission: DbrAdmissionDecision,
}

impl WorkstreamQueueMetrics {
    /// Evaluate Little's Law, Kingman's VUT approximation, and Drum-Buffer-Rope admission.
    #[must_use]
    pub fn evaluate(cfg: &WorkstreamQueueConfig) -> Self {
        let lambda = cfg.arrival_rate_per_hour.max(1e-9);
        let mu = cfg.service_rate_per_hour.max(1e-9);
        let rho = lambda / mu;
        let tau = 1.0 / mu;
        let littles_law_cycle_time_hours = (cfg.active_wip as f64) / lambda;

        if rho >= 1.0 {
            return Self {
                utilization_rho: rho,
                littles_law_cycle_time_hours,
                kingman_queue_wait_hours: None,
                mean_service_time_hours: tau,
                admission: DbrAdmissionDecision::RejectUnstableQueue,
            };
        }

        let ca2 = cfg.arrival_cv.max(0.0).powi(2);
        let cs2 = cfg.service_cv.max(0.0).powi(2);
        let variability_factor = 0.5 * (ca2 + cs2);
        let utilization_factor = rho / (1.0 - rho);
        let kingman_wq = variability_factor * utilization_factor * tau;

        let admission = if cfg.current_buffer_depth >= cfg.max_buffer_depth {
            DbrAdmissionDecision::HoldBufferFull
        } else if rho > cfg.max_safe_utilization {
            DbrAdmissionDecision::HoldUtilizationCliff
        } else {
            DbrAdmissionDecision::Admit
        };

        Self {
            utilization_rho: rho,
            littles_law_cycle_time_hours,
            kingman_queue_wait_hours: Some(kingman_wq),
            mean_service_time_hours: tau,
            admission,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn steiner_dsm_and_dbr_queue_models_work() {
        let additive = ProcessLossModel::new(SteinerTaskKind::Additive, 0.25, 0.05);
        let eval_3 = additive.evaluate(&[10.0, 10.0, 10.0]);
        assert!(eval_3.within_u3_wave_cap);
        assert!((eval_3.actual_productivity - 26.25).abs() < 1e-6);

        let coupled = WorkstreamDsm::new(
            vec!["a".into(), "b".into()],
            vec![("a".into(), "b".into()), ("b".into(), "a".into())],
        );
        assert!(!coupled.analyze().is_tear_free_dag);

        let cfg = WorkstreamQueueConfig {
            active_wip: 2,
            current_buffer_depth: 1,
            max_buffer_depth: 3,
            arrival_rate_per_hour: 1.0,
            service_rate_per_hour: 2.0,
            arrival_cv: 1.0,
            service_cv: 1.0,
            max_safe_utilization: DEFAULT_DBR_MAX_UTILIZATION,
        };
        let m = WorkstreamQueueMetrics::evaluate(&cfg);
        assert_eq!(m.admission, DbrAdmissionDecision::Admit);
    }
}
