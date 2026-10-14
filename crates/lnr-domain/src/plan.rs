//! Saga Spec 0040 Critical Path Method (CPM) planner, wave scheduler, and TOML serializer/parser.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::beads::{BeadsDependencyType, BeadsIssue, BeadsStatus};
use crate::error::CliError;

/// Policy when a step halts or fails (`"cancel-dependents"` or `"halt-all"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OnHaltPolicy {
    /// Cancel only downstream dependents of the halted step.
    #[serde(rename = "cancel-dependents")]
    CancelDependents,
    /// Halt all active steps in the flow.
    #[serde(rename = "halt-all")]
    HaltAll,
}

impl OnHaltPolicy {
    /// Return the canonical TOML string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CancelDependents => "cancel-dependents",
            Self::HaltAll => "halt-all",
        }
    }
}

/// Agent role classification (Spec 0040 U9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    /// Lightweight/fast probe or check.
    Probe,
    /// Capable implementation builder.
    Builder,
    /// Independent code review / critic.
    Critic,
    /// Operator-gated main session.
    MainSession,
}

impl AgentRole {
    /// Return the snake_case role name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Builder => "builder",
            Self::Critic => "critic",
            Self::MainSession => "main_session",
        }
    }
}

/// Top-level `[flow]` configuration in a Saga Spec 0040 plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SagaPlanFlow {
    /// Flow identifier.
    pub name: String,
    /// Optional human-readable flow description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Whether green PRs merge automatically.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_on_green: Option<bool>,
    /// Optional wait time before auto-merge in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_wait_secs: Option<u32>,
    /// Maximum concurrent steps per execution wave.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<usize>,
    /// Whether builders open pull requests on critic pass.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_prs: Option<bool>,
    /// Base branch for pull requests (e.g. `"development"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_base: Option<String>,
    /// Halt policy (`"cancel-dependents"` or `"halt-all"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_halt: Option<String>,
    /// Optional critic agent override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub critic_agent: Option<String>,
    /// Optional builder model override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub builder_model: Option<String>,
    /// Optional halt path globs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub halt_paths: Option<Vec<String>>,
}

/// A single `[[step]]` definition in a Saga Spec 0040 plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SagaPlanStep {
    /// Unique step identifier (e.g. `"CER-101"`).
    pub id: String,
    /// Step title.
    pub title: String,
    /// Step kind (`"impl"`, `"verify"`, `"test"`, `"gate"`).
    pub kind: String,
    /// Optional agent role hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Upstream step IDs that must finish before this step starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deps: Option<Vec<String>>,
    /// Optional verification command argv.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_cmd: Option<Vec<String>>,
    /// Optional step prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Optional gate identifier (e.g. `"heimdal:approval"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
    /// Optional estimated duration units.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u32>,
    /// Optional readiness command argv.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_cmd: Option<Vec<String>>,
    /// Optional readiness timeout in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_max_wait_secs: Option<u32>,
    /// Optional execution timeout in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u32>,
}

/// Complete Saga Spec 0040 plan (`[flow]` + `[[step]]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SagaPlan {
    /// Flow metadata.
    pub flow: SagaPlanFlow,
    /// Ordered step definitions.
    pub steps: Vec<SagaPlanStep>,
}

/// Computed CPM timing and wave assignment for a single step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CpmStepSchedule {
    /// Step identifier.
    pub id: String,
    /// Classified agent role.
    pub role: AgentRole,
    /// Effective step duration.
    pub duration: u32,
    /// Earliest start time.
    pub es: u32,
    /// Earliest finish time (`es + duration`).
    pub ef: u32,
    /// Latest start time (`lf - duration`).
    pub ls: u32,
    /// Latest finish time.
    pub lf: u32,
    /// Total float / slack (`ls - es`).
    pub slack: u32,
    /// True when `slack == 0` (on the critical path).
    pub critical: bool,
    /// Execution wave index (0-based).
    pub wave: usize,
}

/// Full CPM schedule and wave decomposition (`saga.plan.v1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CpmScheduleResult {
    /// Schema version tag (`"saga.plan.v1"`).
    pub schema: String,
    /// Flow name.
    pub flow: String,
    /// Maximum concurrent steps per wave.
    pub max_concurrency: usize,
    /// Total critical-path duration.
    pub total_duration: u32,
    /// Waves of step IDs.
    pub waves: Vec<Vec<String>>,
    /// Per-step CPM metrics ordered by wave, earliest start, then id.
    pub steps: Vec<CpmStepSchedule>,
}

/// Result of the raw CPM forward/backward pass before wave slicing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CpmComputeResult {
    /// Map from step ID to its schedule metrics.
    pub steps: BTreeMap<String, CpmStepSchedule>,
    /// Total project duration along the critical path.
    pub total_duration: u32,
    /// Primary critical path step sequence.
    pub critical_path: Vec<String>,
}

/// Options for generating a [`SagaPlan`] from [`BeadsIssue`] records.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlanGenerateOptions {
    /// Flow name (`"linear-cpm-plan"` default).
    pub name: Option<String>,
    /// Optional flow description.
    pub description: Option<String>,
    /// Max concurrency per wave (default 3).
    pub max_concurrency: Option<usize>,
    /// PR base branch (`"development"` default).
    pub pr_base: Option<String>,
    /// Halt policy (`"cancel-dependents"` default).
    pub on_halt: Option<String>,
    /// Merge on green flag.
    pub merge_on_green: Option<bool>,
    /// Merge wait seconds.
    pub merge_wait_secs: Option<u32>,
    /// Open PRs flag.
    pub open_prs: Option<bool>,
    /// Critic agent override.
    pub critic_agent: Option<String>,
    /// Builder model override.
    pub builder_model: Option<String>,
    /// Team key filter.
    pub team: Option<Vec<String>>,
    /// Label filter.
    pub labels: Option<Vec<String>>,
    /// Priority threshold (`0..=4`).
    pub priority: Option<u8>,
    /// Include closed issues (`false` by default).
    pub include_closed: bool,
    /// Pair each `impl` step with a downstream `-critic` step.
    pub add_critic: bool,
    /// Default verification command for `verify` steps.
    pub default_verify_cmd: Option<Vec<String>>,
}

/// Classify a [`SagaPlanStep`] into an [`AgentRole`] (Spec 0040 U9).
#[must_use]
pub fn classify_step_role(step: &SagaPlanStep) -> AgentRole {
    let kind = if step.kind.is_empty() {
        "verify".to_string()
    } else {
        step.kind.to_lowercase()
    };
    if kind == "gate" || step.gate.as_deref().is_some_and(|g| !g.is_empty()) {
        return AgentRole::MainSession;
    }

    if let Some(agent) = &step.agent {
        match agent.to_lowercase().as_str() {
            "probe" | "fast" | "lint" => return AgentRole::Probe,
            "critic" | "review" => return AgentRole::Critic,
            "builder" | "impl" => return AgentRole::Builder,
            "main" | "operator" | "main_session" => return AgentRole::MainSession,
            _ => {}
        }
    }

    if kind == "verify" || kind == "test" {
        let id_lower = step.id.to_lowercase();
        let title_lower = step.title.to_lowercase();
        if id_lower.contains("review")
            || id_lower.contains("critic")
            || title_lower.contains("review")
            || title_lower.contains("critic")
        {
            return AgentRole::Critic;
        }
        return AgentRole::Probe;
    }

    if kind == "impl" {
        return AgentRole::Builder;
    }

    AgentRole::Probe
}

/// Return the effective duration of a step (Spec 0040 U2: `impl`=20, `gate`=1, `verify`=5).
#[must_use]
pub fn get_effective_duration(step: &SagaPlanStep) -> u32 {
    if let Some(d) = step.duration {
        return d;
    }
    match step.kind.to_lowercase().as_str() {
        "impl" => 20,
        "gate" => 1,
        _ => 5,
    }
}

/// Compute the Critical Path Method (CPM) forward/backward schedule (Spec 0040 U1 & U2).
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`) if any step has an empty or duplicate ID, unknown dependency, self-dependency, or cycle.
pub fn compute_cpm(steps: &[SagaPlanStep]) -> Result<CpmComputeResult, CliError> {
    let mut by_id: HashMap<String, &SagaPlanStep> = HashMap::with_capacity(steps.len());
    for (i, s) in steps.iter().enumerate() {
        if s.id.trim().is_empty() {
            return Err(CliError::usage(format!("step {i} has an empty id"), ""));
        }
        if by_id.contains_key(&s.id) {
            return Err(CliError::usage(format!("duplicate step id: {}", s.id), ""));
        }
        by_id.insert(s.id.clone(), s);
    }

    for step in steps {
        for dep in step.deps.as_deref().unwrap_or(&[]) {
            if dep == &step.id {
                return Err(CliError::usage(
                    format!("step {} cannot depend on itself", step.id),
                    "",
                ));
            }
            if !by_id.contains_key(dep) {
                return Err(CliError::usage(
                    format!("step {} references unknown dependency: {dep}", step.id),
                    "",
                ));
            }
        }
    }

    let mut preds: HashMap<String, BTreeSet<String>> = HashMap::with_capacity(steps.len());
    let mut succs: HashMap<String, BTreeSet<String>> = HashMap::with_capacity(steps.len());
    for step in steps {
        let p: BTreeSet<String> = step
            .deps
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .cloned()
            .collect();
        preds.insert(step.id.clone(), p);
        succs.insert(step.id.clone(), BTreeSet::new());
    }
    for step in steps {
        for dep in step.deps.as_deref().unwrap_or(&[]) {
            if let Some(s) = succs.get_mut(dep) {
                s.insert(step.id.clone());
            }
        }
    }

    // Kahn's topological sort
    let mut in_degree: BTreeMap<String, usize> =
        preds.iter().map(|(id, p)| (id.clone(), p.len())).collect();
    let mut queue: BTreeSet<String> = in_degree
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(id, _)| id.clone())
        .collect();

    let mut topo: Vec<String> = Vec::with_capacity(steps.len());
    while let Some(u) = queue.pop_first() {
        topo.push(u.clone());
        if let Some(children) = succs.get(&u) {
            for v in children {
                if let Some(d) = in_degree.get_mut(v) {
                    *d = d.saturating_sub(1);
                    if *d == 0 {
                        queue.insert(v.clone());
                    }
                }
            }
        }
    }

    if topo.len() != steps.len() {
        let done: BTreeSet<&str> = topo.iter().map(String::as_str).collect();
        let mut cycle_nodes: Vec<&str> = steps
            .iter()
            .filter(|s| !done.contains(s.id.as_str()))
            .map(|s| s.id.as_str())
            .collect();
        cycle_nodes.sort_unstable();
        return Err(CliError::usage(
            format!("dependency cycle among steps: {}", cycle_nodes.join(", ")),
            "",
        ));
    }

    // Forward pass
    let mut es_map: HashMap<String, u32> = HashMap::with_capacity(steps.len());
    let mut ef_map: HashMap<String, u32> = HashMap::with_capacity(steps.len());
    for id in &topo {
        let Some(&step) = by_id.get(id) else {
            continue;
        };
        let dur = get_effective_duration(step);
        let es = preds
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|p| ef_map.get(p).copied())
            .max()
            .unwrap_or(0);
        es_map.insert(id.clone(), es);
        ef_map.insert(id.clone(), es.saturating_add(dur));
    }

    let total_duration = ef_map.values().copied().max().unwrap_or(0);

    // Backward pass
    let mut lf_map: HashMap<String, u32> = HashMap::with_capacity(steps.len());
    let mut ls_map: HashMap<String, u32> = HashMap::with_capacity(steps.len());
    for id in topo.iter().rev() {
        let Some(&step) = by_id.get(id) else {
            continue;
        };
        let dur = get_effective_duration(step);
        let lf = succs
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|s| ls_map.get(s).copied())
            .min()
            .unwrap_or(total_duration);
        lf_map.insert(id.clone(), lf);
        ls_map.insert(id.clone(), lf.saturating_sub(dur));
    }

    let mut schedule = BTreeMap::new();
    for step in steps {
        let es = es_map.get(&step.id).copied().unwrap_or(0);
        let ef = ef_map.get(&step.id).copied().unwrap_or(0);
        let ls = ls_map.get(&step.id).copied().unwrap_or(0);
        let lf = lf_map.get(&step.id).copied().unwrap_or(0);
        let slack = ls.saturating_sub(es);
        let critical = slack == 0;
        let role = classify_step_role(step);
        schedule.insert(
            step.id.clone(),
            CpmStepSchedule {
                id: step.id.clone(),
                role,
                duration: get_effective_duration(step),
                es,
                ef,
                ls,
                lf,
                slack,
                critical,
                wave: 0,
            },
        );
    }

    // Primary critical path
    let mut critical_path = Vec::new();
    let mut next = schedule
        .values()
        .filter(|s| s.critical && s.es == 0)
        .map(|s| s.id.clone())
        .min();

    while let Some(cur_id) = next {
        critical_path.push(cur_id.clone());
        let Some(cur_step) = schedule.get(&cur_id) else {
            break;
        };
        let cur_ef = cur_step.ef;
        next = succs
            .get(&cur_id)
            .into_iter()
            .flatten()
            .filter(|n| {
                schedule
                    .get(*n)
                    .is_some_and(|s| s.critical && s.es == cur_ef)
            })
            .cloned()
            .min();
    }

    Ok(CpmComputeResult {
        steps: schedule,
        total_duration,
        critical_path,
    })
}

/// Compute bounded-concurrency execution waves according to Saga Spec 0040 U3.
///
/// # Errors
///
/// Returns a [`CliError`] if the underlying CPM graph is invalid or cyclic.
pub fn compute_waves(plan: &SagaPlan) -> Result<CpmScheduleResult, CliError> {
    let max_concurrency = plan.flow.max_concurrency.filter(|&c| c > 0).unwrap_or(3);
    let cpm = compute_cpm(&plan.steps)?;

    let mut assigned: BTreeSet<String> = BTreeSet::new();
    let mut waves: Vec<Vec<String>> = Vec::new();
    let mut scheduled_steps: Vec<CpmStepSchedule> = Vec::with_capacity(plan.steps.len());

    let mut wave_index = 0usize;
    while assigned.len() < plan.steps.len() {
        let mut eligible: Vec<&SagaPlanStep> = plan
            .steps
            .iter()
            .filter(|s| !assigned.contains(&s.id))
            .filter(|s| {
                s.deps
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .all(|d| assigned.contains(d))
            })
            .collect();

        if eligible.is_empty() {
            let mut remaining: Vec<&str> = plan
                .steps
                .iter()
                .filter(|s| !assigned.contains(&s.id))
                .map(|s| s.id.as_str())
                .collect();
            remaining.sort_unstable();
            return Err(CliError::usage(
                format!("dependency cycle among steps: {}", remaining.join(", ")),
                "",
            ));
        }

        // U3 sorting rule: critical first, then smaller slack, then lower ES, then id
        eligible.sort_by(|a, b| {
            let Some(ca) = cpm.steps.get(&a.id) else {
                return a.id.cmp(&b.id);
            };
            let Some(cb) = cpm.steps.get(&b.id) else {
                return a.id.cmp(&b.id);
            };
            cb.critical
                .cmp(&ca.critical)
                .then_with(|| ca.slack.cmp(&cb.slack))
                .then_with(|| ca.es.cmp(&cb.es))
                .then_with(|| a.id.cmp(&b.id))
        });

        let wave_steps: Vec<&SagaPlanStep> = eligible.into_iter().take(max_concurrency).collect();
        let wave_ids: Vec<String> = wave_steps.iter().map(|s| s.id.clone()).collect();
        waves.push(wave_ids);

        for step in wave_steps {
            assigned.insert(step.id.clone());
            if let Some(info) = cpm.steps.get(&step.id) {
                let mut scheduled = info.clone();
                scheduled.wave = wave_index;
                scheduled_steps.push(scheduled);
            }
        }
        wave_index += 1;
    }

    scheduled_steps.sort_by(|a, b| {
        a.wave
            .cmp(&b.wave)
            .then_with(|| a.es.cmp(&b.es))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(CpmScheduleResult {
        schema: "saga.plan.v1".to_string(),
        flow: plan.flow.name.clone(),
        max_concurrency,
        total_duration: cpm.total_duration,
        waves,
        steps: scheduled_steps,
    })
}

fn infer_step_kind_and_agent(issue: &BeadsIssue) -> (String, String, Option<String>) {
    let title_lower = issue.title.to_lowercase();
    let labels_lower: Vec<String> = issue
        .labels
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|l| l.to_lowercase())
        .collect();
    let type_lower = issue.issue_type.map_or("", |t| t.as_str());

    let is_gate = type_lower == "epic"
        || labels_lower
            .iter()
            .any(|l| l.contains("gate") || l.contains("approval"))
        || title_lower.contains("operator-gate")
        || title_lower.contains("approval gate");
    if is_gate {
        return (
            "gate".to_string(),
            "main_session".to_string(),
            Some("heimdal:approval".to_string()),
        );
    }

    let is_critic = labels_lower
        .iter()
        .any(|l| l.contains("critic") || l.contains("review"))
        || title_lower.contains("critic")
        || title_lower.contains("code review");
    if is_critic {
        return ("verify".to_string(), "critic".to_string(), None);
    }

    let is_verify = labels_lower.iter().any(|l| {
        l.contains("verify")
            || l.contains("test")
            || l.contains("spec")
            || l.contains("qa")
            || l.contains("probe")
    }) || title_lower.starts_with("verify")
        || title_lower.starts_with("test ")
        || title_lower.starts_with("check ");
    if is_verify {
        return ("verify".to_string(), "probe".to_string(), None);
    }

    ("impl".to_string(), "builder".to_string(), None)
}

fn format_step_prompt(issue: &BeadsIssue) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(desc) = issue
        .description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        parts.push(desc.to_string());
    }
    if let Some(ac) = issue
        .acceptance_criteria
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        parts.push(format!("\nAcceptance Criteria:\n{ac}"));
    }
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// Generate a validated [`SagaPlan`] from a slice of [`BeadsIssue`] records.
///
/// # Errors
///
/// Returns a [`CliError`] if no issues match the filter criteria or the resulting dependency graph is cyclic.
pub fn generate_saga_plan(
    raw_issues: &[BeadsIssue],
    options: &PlanGenerateOptions,
) -> Result<SagaPlan, CliError> {
    let filtered: Vec<&BeadsIssue> = raw_issues
        .iter()
        .filter(|issue| {
            if !options.include_closed && issue.status == BeadsStatus::Closed {
                return false;
            }
            if let Some(teams) = &options.team {
                if !teams.is_empty()
                    && !teams.iter().any(|t| issue.id.starts_with(&format!("{t}-")))
                {
                    return false;
                }
            }
            if let Some(max_p) = options.priority {
                if issue.priority > max_p {
                    return false;
                }
            }
            if let Some(req_labels) = &options.labels {
                if !req_labels.is_empty() {
                    let issue_labels: Vec<String> = issue
                        .labels
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .map(|l| l.to_lowercase())
                        .collect();
                    if !req_labels
                        .iter()
                        .all(|l| issue_labels.contains(&l.to_lowercase()))
                    {
                        return false;
                    }
                }
            }
            true
        })
        .collect();

    if filtered.is_empty() {
        return Err(CliError::usage(
            "No issues matched the filter criteria for plan generation.",
            "",
        ));
    }

    let included_ids: BTreeSet<&str> = filtered.iter().map(|i| i.id.as_str()).collect();
    let mut steps: Vec<SagaPlanStep> = Vec::with_capacity(filtered.len());

    for issue in filtered {
        let (kind, agent, gate) = infer_step_kind_and_agent(issue);
        let deps: Vec<String> = issue
            .dependencies
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|d| d.dep_type == BeadsDependencyType::Blocks && d.issue_id == issue.id)
            .map(|d| d.depends_on_id.as_str())
            .filter(|&dep_id| included_ids.contains(dep_id) && dep_id != issue.id)
            .map(str::to_string)
            .collect::<BTreeSet<String>>()
            .into_iter()
            .collect();

        let duration = issue
            .estimated_minutes
            .filter(|&m| m > 0)
            .map(|m| ((m + 30) / 60).max(1));

        let verify_cmd = if kind == "verify" {
            options.default_verify_cmd.clone().filter(|v| !v.is_empty())
        } else {
            None
        };

        steps.push(SagaPlanStep {
            id: issue.id.clone(),
            title: issue.title.clone(),
            kind,
            agent: Some(agent),
            deps: (!deps.is_empty()).then_some(deps),
            verify_cmd,
            prompt: format_step_prompt(issue),
            gate,
            duration,
            ready_cmd: None,
            ready_max_wait_secs: None,
            timeout_secs: None,
        });
    }

    if options.add_critic {
        let mut additional = Vec::new();
        let mut impl_to_critic: HashMap<String, String> = HashMap::new();
        let critic_agent = options
            .critic_agent
            .clone()
            .unwrap_or_else(|| "critic".to_string());

        for step in &steps {
            if step.kind == "impl" {
                let critic_id = format!("{}-critic", step.id);
                impl_to_critic.insert(step.id.clone(), critic_id.clone());
                additional.push(SagaPlanStep {
                    id: critic_id,
                    title: format!("Review {}", step.title),
                    kind: "verify".to_string(),
                    agent: Some(critic_agent.clone()),
                    deps: Some(vec![step.id.clone()]),
                    verify_cmd: None,
                    prompt: None,
                    gate: None,
                    duration: Some(5),
                    ready_cmd: None,
                    ready_max_wait_secs: None,
                    timeout_secs: None,
                });
            }
        }

        for step in &mut steps {
            if let Some(deps) = &mut step.deps {
                for dep in deps.iter_mut() {
                    if let Some(mapped) = impl_to_critic.get(dep) {
                        *dep = mapped.clone();
                    }
                }
            }
        }
        steps.extend(additional);
    }

    let flow = SagaPlanFlow {
        name: options
            .name
            .clone()
            .unwrap_or_else(|| "linear-cpm-plan".to_string()),
        description: options.description.clone(),
        merge_on_green: options.merge_on_green,
        merge_wait_secs: options.merge_wait_secs,
        max_concurrency: Some(options.max_concurrency.unwrap_or(3)),
        open_prs: options.open_prs,
        pr_base: Some(
            options
                .pr_base
                .clone()
                .unwrap_or_else(|| "development".to_string()),
        ),
        on_halt: Some(
            options
                .on_halt
                .clone()
                .unwrap_or_else(|| "cancel-dependents".to_string()),
        ),
        critic_agent: options.critic_agent.clone(),
        builder_model: options.builder_model.clone(),
        halt_paths: None,
    };

    let plan = SagaPlan { flow, steps };
    compute_cpm(&plan.steps)?;
    Ok(plan)
}

fn escape_toml_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn format_toml_string(s: &str) -> String {
    if s.contains('\n') {
        let escaped = s.replace('\\', "\\\\").replace("\"\"\"", "\\\"\\\"\\\"");
        format!("\"\"\"\n{escaped}\n\"\"\"")
    } else {
        format!("\"{}\"", escape_toml_string(s))
    }
}

fn format_string_array(arr: &[String]) -> String {
    let items: Vec<String> = arr
        .iter()
        .map(|s| format!("\"{}\"", escape_toml_string(s)))
        .collect();
    format!("[{}]", items.join(", "))
}

/// Serialize a [`SagaPlanFlow`] into a TOML `[flow]` section.
#[must_use]
pub fn serialize_flow_to_toml(flow: &SagaPlanFlow) -> String {
    let mut lines = vec![
        "[flow]".to_string(),
        format!("name = {}", format_toml_string(&flow.name)),
    ];
    if let Some(desc) = &flow.description {
        lines.push(format!("description = {}", format_toml_string(desc)));
    }
    if let Some(mc) = flow.max_concurrency {
        lines.push(format!("max_concurrency = {mc}"));
    }
    if let Some(pr_base) = &flow.pr_base {
        lines.push(format!("pr_base = {}", format_toml_string(pr_base)));
    }
    if let Some(mog) = flow.merge_on_green {
        lines.push(format!("merge_on_green = {mog}"));
    }
    if let Some(mws) = flow.merge_wait_secs {
        lines.push(format!("merge_wait_secs = {mws}"));
    }
    if let Some(op) = flow.open_prs {
        lines.push(format!("open_prs = {op}"));
    }
    if let Some(oh) = &flow.on_halt {
        lines.push(format!("on_halt = {}", format_toml_string(oh)));
    }
    if let Some(ca) = &flow.critic_agent {
        lines.push(format!("critic_agent = {}", format_toml_string(ca)));
    }
    if let Some(bm) = &flow.builder_model {
        lines.push(format!("builder_model = {}", format_toml_string(bm)));
    }
    if let Some(hp) = &flow.halt_paths {
        if !hp.is_empty() {
            lines.push(format!("halt_paths = {}", format_string_array(hp)));
        }
    }
    lines.join("\n")
}

/// Serialize a [`SagaPlanStep`] into a TOML `[[step]]` block.
#[must_use]
pub fn serialize_step_to_toml(step: &SagaPlanStep) -> String {
    let mut lines = vec![
        "[[step]]".to_string(),
        format!("id = {}", format_toml_string(&step.id)),
        format!("title = {}", format_toml_string(&step.title)),
        format!("kind = {}", format_toml_string(&step.kind)),
    ];
    if let Some(agent) = &step.agent {
        lines.push(format!("agent = {}", format_toml_string(agent)));
    }
    if let Some(deps) = &step.deps {
        if !deps.is_empty() {
            lines.push(format!("deps = {}", format_string_array(deps)));
        }
    }
    if let Some(dur) = step.duration {
        lines.push(format!("duration = {dur}"));
    }
    if let Some(vc) = &step.verify_cmd {
        if !vc.is_empty() {
            lines.push(format!("verify_cmd = {}", format_string_array(vc)));
        }
    }
    if let Some(prompt) = &step.prompt {
        lines.push(format!("prompt = {}", format_toml_string(prompt)));
    }
    if let Some(gate) = &step.gate {
        lines.push(format!("gate = {}", format_toml_string(gate)));
    }
    if let Some(rc) = &step.ready_cmd {
        if !rc.is_empty() {
            lines.push(format!("ready_cmd = {}", format_string_array(rc)));
        }
    }
    if let Some(rmw) = step.ready_max_wait_secs {
        lines.push(format!("ready_max_wait_secs = {rmw}"));
    }
    if let Some(ts) = step.timeout_secs {
        lines.push(format!("timeout_secs = {ts}"));
    }
    lines.join("\n")
}

/// Serialize a complete [`SagaPlan`] into TOML text.
#[must_use]
pub fn serialize_plan_to_toml(plan: &SagaPlan) -> String {
    let mut parts = Vec::with_capacity(plan.steps.len() + 1);
    parts.push(serialize_flow_to_toml(&plan.flow));
    for step in &plan.steps {
        parts.push(serialize_step_to_toml(step));
    }
    format!("{}\n", parts.join("\n\n"))
}

fn unescape_toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_toml_string_scalar(val: &str) -> String {
    let trimmed = val.trim();
    if let Some(inner) = trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        unescape_toml_string(inner)
    } else {
        trimmed.to_string()
    }
}

fn parse_toml_string_array(val: &str) -> Vec<String> {
    let trimmed = val.trim();
    let Some(inner) = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .map(str::trim)
    else {
        return Vec::new();
    };
    if inner.is_empty() {
        return Vec::new();
    }

    let mut items = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = inner.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        if ch == '"' && (i == 0 || chars[i - 1] != '\\') {
            in_quotes = !in_quotes;
        }
        if ch == ',' && !in_quotes {
            items.push(parse_toml_string_scalar(cur.trim()));
            cur.clear();
        } else {
            cur.push(ch);
        }
    }
    if !cur.trim().is_empty() {
        items.push(parse_toml_string_scalar(cur.trim()));
    }
    items
}

/// Parse a [`SagaPlan`] from Saga Spec 0040 TOML text.
#[must_use]
pub fn parse_saga_plan_toml(toml_text: &str) -> SagaPlan {
    let mut flow = SagaPlanFlow {
        name: "untitled-plan".to_string(),
        description: None,
        merge_on_green: None,
        merge_wait_secs: None,
        max_concurrency: None,
        open_prs: None,
        pr_base: None,
        on_halt: None,
        critic_agent: None,
        builder_model: None,
        halt_paths: None,
    };
    let mut steps: Vec<SagaPlanStep> = Vec::new();
    let mut current_step: Option<SagaPlanStep> = None;
    let mut section = "none";

    let mut in_multiline = false;
    let mut multiline_key = String::new();
    let mut multiline_buf: Vec<String> = Vec::new();

    for raw_line in toml_text.lines() {
        if in_multiline {
            if let Some(end_idx) = raw_line.find("\"\"\"") {
                multiline_buf.push(raw_line[..end_idx].to_string());
                let full_val = multiline_buf.join("\n");
                apply_toml_kv(
                    section,
                    &mut flow,
                    &mut current_step,
                    &multiline_key,
                    &format!("\"{}\"", escape_toml_string(&full_val)),
                );
                in_multiline = false;
                multiline_buf.clear();
                multiline_key.clear();
            } else {
                multiline_buf.push(raw_line.to_string());
            }
            continue;
        }

        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed == "[flow]" {
            if let Some(step) = current_step.take() {
                if !step.id.is_empty() {
                    steps.push(step);
                }
            }
            section = "flow";
            continue;
        }
        if trimmed == "[[step]]" {
            if let Some(step) = current_step.take() {
                if !step.id.is_empty() {
                    steps.push(step);
                }
            }
            section = "step";
            current_step = Some(SagaPlanStep {
                id: String::new(),
                title: String::new(),
                kind: "impl".to_string(),
                agent: None,
                deps: None,
                verify_cmd: None,
                prompt: None,
                gate: None,
                duration: None,
                ready_cmd: None,
                ready_max_wait_secs: None,
                timeout_secs: None,
            });
            continue;
        }

        if let Some((k_raw, v_raw)) = trimmed.split_once('=') {
            let key = k_raw.trim();
            let val_str = v_raw.trim();
            if let Some(after_open) = val_str.strip_prefix("\"\"\"") {
                if let Some(inner) = after_open.strip_suffix("\"\"\"") {
                    apply_toml_kv(
                        section,
                        &mut flow,
                        &mut current_step,
                        key,
                        &format!("\"{}\"", escape_toml_string(inner)),
                    );
                } else {
                    in_multiline = true;
                    multiline_key = key.to_string();
                    if !after_open.is_empty() {
                        multiline_buf.push(after_open.to_string());
                    }
                }
                continue;
            }
            apply_toml_kv(section, &mut flow, &mut current_step, key, val_str);
        }
    }

    if let Some(step) = current_step.take() {
        if !step.id.is_empty() {
            steps.push(step);
        }
    }

    SagaPlan { flow, steps }
}

fn apply_toml_kv(
    section: &str,
    flow: &mut SagaPlanFlow,
    current_step: &mut Option<SagaPlanStep>,
    key: &str,
    val_str: &str,
) {
    match section {
        "flow" => match key {
            "name" => flow.name = parse_toml_string_scalar(val_str),
            "description" => flow.description = Some(parse_toml_string_scalar(val_str)),
            "max_concurrency" => flow.max_concurrency = val_str.parse().ok(),
            "merge_on_green" => {
                flow.merge_on_green = (val_str == "true")
                    .then_some(true)
                    .or((val_str == "false").then_some(false))
            }
            "merge_wait_secs" => flow.merge_wait_secs = val_str.parse().ok(),
            "open_prs" => {
                flow.open_prs = (val_str == "true")
                    .then_some(true)
                    .or((val_str == "false").then_some(false))
            }
            "pr_base" => flow.pr_base = Some(parse_toml_string_scalar(val_str)),
            "on_halt" => flow.on_halt = Some(parse_toml_string_scalar(val_str)),
            "critic_agent" => flow.critic_agent = Some(parse_toml_string_scalar(val_str)),
            "builder_model" => flow.builder_model = Some(parse_toml_string_scalar(val_str)),
            "halt_paths" => flow.halt_paths = Some(parse_toml_string_array(val_str)),
            _ => {}
        },
        "step" => {
            if let Some(step) = current_step {
                match key {
                    "id" => step.id = parse_toml_string_scalar(val_str),
                    "title" => step.title = parse_toml_string_scalar(val_str),
                    "kind" => step.kind = parse_toml_string_scalar(val_str),
                    "agent" => step.agent = Some(parse_toml_string_scalar(val_str)),
                    "deps" => step.deps = Some(parse_toml_string_array(val_str)),
                    "verify_cmd" => step.verify_cmd = Some(parse_toml_string_array(val_str)),
                    "prompt" => step.prompt = Some(parse_toml_string_scalar(val_str)),
                    "gate" => step.gate = Some(parse_toml_string_scalar(val_str)),
                    "duration" => step.duration = val_str.parse().ok(),
                    "ready_cmd" => step.ready_cmd = Some(parse_toml_string_array(val_str)),
                    "ready_max_wait_secs" => step.ready_max_wait_secs = val_str.parse().ok(),
                    "timeout_secs" => step.timeout_secs = val_str.parse().ok(),
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn computes_cpm_and_waves_and_round_trips_toml() {
        let plan = SagaPlan {
            flow: SagaPlanFlow {
                name: "demo-flow".to_string(),
                description: Some("Demo CPM".to_string()),
                merge_on_green: Some(true),
                merge_wait_secs: None,
                max_concurrency: Some(2),
                open_prs: None,
                pr_base: Some("development".to_string()),
                on_halt: Some("cancel-dependents".to_string()),
                critic_agent: None,
                builder_model: None,
                halt_paths: None,
            },
            steps: vec![
                SagaPlanStep {
                    id: "CER-1".to_string(),
                    title: "Scaffold".to_string(),
                    kind: "impl".to_string(),
                    agent: Some("builder".to_string()),
                    deps: None,
                    verify_cmd: None,
                    prompt: None,
                    gate: None,
                    duration: Some(10),
                    ready_cmd: None,
                    ready_max_wait_secs: None,
                    timeout_secs: None,
                },
                SagaPlanStep {
                    id: "CER-2".to_string(),
                    title: "Verify scaffold".to_string(),
                    kind: "verify".to_string(),
                    agent: Some("probe".to_string()),
                    deps: Some(vec!["CER-1".to_string()]),
                    verify_cmd: Some(vec!["make".to_string(), "check".to_string()]),
                    prompt: None,
                    gate: None,
                    duration: Some(5),
                    ready_cmd: None,
                    ready_max_wait_secs: None,
                    timeout_secs: None,
                },
            ],
        };

        let toml_str = serialize_plan_to_toml(&plan);
        let parsed = parse_saga_plan_toml(&toml_str);
        assert_eq!(parsed, plan);

        let schedule = compute_waves(&parsed).unwrap();
        assert_eq!(schedule.total_duration, 15);
        assert_eq!(schedule.waves, vec![vec!["CER-1"], vec!["CER-2"]]);
        assert!(schedule.steps[0].critical);
        assert!(schedule.steps[1].critical);
    }
}
