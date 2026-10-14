//! Mathematical queueing and cognitive-load analyzer for attention routing.
//!
//! Implements the closed-form equations derived in the Cerebral Attention Routing Deep Research Pass:
//! 1. **Cobham's (1954) Non-Preemptive Priority $M/G/1$ Waiting-Time Law**:
//!    $$W_{q,k} = \frac{R}{(1 - \sigma_{k-1})(1 - \sigma_k)}, \qquad R = \frac{1}{2}\sum_{i=0}^{3}\lambda_i \tau_{e,i}^2(1 + C_{s,i}^2)$$
//! 2. **Sweller Context-Switching Effective Utilization**:
//!    $$\tau_{e,k} = \tau_k + p_{\text{swap},k}\Delta\tau_{\text{sw}}, \qquad \rho_{\text{eff}} = \sum_{k=0}^{3}\lambda_k \tau_{e,k}$$
//! 3. **Drum-Buffer-Rope Stability Ceiling ($\rho_{\max} = 0.80$)** and **TTL Lower Bound**.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Static priority class for Cobham $M/G/1$ attention routing (`Permission = 0` highest, `Idle = 3` lowest).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    /// Rank 0: Agent is blocked on a tool permission or security gate.
    Permission = 0,
    /// Rank 1: Agent is waiting for explicit operator input or a question response.
    Input = 1,
    /// Rank 2: Agent completed a turn or task and has fresh output ready for review.
    Ready = 2,
    /// Rank 3: Agent is idle and available for new work assignment.
    Idle = 3,
}

impl Priority {
    /// Numeric rank index in `0..=3` (0 is highest static priority).
    #[must_use]
    pub const fn rank_index(self) -> usize {
        match self {
            Self::Permission => 0,
            Self::Input => 1,
            Self::Ready => 2,
            Self::Idle => 3,
        }
    }

    /// Base priority score $p_k$ used in Kleinrock linear aging:
    /// $P_k(t) = p_k + \alpha (t - t_{\text{enqueue}})$.
    #[must_use]
    pub const fn base_score(self) -> f64 {
        match self {
            Self::Permission => 300.0,
            Self::Input => 200.0,
            Self::Ready => 100.0,
            Self::Idle => 0.0,
        }
    }

    /// Parse a priority class from its canonical lowercase label.
    #[must_use]
    pub fn from_label(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "permission" | "perm" | "p0" => Some(Self::Permission),
            "input" | "question" | "p1" => Some(Self::Input),
            "ready" | "done" | "p2" => Some(Self::Ready),
            "idle" | "p3" => Some(Self::Idle),
            _ => None,
        }
    }

    /// Canonical short label.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Input => "input",
            Self::Ready => "ready",
            Self::Idle => "idle",
        }
    }
}

impl fmt::Display for Priority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Drum-Buffer-Rope maximum safe effective operator utilization ($\rho_{\max} = 0.80$).
pub const DBR_MAX_UTILIZATION: f64 = 0.80;

/// Arrival and service parameters for one priority rank $k \in \{0, 1, 2, 3\}$.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RankTraffic {
    /// Priority class (`Permission = 0` .. `Idle = 3`).
    pub priority: Priority,
    /// Arrival rate $\lambda_k$ in events per second (`>= 0.0`).
    pub lambda_per_sec: f64,
    /// Mean pure operator service time $\tau_k$ in seconds (`> 0.0`).
    pub service_sec: f64,
    /// Squared coefficient of variation $C_{s,k}^2 = \text{Var}(S_k)/\tau_k^2$ (`1.0` for exponential).
    pub cv_squared: f64,
    /// Probability $p_{\text{swap},k} \in [0, 1]$ that serving this event switches panes.
    pub swap_prob: f64,
}

/// Complete Cobham $M/G/1$ and Sweller cognitive-load evaluation across all 4 priority ranks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CobhamReport {
    /// Raw operator utilization without context-switch reload penalty ($\sum_k \lambda_k \tau_k$).
    pub raw_utilization: f64,
    /// Effective operator utilization including Sweller switch reload penalty ($\sum_k \lambda_k \tau_{e,k}$).
    pub effective_utilization: f64,
    /// Fraction of operator capacity consumed purely by context-switching ($\rho_{\text{eff}} - \rho_{\text{raw}}$).
    pub switching_overhead: f64,
    /// Mean residual service time $R$ in seconds at a random arrival epoch.
    pub residual_service_sec: f64,
    /// Cumulative effective utilization $\sigma_k = \sum_{i=0}^{k} \rho_{e,i}$ for each rank $k \in 0..4$.
    pub cumulative_load: [f64; 4],
    /// Expected queue waiting time $W_{q,k}$ in seconds for each rank (`None` if $\sigma_k \ge 1.0$, i.e. starved).
    pub wait_sec_by_rank: [Option<f64>; 4],
    /// Total turnaround time $W_k = W_{q,k} + \tau_{e,k}$ in seconds for each rank.
    pub sojourn_sec_by_rank: [Option<f64>; 4],
    /// Whether $\rho_{\text{eff}} \le 0.80$ (Drum-Buffer-Rope cognitive stability regime).
    pub within_dbr_ceiling: bool,
    /// Lowest rank index $k$ that is starved ($\sigma_k \ge 1.0$), if any.
    pub first_starved_rank: Option<Priority>,
    /// Recommended minimum `Interrupt` TTL in seconds ($W_{q,0}^{(p99)} + 2\tau_{e,0}$) to avoid premature expiry.
    pub recommended_interrupt_ttl_sec: u64,
}

/// Evaluate Cobham's (1954) non-preemptive priority $M/G/1$ waiting times and Sweller
/// switching-load utilization for a 4-rank traffic profile and switch reload cost `switch_cost_sec` ($\Delta\tau_{\text{sw}}$).
#[must_use]
pub fn evaluate_cobham_mg1(ranks: &[RankTraffic; 4], switch_cost_sec: f64) -> CobhamReport {
    let delta_sw = if switch_cost_sec.is_finite() && switch_cost_sec >= 0.0 {
        switch_cost_sec
    } else {
        0.0
    };

    let mut raw_utilization = 0.0;
    let mut effective_utilization = 0.0;
    let mut residual_service_sec = 0.0;
    let mut cumulative_load = [0.0_f64; 4];
    let mut effective_service = [0.0_f64; 4];

    for (idx, r) in ranks.iter().enumerate() {
        let lambda = r.lambda_per_sec.max(0.0);
        let tau = r.service_sec.max(0.0);
        let p_swap = r.swap_prob.clamp(0.0, 1.0);
        let cv2 = r.cv_squared.max(0.0);

        let tau_eff = tau + p_swap * delta_sw;
        effective_service[idx] = tau_eff;

        let rho_raw = lambda * tau;
        let rho_eff = lambda * tau_eff;

        raw_utilization += rho_raw;
        effective_utilization += rho_eff;
        cumulative_load[idx] = effective_utilization;

        // Second moment of service time E[S_k^2] = tau_eff^2 * (1 + C_{s,k}^2)
        residual_service_sec += 0.5 * lambda * tau_eff * tau_eff * (1.0 + cv2);
    }

    let mut wait_sec_by_rank = [None; 4];
    let mut sojourn_sec_by_rank = [None; 4];
    let mut first_starved_rank = None;

    for idx in 0..4 {
        let sigma_prev = if idx == 0 {
            0.0
        } else {
            cumulative_load[idx - 1]
        };
        let sigma_curr = cumulative_load[idx];

        if sigma_prev < 1.0 && sigma_curr < 1.0 {
            let denom = (1.0 - sigma_prev) * (1.0 - sigma_curr);
            if denom > 1e-9 {
                let w_q = residual_service_sec / denom;
                wait_sec_by_rank[idx] = Some(w_q);
                sojourn_sec_by_rank[idx] = Some(w_q + effective_service[idx]);
            }
        } else if first_starved_rank.is_none() {
            first_starved_rank = Some(ranks[idx].priority);
        }
    }

    // Approximate p99 wait for Rank-0 as ~4.6 * W_{q,0} + 2 * tau_{e,0}, floored at 60s.
    let tau_e0 = effective_service[0];
    let recommended_interrupt_ttl_sec = match wait_sec_by_rank[0] {
        Some(wq0) => ((4.6 * wq0 + 2.0 * tau_e0).ceil() as u64).max(60),
        None => 900,
    };

    CobhamReport {
        raw_utilization,
        effective_utilization,
        switching_overhead: (effective_utilization - raw_utilization).max(0.0),
        residual_service_sec,
        cumulative_load,
        wait_sec_by_rank,
        sojourn_sec_by_rank,
        within_dbr_ceiling: effective_utilization <= DBR_MAX_UTILIZATION,
        first_starved_rank,
        recommended_interrupt_ttl_sec,
    }
}

/// Build a canonical 4-rank traffic profile for a fleet of `agent_count` concurrent panes.
///
/// Used by attention routers and Linear dispatchers to project waiting times and
/// compare the solo-chat no-yank discipline against naive always-swap routing.
#[must_use]
pub fn default_fleet_profile(agent_count: usize, solo_no_yank: bool) -> [RankTraffic; 4] {
    let n = (agent_count.max(1)) as f64;
    let base_swap_prob = if solo_no_yank {
        if agent_count <= 1 {
            0.0
        } else {
            (1.0 - 1.0 / n).clamp(0.15, 0.90)
        }
    } else {
        1.0
    };

    [
        RankTraffic {
            priority: Priority::Permission,
            lambda_per_sec: 0.0015 * n,
            service_sec: 8.0,
            cv_squared: 0.5,
            swap_prob: base_swap_prob,
        },
        RankTraffic {
            priority: Priority::Input,
            lambda_per_sec: 0.0020 * n,
            service_sec: 18.0,
            cv_squared: 1.0,
            swap_prob: base_swap_prob,
        },
        RankTraffic {
            priority: Priority::Ready,
            lambda_per_sec: 0.0030 * n,
            service_sec: 12.0,
            cv_squared: 0.8,
            swap_prob: base_swap_prob,
        },
        RankTraffic {
            priority: Priority::Idle,
            lambda_per_sec: 0.0015 * n,
            service_sec: 10.0,
            cv_squared: 0.5,
            swap_prob: base_swap_prob,
        },
    ]
}

/// Metrics for a synchronized Thundering Herd ($M^{[X]}/G/1$ batch arrival of size $B$).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThunderingHerdReport {
    /// Synchronized burst size $B$ (number of agents firing simultaneously).
    pub burst_size: usize,
    /// Fano dispersion / burstiness factor $F = \text{Var}(N)/E[N] \approx B$.
    pub fano_burst_factor: f64,
    /// Effective service time per Rank-0 (`Permission`) event including Sweller switch reload ($\tau_{e,0}$).
    pub effective_service_p0_sec: f64,
    /// Mean intra-batch contention delay added to Rank-0 by the $(B-1)/2$ fellow herd arrivals.
    pub batch_mean_wait_p0_sec: f64,
    /// Worst-case tail wait for the $B$-th agent in a simultaneous Rank-0 burst ($(B-1)\tau_{e,0}$).
    pub batch_tail_wait_p0_sec: f64,
    /// Total expected wait $W_{q,k}^{\text{herd}}(B)$ by rank (`0..4`).
    pub herd_wait_sec_by_rank: [Option<f64>; 4],
    /// Maximum burst size $B_{\max}$ that can clear within `interrupt_ttl_sec` without expiring.
    pub max_safe_burst_before_ttl_expiry: usize,
    /// Whether a burst of size `burst_size` causes tail Rank-0 cards to expire before operator service.
    pub p0_exceeds_interrupt_ttl: bool,
    /// Kleinrock aging wait time (`sec`) required for a starved `Idle` (P3) pane to overtake a fresh `Permission` (P0) burst.
    pub kleinrock_p3_overtake_sec: f64,
}

/// Evaluate the $M^{[X]}/G/1$ Batch-Cobham waiting-time amplification and TTL cliff when
/// `burst_size` ($B$) agents fire simultaneously.
#[must_use]
pub fn evaluate_thundering_herd(
    ranks: &[RankTraffic; 4],
    switch_cost_sec: f64,
    burst_size: usize,
    interrupt_ttl_sec: u64,
) -> ThunderingHerdReport {
    let base = evaluate_cobham_mg1(ranks, switch_cost_sec);
    let b = burst_size.max(1) as f64;
    let delta_sw = switch_cost_sec.max(0.0);

    let tau_e0 = ranks[0].service_sec.max(0.0) + ranks[0].swap_prob.clamp(0.0, 1.0) * delta_sw;
    let batch_mean_wait_p0_sec = 0.5 * (b - 1.0) * tau_e0;
    let batch_tail_wait_p0_sec = (b - 1.0) * tau_e0;

    let mut herd_wait_sec_by_rank = [None; 4];
    for idx in 0..4 {
        let tau_ek =
            ranks[idx].service_sec.max(0.0) + ranks[idx].swap_prob.clamp(0.0, 1.0) * delta_sw;
        let sigma_prev = if idx == 0 {
            0.0
        } else {
            base.cumulative_load[idx - 1]
        };
        if let Some(wq_base) = base.wait_sec_by_rank[idx] {
            let denom_prev = (1.0 - sigma_prev).max(1e-9);
            let intra_batch = 0.5 * (b - 1.0) * tau_ek / denom_prev;
            herd_wait_sec_by_rank[idx] = Some(wq_base + intra_batch);
        }
    }

    let ttl_f = interrupt_ttl_sec as f64;
    let max_safe_burst_before_ttl_expiry = if tau_e0 > 1e-9 {
        (1.0 + (ttl_f / tau_e0).floor()) as usize
    } else {
        usize::MAX
    };

    ThunderingHerdReport {
        burst_size: burst_size.max(1),
        fano_burst_factor: b,
        effective_service_p0_sec: tau_e0,
        batch_mean_wait_p0_sec,
        batch_tail_wait_p0_sec,
        herd_wait_sec_by_rank,
        max_safe_burst_before_ttl_expiry,
        p0_exceeds_interrupt_ttl: batch_tail_wait_p0_sec + tau_e0 > ttl_f,
        kleinrock_p3_overtake_sec: 300.0 / 0.5,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn cobham_wait_times_are_monotonically_ordered_by_priority_rank() {
        let profile = default_fleet_profile(4, true);
        let report = evaluate_cobham_mg1(&profile, 9.5);

        assert!(report.within_dbr_ceiling);
        let w0 = report.wait_sec_by_rank[0].unwrap();
        let w1 = report.wait_sec_by_rank[1].unwrap();
        let w2 = report.wait_sec_by_rank[2].unwrap();
        let w3 = report.wait_sec_by_rank[3].unwrap();

        assert!(w0 < w1);
        assert!(w1 < w2);
        assert!(w2 < w3);
    }

    #[test]
    fn solo_chat_no_yank_eliminates_switching_overhead_for_single_agent() {
        let solo_protected = default_fleet_profile(1, true);
        let naive_yank = default_fleet_profile(1, false);

        let rep_protected = evaluate_cobham_mg1(&solo_protected, 9.5);
        let rep_naive = evaluate_cobham_mg1(&naive_yank, 9.5);

        assert!((rep_protected.switching_overhead - 0.0).abs() < 1e-9);
        assert!(rep_naive.switching_overhead > 0.05);
        assert!(rep_protected.effective_utilization < rep_naive.effective_utilization);
    }

    #[test]
    fn high_priority_overload_starves_lower_ranks_first_while_permission_still_served() {
        let ranks = [
            RankTraffic {
                priority: Priority::Permission,
                lambda_per_sec: 0.04,
                service_sec: 10.0,
                cv_squared: 1.0,
                swap_prob: 0.0,
            },
            RankTraffic {
                priority: Priority::Input,
                lambda_per_sec: 0.045,
                service_sec: 10.0,
                cv_squared: 1.0,
                swap_prob: 0.0,
            },
            RankTraffic {
                priority: Priority::Ready,
                lambda_per_sec: 0.025,
                service_sec: 10.0,
                cv_squared: 1.0,
                swap_prob: 0.0,
            },
            RankTraffic {
                priority: Priority::Idle,
                lambda_per_sec: 0.01,
                service_sec: 10.0,
                cv_squared: 1.0,
                swap_prob: 0.0,
            },
        ];

        let report = evaluate_cobham_mg1(&ranks, 0.0);
        assert!(report.wait_sec_by_rank[0].is_some());
        assert!(report.wait_sec_by_rank[1].is_some());
        assert!(report.wait_sec_by_rank[2].is_none());
        assert!(report.wait_sec_by_rank[3].is_none());
        assert_eq!(report.first_starved_rank, Some(Priority::Ready));
    }

    #[test]
    fn thundering_herd_batch_arrival_amplifies_wait_and_detects_ttl_cliff() {
        let profile = default_fleet_profile(4, true);
        let baseline = evaluate_thundering_herd(&profile, 9.5, 1, 900);
        let herd_23 = evaluate_thundering_herd(&profile, 9.5, 23, 300);

        assert!(herd_23.fano_burst_factor > baseline.fano_burst_factor);
        assert!(herd_23.batch_tail_wait_p0_sec > baseline.batch_tail_wait_p0_sec);
        assert!(herd_23.p0_exceeds_interrupt_ttl);
    }
}
