//! Enterprise Domain Model of Subject Matter Meshes, Applied I/O Psychology, and
//! Organizational Economics (`Wharton` / `LSE` / `Harvard Business School` synthesis).
//!
//! This module codifies the multi-mesh architecture of the Cerebral / Unsigned estate:
//! - **5 Canonical Subject Matter Meshes** (Bounded Contexts):
//!   1. [`SubjectMatterMesh::ControlAndGovernance`] (`revenant`, `godseat`, `vespertin`, `reflex`, `marrow`)
//!   2. [`SubjectMatterMesh::OrchestrationAndMemory`] (`cortex`, `reverie`, `herdr-attn`, `saga`, `linearctl`, `wak`)
//!   3. [`SubjectMatterMesh::ScienceAndSwarm`] (`autoresearcher`, `xerj`, `swarm-control`, `thalamus`, `lattice`)
//!   4. [`SubjectMatterMesh::PlatformAndCompute`] (`unsigned-paas`, `cygnus`, `sbx`, `gs`, `openbao`)
//!   5. [`SubjectMatterMesh::ProductAndDesign`] (`cerebral-design`, `awesome`, `cerebral-site`, `unsigned-site`)
//! - **Graicunas (1933) Span-of-Control Combinatorics**:
//!   $$C(N) = N \left(2^{N-1} + N - 1\right)$$
//! - **Garicano (LSE/Chicago *JPE* 2000) Knowledge Hierarchy & Management by Exception**:
//!   $$s^* = \frac{1}{h \cdot (1 - F(z_A))}$$
//! - **Dell'Acqua, Mollick & Lakhani (HBS/Wharton 2023, 2025) Jagged Frontier Allocation**:
//!   `CyborgTightLoop` ($N = 1$), `CentaurDelegatedPod` ($2 \le N \le 5$), `JaggedOverreachRisk` ($N \ge 6$).
//! - **Bandiera, Prat, Hansen & Sadun (LSE/HBS *JPE* 2020) Executive Attention Index**:
//!   `LeaderMultiUnitSweep` vs. `ManagerFirefighter`.
//! - **Baldwin & Clark (HBS 2000) Modular Design Rules & Mirroring Hypothesis**:
//!   Quantifies the complexity reduction factor when decomposing a monolithic star hub (`w26`, $N=23$)
//!   into modular subject-matter pods of size $N \le 5$.

use crate::math::{default_fleet_profile, evaluate_cobham_mg1, DBR_MAX_UTILIZATION};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Maximum recommended pod size under Cobham $M/G/1$ + Sweller cognitive load ($\rho_{\text{eff}} \le 0.80$).
pub const RECOMMENDED_MAX_POD_SIZE: usize = 5;

/// The five canonical Subject Matter Meshes (Bounded Contexts) across the Cerebral / Unsigned estate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectMatterMesh {
    /// Policy gates (`Green`/`Yellow`/`Red`/`Never`), `sshsig` nonces, Art. 73 duty clocks,
    /// runtime eBPF/Landlock security (`revenant`, `godseat`, `vespertin`, `soma`, `reflex`, `marrow`).
    ControlAndGovernance,
    /// Inter-agent messaging, episodic/semantic memory, durable effect journals, and attention
    /// routing (`cortex`, `reverie`, `wayfinder`, `saga`, `herdr-attn`, `linearctl`, `lnr`, `wak`, `agents`).
    OrchestrationAndMemory,
    /// Autonomous hypothesis loops, hybrid code/paper retrieval, and multi-agent swarm dynamics
    /// (`autoresearcher`, `xerj`, `swarm-control`, `thalamus`, `lattice`).
    ScienceAndSwarm,
    /// Kubernetes (`cygnus`), OpenBao, microVM sandboxes, and cluster infrastructure
    /// (`unsigned-paas`, `paas`, `sbx`, `gs`).
    PlatformAndCompute,
    /// Design systems, brand surfaces, and external web properties
    /// (`cerebral-design`, `awesome`, `cerebral-site`, `unsigned-site`, `unsigned`).
    ProductAndDesign,
}

impl SubjectMatterMesh {
    /// All five canonical subject matter meshes in architectural layer order.
    pub const ALL: [Self; 5] = [
        Self::ControlAndGovernance,
        Self::OrchestrationAndMemory,
        Self::ScienceAndSwarm,
        Self::PlatformAndCompute,
        Self::ProductAndDesign,
    ];

    /// Compact 12-char identifier for `80x24` terminal tables.
    #[must_use]
    pub const fn short_code(self) -> &'static str {
        match self {
            Self::ControlAndGovernance => "CTRL-GOV",
            Self::OrchestrationAndMemory => "ORCH-MEM",
            Self::ScienceAndSwarm => "SCI-SWARM",
            Self::PlatformAndCompute => "PLAT-INFRA",
            Self::ProductAndDesign => "PROD-DESIGN",
        }
    }

    /// Human-readable bounded-context name.
    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::ControlAndGovernance => "Control, Governance & Security Mesh",
            Self::OrchestrationAndMemory => "Orchestration, Transport & Memory Mesh",
            Self::ScienceAndSwarm => "Science, Swarm & Retrieval Mesh",
            Self::PlatformAndCompute => "Platform Infrastructure & Compute Mesh",
            Self::ProductAndDesign => "Product, Brand & Design Surface Mesh",
        }
    }

    /// Primary Team Topologies archetype (Skelton & Pais, 2019).
    #[must_use]
    pub const fn team_topology(self) -> TeamTopologyKind {
        match self {
            Self::ControlAndGovernance => TeamTopologyKind::ComplicatedSubsystem,
            Self::OrchestrationAndMemory => TeamTopologyKind::Enabling,
            Self::ScienceAndSwarm => TeamTopologyKind::StreamAligned,
            Self::PlatformAndCompute => TeamTopologyKind::Platform,
            Self::ProductAndDesign => TeamTopologyKind::StreamAligned,
        }
    }

    /// Classify a repository name, pane title, or working-directory string into its canonical
    /// [`SubjectMatterMesh`].
    #[must_use]
    pub fn classify_surface(surface: &str) -> Self {
        let lower = surface.to_ascii_lowercase();

        if lower.contains("revenant")
            || lower.contains("godseat")
            || lower.contains("vespertin")
            || lower.contains("soma")
            || lower.contains("reflex")
            || lower.contains("marrow")
            || lower.contains("escapement")
            || lower.contains("blackwall")
            || lower.contains("gate")
        {
            return Self::ControlAndGovernance;
        }

        if lower.contains("autoresearch")
            || lower.contains("xerj")
            || lower.contains("swarm-control")
            || lower.contains("thalamus")
            || lower.contains("lattice")
            || lower.contains("science")
            || lower.contains("thuban")
        {
            return Self::ScienceAndSwarm;
        }

        if lower.contains("paas")
            || lower.contains("cygnus")
            || lower.contains("sbx")
            || lower.contains("idunn")
            || lower.contains("kratos")
            || lower.contains("/gs")
            || lower == "gs"
            || lower.contains("openbao")
        {
            return Self::PlatformAndCompute;
        }

        if lower.contains("design")
            || lower.contains("awesome")
            || lower.contains("alrisha")
            || lower.contains("cerebral-site")
            || lower.contains("unsigned-site")
            || lower == "unsigned"
            || lower.contains("rina")
            || lower.contains("negai")
        {
            return Self::ProductAndDesign;
        }

        Self::OrchestrationAndMemory
    }
}

impl fmt::Display for SubjectMatterMesh {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.short_code())
    }
}

/// Team Topologies classification (Skelton & Pais, 2019).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamTopologyKind {
    /// End-to-end value delivery aligned to a research or product stream (`ScienceAndSwarm`, `ProductAndDesign`).
    StreamAligned,
    /// Internal infrastructure consumed `X-as-a-Service` with minimal cognitive load (`PlatformAndCompute`).
    Platform,
    /// Cross-cutting orchestration, memory, and workflow tooling (`OrchestrationAndMemory`).
    Enabling,
    /// High-assurance cryptographic, security, and formal governance kernel (`ControlAndGovernance`).
    ComplicatedSubsystem,
}

impl TeamTopologyKind {
    /// Compact label for terminal rendering.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StreamAligned => "Stream",
            Self::Platform => "Platform",
            Self::Enabling => "Enabling",
            Self::ComplicatedSubsystem => "CompSubsys",
        }
    }
}

/// Human-AI workflow allocation across the Jagged Technological Frontier
/// (Dell'Acqua, Mollick, Lakhani et al., HBS / Wharton 2023 & 2025).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrontierMode {
    /// $N = 1$: Deeply intertwined human-AI co-pilot loop with zero context-switch tax
    /// (`Solo-Chat No-Yank` invariant active).
    CyborgTightLoop,
    /// $2 \le N \le 5$: Explicit modular boundary between autonomous subagent execution and
    /// scheduled human verification (`Centaur` delegation within DBR $\rho_{\text{eff}} \le 0.80$).
    CentaurDelegatedPod,
    /// $N \ge 6$: Span of control exceeds single-operator cognitive bandwidth, risking
    /// `-19pp` Jagged Frontier automation complacency and `Outcome::Expired` TTL breaches.
    JaggedOverreachRisk,
}

impl FrontierMode {
    /// Classify a workspace or cell by its active agent count $N$.
    #[must_use]
    pub const fn from_agent_count(n: usize) -> Self {
        if n <= 1 {
            Self::CyborgTightLoop
        } else if n <= RECOMMENDED_MAX_POD_SIZE {
            Self::CentaurDelegatedPod
        } else {
            Self::JaggedOverreachRisk
        }
    }

    /// Compact label for terminal rendering.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CyborgTightLoop => "Cyborg(N=1)",
            Self::CentaurDelegatedPod => "Centaur(2..5)",
            Self::JaggedOverreachRisk => "Overreach(>=6)",
        }
    }
}

/// Executive time-and-attention allocation behavior (Bandiera, Prat, Hansen & Sadun,
/// LSE / HBS *Journal of Political Economy* 2020, $N = 1,114$ CEOs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutiveBehaviorMode {
    /// High-leverage multi-unit orchestration via batched `Sweep` digests and bounded pods
    /// ($\rho_{\text{eff}} \le 0.80$). Associated with `+13%..+21%` firm TFP in Bandiera et al.
    LeaderMultiUnitSweep,
    /// Reactive 1-on-1 operational firefighting driven by unthrottled interrupts or oversized
    /// star hubs ($\rho_{\text{eff}} > 0.80$).
    ManagerFirefighter,
}

impl ExecutiveBehaviorMode {
    /// Compact label for terminal rendering.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LeaderMultiUnitSweep => "Leader(Sweep)",
            Self::ManagerFirefighter => "Mgr(Firefight)",
        }
    }
}

/// Applied I/O Psychology arousal and cognitive demand-resource zone
/// (Yerkes & Dodson 1908; Bakker & Demerouti JD-R Model 2007; Sweller 1988).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArousalZone {
    /// $\rho_{\text{eff}} < 0.15$: Low stimulation; risk of Mackworth vigilance decrement on rare gates.
    HypoVigilant,
    /// $0.15 \le \rho_{\text{eff}} \le 0.80$: Optimal Yerkes-Dodson eustress and JD-R resource balance.
    OptimalFlow,
    /// $0.80 < \rho_{\text{eff}} < 1.00$: Extraneous Sweller switching load dominates; queue tails grow.
    SwitchingFatigue,
    /// $\rho_{\text{eff}} \ge 1.00$: Unstable queue ($\rho_{\text{eff}} \ge 1$); guaranteed starvation and TTL expiry.
    ThunderingHerdCollapse,
}

impl ArousalZone {
    /// Classify an effective utilization ratio $\rho_{\text{eff}}$ into its I/O psychology arousal zone.
    #[must_use]
    pub fn from_utilization(rho_eff: f64) -> Self {
        if rho_eff < 0.15 {
            Self::HypoVigilant
        } else if rho_eff <= DBR_MAX_UTILIZATION {
            Self::OptimalFlow
        } else if rho_eff < 1.0 {
            Self::SwitchingFatigue
        } else {
            Self::ThunderingHerdCollapse
        }
    }

    /// Compact label for terminal rendering.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HypoVigilant => "HypoVigil",
            Self::OptimalFlow => "Flow(Opt)",
            Self::SwitchingFatigue => "SwFatigue",
            Self::ThunderingHerdCollapse => "HerdCollapse",
        }
    }
}

/// V. A. Graicunas (1933) *Relationships in Organization* span-of-control combinatorics.
///
/// For an executive supervising $N$ direct agent lanes in a shared coordination hub:
/// - Direct single relationships: $N$
/// - Cross horizontal relationships: $N(N - 1)$
/// - Direct group relationships: $N(2^{N - 1} - 1)$
/// - Total socio-technical relationships:
///   $$C(N) = N \left(2^{N - 1} + N - 1\right)$$
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraicunasSpan {
    /// Number of direct reports / agent lanes ($N$).
    pub n: usize,
    /// Direct single dyads ($N$).
    pub direct_single: u64,
    /// Horizontal cross-agent pairs ($N(N - 1)$).
    pub cross_horizontal: u64,
    /// Subgroup combinations ($N(2^{N - 1} - 1)$).
    pub direct_group: u64,
    /// Total relationships $C(N) = N(2^{N - 1} + N - 1)$.
    pub total_relationships: u64,
}

impl GraicunasSpan {
    /// Compute Graicunas's span-of-control metrics for $N$ agents using saturating arithmetic.
    #[must_use]
    pub const fn compute(n: usize) -> Self {
        if n == 0 {
            return Self {
                n: 0,
                direct_single: 0,
                cross_horizontal: 0,
                direct_group: 0,
                total_relationships: 0,
            };
        }
        let n_u64 = n as u64;
        let direct_single = n_u64;
        let cross_horizontal = n_u64.saturating_mul(n_u64.saturating_sub(1));
        let shift = if n - 1 > 62 { 62_u32 } else { (n - 1) as u32 };
        let pow2 = match 1_u64.checked_shl(shift) {
            Some(v) => v,
            None => u64::MAX,
        };
        let direct_group = n_u64.saturating_mul(pow2.saturating_sub(1));
        let total_relationships = direct_single
            .saturating_add(cross_horizontal)
            .saturating_add(direct_group);

        Self {
            n,
            direct_single,
            cross_horizontal,
            direct_group,
            total_relationships,
        }
    }
}

/// Luis Garicano (LSE / Chicago *Journal of Political Economy*, 2000)
/// *"Hierarchies and the Organization of Knowledge in Production"* model.
///
/// Production agents handle routine problems drawn from $F(z)$ up to threshold $z_A$
/// (fraction $F(z_A)$ handled autonomously via `Green` or batched via `Sweep`).
/// Exceptions occur with probability $p_{\text{exc}} = 1 - F(z_A)$ and require human
/// governor intervention costing attention fraction $h$ per agent.
///
/// The maximum sustainable span of control per human governor is:
/// $$s^* = \frac{1}{h \cdot (1 - F(z_A))}$$
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GaricanoHierarchyReport {
    /// Fraction of routine agent turns resolved without immediate human interruption ($F(z_A) \in [0, 1)$).
    pub routine_autonomy_fraction: f64,
    /// Exception escalation rate ($1 - F(z_A)$).
    pub exception_rate: f64,
    /// Human governor attention cost per escalated exception ($h$, including Sweller switch tax).
    pub helping_cost_h: f64,
    /// Optimal Garicano span of control $s^* = \frac{1}{h(1 - F(z_A))}$ (capped by DBR $\rho_{\text{max}} = 0.80$).
    pub optimal_span_dbr: f64,
    /// Empirical refusal/noise ratio observed on live governance approvals (e.g., `revenant` `1938/1970`).
    pub empirical_refusal_noise_ratio: Option<f64>,
}

impl GaricanoHierarchyReport {
    /// Evaluate Garicano's knowledge-hierarchy span of control under a given routine autonomy
    /// fraction $F(z_A)$ and per-exception helping cost $h$.
    #[must_use]
    pub fn evaluate(
        routine_autonomy_fraction: f64,
        helping_cost_h: f64,
        empirical_approved: Option<u64>,
        empirical_refused: Option<u64>,
    ) -> Self {
        let f_z = routine_autonomy_fraction.clamp(0.0, 0.999);
        let exc_rate = 1.0 - f_z;
        let h = helping_cost_h.max(0.001);
        let raw_span = 1.0 / (h * exc_rate);
        let optimal_span_dbr = raw_span * DBR_MAX_UTILIZATION;

        let empirical_refusal_noise_ratio = match (empirical_approved, empirical_refused) {
            (Some(app), Some(refused)) if app + refused > 0 => {
                Some(refused as f64 / (app + refused) as f64)
            }
            _ => None,
        };

        Self {
            routine_autonomy_fraction: f_z,
            exception_rate: exc_rate,
            helping_cost_h: h,
            optimal_span_dbr,
            empirical_refusal_noise_ratio,
        }
    }
}

/// Complete socio-technical and queueing diagnostic for a Subject Matter Mesh or Workspace Cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeshCellDiagnostic {
    /// Canonical Subject Matter Mesh.
    pub mesh: SubjectMatterMesh,
    /// Team Topologies archetype (Skelton & Pais 2019).
    pub topology: TeamTopologyKind,
    /// Number of active agent panes in this mesh/cell ($N$).
    pub agents: usize,
    /// Number of distinct workspaces spanned by this mesh.
    pub workspaces: usize,
    /// Effective Cobham + Sweller utilization $\rho_{\text{eff}}$ if managed as a single unpartitioned hub.
    pub unpartitioned_rho_eff: f64,
    /// Expected Rank-0 (`Permission`) wait time in seconds if unpartitioned.
    pub unpartitioned_wait_p0_sec: Option<f64>,
    /// Graicunas relationship complexity $C(N)$ if unpartitioned.
    pub graicunas: GraicunasSpan,
    /// Recommended number of Baldwin & Clark modular pods of size $N \le 5$.
    pub recommended_pods: usize,
    /// Total Graicunas relationships after modularizing into pods of size $N \le 5$.
    pub modular_graicunas_total: u64,
    /// HBS/Wharton Jagged Frontier allocation mode.
    pub frontier_mode: FrontierMode,
    /// LSE/HBS Executive time-allocation mode.
    pub executive_mode: ExecutiveBehaviorMode,
    /// Applied I/O Psychology arousal zone.
    pub arousal_zone: ArousalZone,
}

impl MeshCellDiagnostic {
    /// Evaluate a Subject Matter Mesh or organizational unit with `agents` lanes across `workspaces`.
    #[must_use]
    pub fn evaluate(
        mesh: SubjectMatterMesh,
        agents: usize,
        workspaces: usize,
        switch_cost_sec: f64,
    ) -> Self {
        let effective_n = agents.max(1);
        let prof = default_fleet_profile(effective_n, true);
        let cobham = evaluate_cobham_mg1(&prof, switch_cost_sec);
        let graicunas = GraicunasSpan::compute(agents);

        let recommended_pods = if agents == 0 {
            0
        } else {
            agents.div_ceil(RECOMMENDED_MAX_POD_SIZE)
        };

        let mut rem = agents;
        let mut modular_graicunas_total: u64 = 0;
        while rem > 0 {
            let pod_n = rem.min(RECOMMENDED_MAX_POD_SIZE);
            modular_graicunas_total = modular_graicunas_total
                .saturating_add(GraicunasSpan::compute(pod_n).total_relationships);
            rem -= pod_n;
        }

        let rho_eff = if agents == 0 {
            0.0
        } else {
            cobham.effective_utilization
        };
        let frontier_mode = FrontierMode::from_agent_count(agents);
        let executive_mode = if rho_eff <= DBR_MAX_UTILIZATION {
            ExecutiveBehaviorMode::LeaderMultiUnitSweep
        } else {
            ExecutiveBehaviorMode::ManagerFirefighter
        };
        let arousal_zone = ArousalZone::from_utilization(rho_eff);

        Self {
            mesh,
            topology: mesh.team_topology(),
            agents,
            workspaces,
            unpartitioned_rho_eff: rho_eff,
            unpartitioned_wait_p0_sec: if agents == 0 {
                Some(0.0)
            } else {
                cobham.wait_sec_by_rank[0]
            },
            graicunas,
            recommended_pods,
            modular_graicunas_total,
            frontier_mode,
            executive_mode,
            arousal_zone,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn graicunas_span_matches_canonical_values_for_pods_vs_star_hub() {
        let s1 = GraicunasSpan::compute(1);
        assert_eq!(s1.total_relationships, 1);

        let s4 = GraicunasSpan::compute(4);
        assert_eq!(s4.total_relationships, 44);

        let s5 = GraicunasSpan::compute(5);
        assert_eq!(s5.total_relationships, 100);

        let s23 = GraicunasSpan::compute(23);
        assert_eq!(s23.total_relationships, 96_469_498);
    }

    #[test]
    fn baldwin_clark_modularization_collapses_w26_complexity_by_190000x() {
        let diag =
            MeshCellDiagnostic::evaluate(SubjectMatterMesh::OrchestrationAndMemory, 23, 1, 9.5);
        assert_eq!(diag.graicunas.total_relationships, 96_469_498);
        assert_eq!(diag.recommended_pods, 5);
        assert_eq!(diag.modular_graicunas_total, 418);
        assert_eq!(diag.frontier_mode, FrontierMode::JaggedOverreachRisk);
        assert_eq!(
            diag.executive_mode,
            ExecutiveBehaviorMode::ManagerFirefighter
        );
        assert_eq!(diag.arousal_zone, ArousalZone::ThunderingHerdCollapse);
    }

    #[test]
    fn surface_classifier_maps_estate_repos_to_five_canonical_meshes() {
        assert_eq!(
            SubjectMatterMesh::classify_surface("revenant"),
            SubjectMatterMesh::ControlAndGovernance
        );
        assert_eq!(
            SubjectMatterMesh::classify_surface("vespertin"),
            SubjectMatterMesh::ControlAndGovernance
        );
        assert_eq!(
            SubjectMatterMesh::classify_surface("cortex"),
            SubjectMatterMesh::OrchestrationAndMemory
        );
        assert_eq!(
            SubjectMatterMesh::classify_surface("autoresearcher"),
            SubjectMatterMesh::ScienceAndSwarm
        );
        assert_eq!(
            SubjectMatterMesh::classify_surface("swarm-control"),
            SubjectMatterMesh::ScienceAndSwarm
        );
        assert_eq!(
            SubjectMatterMesh::classify_surface("unsigned-paas"),
            SubjectMatterMesh::PlatformAndCompute
        );
        assert_eq!(
            SubjectMatterMesh::classify_surface("cerebral-design"),
            SubjectMatterMesh::ProductAndDesign
        );
    }

    #[test]
    fn garicano_hierarchy_reflects_optimal_pod_span_and_refusal_noise() {
        let rep = GaricanoHierarchyReport::evaluate(0.80, 0.80, Some(32), Some(1938));
        assert!((rep.optimal_span_dbr - 5.0).abs() < 1e-6);
        let noise = rep.empirical_refusal_noise_ratio.unwrap_or(0.0);
        assert!(noise > 0.98);
    }
}
