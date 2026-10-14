//! Five-Subject Business School (`Wharton` · `LSE` · `HBS` · `MIT Sloan` · `Stanford`) and
//! Applied I/O Psychology Domain Suite.
//!
//! Executes five formal organizational-economics and psychological models in sequence:
//! 1. **Subject 1 — Multi-Task Principal-Agent Theory & Audit Sampling**
//!    (*Holmström & Milgrom 1991; Aghion & Tirole 1997; Tetlock 1985*): [`PrincipalAgentAuditReport`]
//! 2. **Subject 2 — Transactive Memory Systems (TMS), Relational Coordination & Handoff Entropy**
//!    (*Wegner 1987; Gittell 2002 HBS; Puranam 2014 LSE/INSEAD; Endsley 1995*): [`TransactiveMemoryReport`]
//! 3. **Subject 3 — High-Reliability Organizations (HRO), Normal Accidents & Swiss-Cheese Safety**
//!    (*Perrow 1984; Edmondson 1999 HBS; Weick & Sutcliffe 2001; Reason 1990*): [`HroSafetyReport`]
//! 4. **Subject 4 — Sequential Decision Fatigue, Vigilance Decrement & Choice Architecture**
//!    (*Danziger, Levav & Avnaim-Pesso 2011; Milkman, Beshears et al. 2011 Wharton/HBS; Mackworth 1948*):
//!    [`DecisionHygieneReport`]
//! 5. **Subject 5 — Exploration vs. Exploitation & Parallel vs. Sequential R&D Swarms**
//!    (*Loch, Terwiesch & Thomke 2001 Wharton/HBS; March 1991; Manso 2011*): [`RdPortfolioReport`]

use crate::math::DBR_MAX_UTILIZATION;
use serde::{Deserialize, Serialize};

/// Aghion & Tirole (*Quarterly Journal of Economics*, 1997) authority allocation regime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityRegime {
    /// Agent holds real authority within calibrated `Green` bounds ($\rho_{\text{eff}} \le 0.80$, high credibility).
    RealDelegation,
    /// Critic subagent performs stochastic process-accountability sampling (`Yellow` / `Sweep`).
    CriticSampling,
    /// Human governor retains formal & real authority (`Red` / `Interrupt`).
    FormalExecutiveGate,
    /// Principal is overloaded ($\rho_{\text{eff}} > 1.0$), risking unverified rubber-stamping or `Outcome::Expired`.
    OverloadMoralHazard,
}

impl AuthorityRegime {
    /// Compact label for `80x24` terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RealDelegation => "RealDeleg(Grn)",
            Self::CriticSampling => "CriticSamp(Swp)",
            Self::FormalExecutiveGate => "FormalExec(Red)",
            Self::OverloadMoralHazard => "MoralHazard(>1)",
        }
    }
}

/// Subject 1 diagnostic: Multi-Task Principal-Agent incentive compatibility and optimal Critic audit rate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrincipalAgentAuditReport {
    /// Agent's historical calibration / verification fidelity ($C \in [0, 1]$).
    pub agent_calibration: f64,
    /// Temptation ratio of skipping unmeasured verification ($c_{\text{verify}} / L_{\text{blast}}$).
    pub shortcut_temptation: f64,
    /// Optimal stochastic Critic/governor audit probability $p_{\text{audit}}^* \in [0.05, 1.00]$
    /// under Tetlock (1985) process accountability (independent read-back verification).
    pub optimal_audit_prob: f64,
    /// Audit probability required under naive outcome-only checks (higher due to proxy gaming).
    pub outcome_only_audit_prob: f64,
    /// Active Aghion-Tirole (1997) authority regime.
    pub authority_regime: AuthorityRegime,
}

impl PrincipalAgentAuditReport {
    /// Compute the Holmström-Milgrom (1991) & Aghion-Tirole (1997) audit sampling report.
    ///
    /// - `agent_calibration`: Historical verified-claim rate $\in [0, 1]$ (e.g. `0.88`).
    /// - `verify_cost_ratio`: Ratio of verification effort to blast-radius penalty $c_{\text{verify}} / L_{\text{blast}}$.
    /// - `rho_eff`: Current operator Cobham + Sweller utilization $\rho_{\text{eff}}$.
    #[must_use]
    pub fn evaluate(agent_calibration: f64, verify_cost_ratio: f64, rho_eff: f64) -> Self {
        let cal = agent_calibration.clamp(0.0, 1.0);
        let temptation = verify_cost_ratio.clamp(0.01, 1.0);

        let uncalibrated_gap = 1.0 - cal;
        let optimal_audit_prob = (0.5 * temptation + 0.85 * uncalibrated_gap).clamp(0.05, 1.0);
        let outcome_only_audit_prob = (temptation + 1.35 * uncalibrated_gap).clamp(0.10, 1.0);

        let authority_regime = if rho_eff >= 1.0 {
            AuthorityRegime::OverloadMoralHazard
        } else if cal >= 0.90 && verify_cost_ratio <= 0.15 && rho_eff <= DBR_MAX_UTILIZATION {
            AuthorityRegime::RealDelegation
        } else if verify_cost_ratio <= 0.45 {
            AuthorityRegime::CriticSampling
        } else {
            AuthorityRegime::FormalExecutiveGate
        };

        Self {
            agent_calibration: cal,
            shortcut_temptation: temptation,
            optimal_audit_prob,
            outcome_only_audit_prob,
            authority_regime,
        }
    }
}

/// Subject 2 diagnostic: Wegner (1987) Transactive Memory System (TMS) & Gittell (2002) Relational Coordination.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransactiveMemoryReport {
    /// Total mesh peers across federated hosts (`ceres`, `ganymede`, `markspc`).
    pub mesh_peers: usize,
    /// Episodic/semantic memory observations anchored in `reverie` (`:7437`).
    pub reverie_observations: u64,
    /// Wegner Specialization pillar ($S_{\text{spec}} \in [0, 1]$ across the 5 Subject Matter Meshes).
    pub specialization_score: f64,
    /// Wegner Credibility pillar ($S_{\text{cred}} \in [0, 1]$ from verified handoff round-trips).
    pub credibility_score: f64,
    /// Wegner Coordination pillar ($S_{\text{coord}} \in [0, 1]$, inverse of cross-session drift).
    pub coordination_score: f64,
    /// Composite Gittell (2002, HBS) Relational Coordination & TMS Index $\in [0, 1]$.
    pub composite_tms_index: f64,
    /// Cumulative information loss over a $k$-hop unanchored handoff chain vs. a `reverie`-anchored chain.
    pub unanchored_3hop_loss_pct: f64,
    /// Information loss over a 3-hop chain anchored by `reverie` `RESUMABLE HANDOFF` + `ctx-state`.
    pub reverie_anchored_3hop_loss_pct: f64,
}

impl TransactiveMemoryReport {
    /// Evaluate the estate's Transactive Memory System and multi-hop handoff entropy.
    #[must_use]
    pub fn evaluate(
        mesh_peers: usize,
        reverie_observations: u64,
        specialization_score: f64,
        credibility_score: f64,
        per_hop_unanchored_loss: f64,
    ) -> Self {
        let spec = specialization_score.clamp(0.0, 1.0);
        let cred = credibility_score.clamp(0.0, 1.0);
        let hop_loss = per_hop_unanchored_loss.clamp(0.0, 0.95);

        let unanchored_3hop_loss = 1.0 - (1.0 - hop_loss).powi(3);
        let anchored_hop_loss = hop_loss * 0.18;
        let anchored_3hop_loss = 1.0 - (1.0 - anchored_hop_loss).powi(3);

        let coord = (1.0 - anchored_3hop_loss).clamp(0.0, 1.0);
        let composite_tms_index = (spec + cred + coord) / 3.0;

        Self {
            mesh_peers,
            reverie_observations,
            specialization_score: spec,
            credibility_score: cred,
            coordination_score: coord,
            composite_tms_index,
            unanchored_3hop_loss_pct: unanchored_3hop_loss * 100.0,
            reverie_anchored_3hop_loss_pct: anchored_3hop_loss * 100.0,
        }
    }
}

/// Charles Perrow (1984) *Normal Accidents* Interaction Complexity $\times$ Coupling quadrant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerrowQuadrant {
    /// Linear interactions + Loose coupling (Bounded pod + `DeltaDB` + `Sweep` buffer).
    LinearLooseSafe,
    /// Linear interactions + Tight coupling (Deterministic CI `Land-on-Green` pipeline).
    LinearTightPipeline,
    /// Complex interactions + Loose coupling (Isolated multi-agent `SCI-SWARM` research fan-out).
    ComplexLooseModular,
    /// Complex interactions + Tight coupling (Unbuffered `w26` $N=23$ hub -> Normal Accident zone!).
    ComplexTightNormalAccident,
}

impl PerrowQuadrant {
    /// Compact label for terminal tables.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LinearLooseSafe => "Lin+Loose(Safe)",
            Self::LinearTightPipeline => "Lin+Tight(CI)",
            Self::ComplexLooseModular => "Cmp+Loose(Pod)",
            Self::ComplexTightNormalAccident => "Cmp+Tight(NAT!)",
        }
    }
}

/// Subject 3 diagnostic: Perrow (1984) Normal Accident classification, Reason (1990) Swiss-Cheese
/// defense penetration probability, and Edmondson (1999, HBS) psychological safety / voice index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HroSafetyReport {
    /// Perrow Interaction Complexity $\times$ Tight Coupling classification.
    pub quadrant: PerrowQuadrant,
    /// Number of independent Reason (1990) Swiss-Cheese defensive barriers active ($L$).
    pub defense_layers: usize,
    /// Cumulative breach probability across all $L$ Swiss-Cheese layers with common-mode coupling $\gamma$.
    pub swiss_cheese_breach_prob: f64,
    /// Edmondson (1999, HBS) voice / anti-sycophancy index $\in [0, 1]$ (bad-news parity ratio).
    pub edmondson_voice_index: f64,
}

impl HroSafetyReport {
    /// Evaluate HRO safety for a given interaction complexity $\in [0, 1]$, tight coupling $\in [0, 1]$,
    /// per-layer hole probabilities, and Edmondson bad-news voice parity $\in [0, 1]$.
    #[must_use]
    pub fn evaluate(
        interactive_complexity: f64,
        tight_coupling: f64,
        layer_hole_probs: &[f64],
        edmondson_voice_index: f64,
    ) -> Self {
        let comp = interactive_complexity.clamp(0.0, 1.0);
        let coup = tight_coupling.clamp(0.0, 1.0);
        let voice = edmondson_voice_index.clamp(0.0, 1.0);

        let quadrant = match (comp >= 0.50, coup >= 0.50) {
            (false, false) => PerrowQuadrant::LinearLooseSafe,
            (false, true) => PerrowQuadrant::LinearTightPipeline,
            (true, false) => PerrowQuadrant::ComplexLooseModular,
            (true, true) => PerrowQuadrant::ComplexTightNormalAccident,
        };

        let independent_prod: f64 = if layer_hole_probs.is_empty() {
            1.0
        } else {
            layer_hole_probs
                .iter()
                .map(|&p| p.clamp(0.001, 1.0))
                .product()
        };
        let common_mode_multiplier = 1.0 + 4.0 * coup * (1.0 - voice);
        let swiss_cheese_breach_prob = (independent_prod * common_mode_multiplier).clamp(0.0, 1.0);

        Self {
            quadrant,
            defense_layers: layer_hole_probs.len(),
            swiss_cheese_breach_prob,
            edmondson_voice_index: voice,
        }
    }
}

/// Subject 4 diagnostic: Mackworth (1948) vigilance sensitivity $d'$, Danziger-Levav (2011)
/// sequential decision depletion, and Milkman-Beshears (Wharton/HBS) choice architecture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecisionHygieneReport {
    /// Raw signal-to-noise ratio before `Sweep` filtering (e.g., `32 / 1970 = 0.0162` in `revenant`).
    pub raw_signal_purity: f64,
    /// Post-filter signal purity in `Urgency::Interrupt` after parking compensable cards in `Sweep`.
    pub filtered_signal_purity: f64,
    /// Mackworth signal-detection sensitivity $d'$ under raw unthrottled stream after $k$ decisions.
    pub raw_vigilance_d_prime: f64,
    /// Mackworth signal-detection sensitivity $d'$ under `herdr-attn` filtered + batched stream.
    pub filtered_vigilance_d_prime: f64,
    /// Danziger-Levav (2011, *PNAS*) probability of defaulting to status-quo refusal after $k$ consecutive turns.
    pub sequential_status_quo_bias_pct: f64,
    /// Recommended maximum governance cards per `Sweep` batch before a mandatory reset.
    pub max_cards_per_sweep_batch: usize,
}

impl DecisionHygieneReport {
    /// Evaluate Mackworth vigilance decrement and Danziger-Levav sequential decision depletion.
    #[must_use]
    pub fn evaluate(
        approved_count: u64,
        refused_count: u64,
        consecutive_decisions_k: usize,
        filtered_signal_purity: f64,
    ) -> Self {
        let total = (approved_count + refused_count).max(1) as f64;
        let raw_purity = (approved_count as f64 / total).clamp(0.001, 1.0);
        let filt_purity = filtered_signal_purity.clamp(raw_purity, 1.0);

        let depletion_factor = (-0.035 * (consecutive_decisions_k as f64)).exp();
        let raw_d_prime = 3.20 * depletion_factor * raw_purity.sqrt();
        let batched_depletion = (-0.035 * (consecutive_decisions_k.min(8) as f64)).exp();
        let filtered_d_prime = 3.20 * batched_depletion * filt_purity.sqrt();

        let status_quo_bias = 1.0 - 0.65 * depletion_factor;

        Self {
            raw_signal_purity: raw_purity,
            filtered_signal_purity: filt_purity,
            raw_vigilance_d_prime: raw_d_prime,
            filtered_vigilance_d_prime: filtered_d_prime,
            sequential_status_quo_bias_pct: (status_quo_bias * 100.0).clamp(0.0, 100.0),
            max_cards_per_sweep_batch: 8,
        }
    }
}

/// Loch, Terwiesch & Thomke (*Management Science*, 2001, Wharton & HBS) experimentation strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExperimentStrategy {
    /// $K^* = 1$: High inter-step learning ($\ell \ge 0.65$); run sequential Maker-Reviewer ratchet (`/autoproject`).
    SequentialRatchet,
    /// $2 \le K^* \le 3$: Balanced hybrid wave (parallel bounded builders + sequential synthesis).
    HybridWave,
    /// $4 \le K^* \le 5$: High uncertainty/latency, low inter-step learning ($\ell \le 0.25$); run parallel fan-out (`/deep-research`).
    ParallelSwarmFanout,
}

impl ExperimentStrategy {
    /// Compact label for terminal rendering.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SequentialRatchet => "SeqRatchet(K=1)",
            Self::HybridWave => "HybridWave(2..3)",
            Self::ParallelSwarmFanout => "ParFanout(4..5)",
        }
    }
}

/// Subject 5 diagnostic: Loch-Terwiesch-Thomke (2001) parallel vs. sequential swarm sizing and
/// March (1991) exploration/exploitation balance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RdPortfolioReport {
    /// Task name or R&D workstream profile.
    pub profile_name: String,
    /// Inter-iteration sequential learning rate $\ell \in [0, 1]$.
    pub sequential_learning_rate: f64,
    /// Ratio of delay cost to virtualized `DeltaDB` test cost ($c_{\text{wait}} \cdot \tau_{\text{exec}} / c_{\text{test}}$).
    pub delay_to_test_cost_ratio: f64,
    /// Optimal number of parallel subagent branches $K^* \in \{1, \dots, 5\}$.
    pub optimal_parallel_k: usize,
    /// Prescribed Loch-Terwiesch-Thomke experimentation strategy.
    pub strategy: ExperimentStrategy,
    /// March (1991) exploration fraction $\in [0, 1]$ protecting against premature convergence.
    pub march_exploration_share: f64,
}

impl RdPortfolioReport {
    /// Compute the optimal Loch-Terwiesch-Thomke (2001, Wharton/HBS) parallel wave size $K^*$
    /// and March (1991) exploration share.
    #[must_use]
    pub fn evaluate(
        profile_name: impl Into<String>,
        sequential_learning_rate: f64,
        delay_to_test_cost_ratio: f64,
    ) -> Self {
        let learn = sequential_learning_rate.clamp(0.0, 1.0);
        let cost_ratio = delay_to_test_cost_ratio.max(0.1);

        let raw_k = (cost_ratio * (1.0 - learn)).sqrt().round() as usize;
        let optimal_parallel_k = raw_k.clamp(1, 5);

        let strategy = match optimal_parallel_k {
            1 => ExperimentStrategy::SequentialRatchet,
            2 | 3 => ExperimentStrategy::HybridWave,
            _ => ExperimentStrategy::ParallelSwarmFanout,
        };

        let march_exploration_share = (0.15 + 0.55 * (1.0 - learn)).clamp(0.10, 0.70);

        Self {
            profile_name: profile_name.into(),
            sequential_learning_rate: learn,
            delay_to_test_cost_ratio: cost_ratio,
            optimal_parallel_k,
            strategy,
            march_exploration_share,
        }
    }
}

/// Complete 5-Subject Organizational Science & Applied I/O Psychology Suite Report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FiveSubjectSuiteReport {
    /// Subject 1: Multi-Task Principal-Agent & Optimal Audit Sampling (`Holmström-Milgrom` / `Aghion-Tirole`).
    pub subject1_principal_agent: PrincipalAgentAuditReport,
    /// Subject 2: Transactive Memory Systems & Handoff Entropy (`Wegner` / `Gittell HBS` / `Puranam LSE`).
    pub subject2_transactive_memory: TransactiveMemoryReport,
    /// Subject 3: High-Reliability Orgs & Normal Accidents (`Perrow` / `Edmondson HBS` / `Reason`).
    pub subject3_hro_hub: HroSafetyReport,
    /// Subject 3 comparison: Modular Pod (`w38` / `w2A`) HRO safety.
    pub subject3_hro_modular_pod: HroSafetyReport,
    /// Subject 4: Sequential Decision Fatigue & Vigilance Decrement (`Danziger-Levav` / `Milkman Wharton` / `Mackworth`).
    pub subject4_decision_hygiene: DecisionHygieneReport,
    /// Subject 5a: Deep Research / Literature Synthesis R&D Swarm (`Loch-Terwiesch-Thomke`).
    pub subject5_deep_research: RdPortfolioReport,
    /// Subject 5b: Single-Crate Compiler/Test Ratchet (`Loch-Terwiesch-Thomke`).
    pub subject5_compiler_ratchet: RdPortfolioReport,
}

impl FiveSubjectSuiteReport {
    /// Evaluate all five Business School & Applied I/O Psychology models against live estate metrics.
    #[must_use]
    pub fn evaluate_live_estate(
        mesh_peers: usize,
        reverie_observations: u64,
        revenant_approved: u64,
        revenant_refused: u64,
        active_ws_rho_eff: f64,
    ) -> Self {
        let subject1_principal_agent =
            PrincipalAgentAuditReport::evaluate(0.88, 0.20, active_ws_rho_eff);

        let subject2_transactive_memory =
            TransactiveMemoryReport::evaluate(mesh_peers, reverie_observations, 0.86, 0.91, 0.22);

        let layers = [0.10, 0.10, 0.15, 0.08, 0.12];
        let subject3_hro_hub = HroSafetyReport::evaluate(0.85, 0.80, &layers, 0.65);
        let subject3_hro_modular_pod = HroSafetyReport::evaluate(0.65, 0.20, &layers, 0.94);

        let subject4_decision_hygiene =
            DecisionHygieneReport::evaluate(revenant_approved, revenant_refused, 25, 0.82);

        let subject5_deep_research =
            RdPortfolioReport::evaluate("deep-research-fanout", 0.15, 28.0);
        let subject5_compiler_ratchet =
            RdPortfolioReport::evaluate("compiler-test-ratchet", 0.88, 8.0);

        Self {
            subject1_principal_agent,
            subject2_transactive_memory,
            subject3_hro_hub,
            subject3_hro_modular_pod,
            subject4_decision_hygiene,
            subject5_deep_research,
            subject5_compiler_ratchet,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn subject1_process_accountability_lowers_required_audit_rate_vs_outcome_only() {
        let rep = PrincipalAgentAuditReport::evaluate(0.88, 0.20, 0.62);
        assert!(rep.optimal_audit_prob < rep.outcome_only_audit_prob);
        assert_eq!(rep.authority_regime, AuthorityRegime::CriticSampling);

        let overloaded = PrincipalAgentAuditReport::evaluate(0.88, 0.20, 3.85);
        assert_eq!(
            overloaded.authority_regime,
            AuthorityRegime::OverloadMoralHazard
        );
    }

    #[test]
    fn subject2_reverie_handoff_anchoring_cuts_3hop_entropy_drastically() {
        let tms = TransactiveMemoryReport::evaluate(93, 28_670, 0.86, 0.91, 0.22);
        assert!(tms.unanchored_3hop_loss_pct > 50.0);
        assert!(tms.reverie_anchored_3hop_loss_pct < 12.0);
        assert!(tms.composite_tms_index > 0.85);
    }

    #[test]
    fn subject3_perrow_and_swiss_cheese_distinguish_normal_accident_hub_from_modular_pod() {
        let layers = [0.10, 0.10, 0.15, 0.08, 0.12];
        let hub = HroSafetyReport::evaluate(0.85, 0.80, &layers, 0.65);
        let pod = HroSafetyReport::evaluate(0.65, 0.20, &layers, 0.94);

        assert_eq!(hub.quadrant, PerrowQuadrant::ComplexTightNormalAccident);
        assert_eq!(pod.quadrant, PerrowQuadrant::ComplexLooseModular);
        assert!(hub.swiss_cheese_breach_prob > pod.swiss_cheese_breach_prob * 1.8);
    }

    #[test]
    fn subject4_sweep_filtering_restores_mackworth_vigilance_sensitivity() {
        let hyg = DecisionHygieneReport::evaluate(32, 1938, 25, 0.82);
        assert!(hyg.raw_signal_purity < 0.02);
        assert!(hyg.filtered_vigilance_d_prime > hyg.raw_vigilance_d_prime * 6.0);
        assert!(hyg.sequential_status_quo_bias_pct > 70.0);
    }

    #[test]
    fn subject5_loch_terwiesch_thomke_selects_k5_for_research_and_k1_for_compiler_ratchet() {
        let research = RdPortfolioReport::evaluate("deep-research", 0.15, 28.0);
        let compiler = RdPortfolioReport::evaluate("compiler-ratchet", 0.88, 8.0);

        assert_eq!(research.optimal_parallel_k, 5);
        assert_eq!(research.strategy, ExperimentStrategy::ParallelSwarmFanout);
        assert_eq!(compiler.optimal_parallel_k, 1);
        assert_eq!(compiler.strategy, ExperimentStrategy::SequentialRatchet);
        assert!(research.march_exploration_share > compiler.march_exploration_share);
    }
}
