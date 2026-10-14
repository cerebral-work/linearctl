//! Pure Kubernetes operator CRD definitions and Custom Resource reconciliation logic.
//!
//! Group: `linear.cerebral.work`, Version: `v1alpha1`.
//! Zero I/O: all functions operate purely on in-memory models and JSON/YAML values.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::DomainError;
use crate::models::DigestResult;

/// Canonical API group for the Linear Kubernetes operator.
pub const OPERATOR_API_GROUP: &str = "linear.cerebral.work";

/// Canonical API version for the Linear Kubernetes operator.
pub const OPERATOR_API_VERSION: &str = "linear.cerebral.work/v1alpha1";

/// Standard Kubernetes ObjectMeta subset used by operator Custom Resources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct K8sObjectMeta {
    /// Resource name.
    pub name: String,
    /// Optional resource namespace (omitted for Cluster-scoped resources).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// Standard Kubernetes condition entry on a Custom Resource `status.conditions` array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sCondition {
    /// Condition type (`"Ready"`, `"Stale"`, `"Synced"`).
    #[serde(rename = "type")]
    pub condition_type: String,
    /// Condition status (`"True"`, `"False"`, `"Unknown"`).
    pub status: String,
    /// Machine-readable CamelCase reason.
    pub reason: String,
    /// Human-readable message describing the transition.
    pub message: String,
    /// ISO-8601 timestamp of last transition.
    pub last_transition_time: String,
}

/// `LinearProject` (`Scope: Cluster`) specification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectSpec {
    /// Linear project name, slug ID, or UUID.
    pub project_ref: String,
    /// Linear team key (e.g. `"CER"`).
    pub team: String,
    /// Optional reconciliation interval (e.g. `"5m"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_interval: Option<String>,
}

/// Milestone progress entry inside `LinearProjectStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectMilestoneStatus {
    /// Milestone name.
    pub name: String,
    /// Optional target date (`YYYY-MM-DD`).
    pub target_date: Option<String>,
    /// Completed issue count.
    pub done: usize,
    /// Total issue count.
    pub total: usize,
    /// Completion percentage (`0..=100`).
    pub percent: u8,
}

/// `LinearProject` (`Scope: Cluster`) reconciled status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProjectStatus {
    /// Milestone progress rollups.
    pub milestones: Vec<LinearProjectMilestoneStatus>,
    /// Number of issues needing triage.
    pub triage_count: usize,
    /// Number of stale active issues.
    pub stale_count: usize,
    /// ISO-8601 timestamp of last reconciliation.
    pub last_sync: String,
    /// Standard Kubernetes status conditions (`Ready`, `Stale`).
    pub conditions: Vec<K8sCondition>,
}

/// `LinearDigestSchedule` target `ConfigMap` reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearDigestOutputSpec {
    /// Name of the target `ConfigMap`.
    pub config_map: String,
    /// Optional target namespace override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

/// `LinearDigestSchedule` (`Scope: Namespaced`) specification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearDigestScheduleSpec {
    /// Cron schedule expression (e.g. `"0 * * * *"`).
    pub schedule: String,
    /// Linear team key (e.g. `"CER"`).
    pub team: String,
    /// Relative lookback window (e.g. `"24h"`, `"7d"`).
    pub since: String,
    /// Target `ConfigMap` output configuration.
    pub output: LinearDigestOutputSpec,
    /// Whether to write JSON (`digest.json`) instead of text (`digest.txt`). Defaults to `true`.
    #[serde(default)]
    pub json: Option<bool>,
}

/// `LinearDigestSchedule` reconciled status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearDigestScheduleStatus {
    /// ISO-8601 timestamp of the latest digest execution.
    pub last_run: String,
    /// Version annotation written to the target `ConfigMap`.
    pub last_config_map_version: String,
    /// Total number of issues included in the digest.
    pub issue_count: usize,
}

/// Target Kubernetes workload referenced by a `LinearTicketBinding`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundResourceRef {
    /// Workload API version (e.g. `"batch/v1"`).
    pub api_version: String,
    /// Workload kind (e.g. `"Job"`, `"Deployment"`).
    pub kind: String,
    /// Workload name.
    pub name: String,
    /// Workload namespace.
    pub namespace: String,
}

/// Event-to-action rule inside a `LinearTicketBinding`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketBindingRule {
    /// Condition trigger (`"Succeeded"`, `"Failed"`, `"Available"`).
    pub when: String,
    /// Action to perform (`"close"`, `"comment"`, `"update"`).
    pub then: String,
    /// Optional target state name when `then == "update"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Optional comment template override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// `LinearTicketBinding` (`Scope: Namespaced`) specification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearTicketBindingSpec {
    /// Linear issue identifier (e.g. `"CER-1699"`).
    pub ticket: String,
    /// Opt-in mutation gate; defaults to `false` (dry-run).
    #[serde(default)]
    pub apply: bool,
    /// Bound Kubernetes resource reference.
    pub resource: BoundResourceRef,
    /// Transition rules evaluated against the bound resource condition.
    pub rules: Vec<TicketBindingRule>,
}

/// `LinearTicketBinding` reconciled status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearTicketBindingStatus {
    /// Observed workload event (`"Succeeded"`, `"Failed"`, etc.).
    pub last_event: String,
    /// Current or resulting Linear ticket state.
    pub ticket_state: String,
    /// Planned mutation action (`"close"`, `"comment"`, `"update"`, or `"none"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_action: Option<String>,
    /// Whether the mutation was applied (`false` when `spec.apply` is `false`).
    pub applied: bool,
    /// Formatted shipping/audit comment for the transition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipping_comment: Option<String>,
    /// ISO-8601 timestamp of last reconciliation.
    pub last_sync: String,
}

/// Return the three `linear.cerebral.work/v1alpha1` CustomResourceDefinition manifests as JSON values.
#[must_use]
pub fn emit_operator_crds_json() -> Vec<Value> {
    vec![
        json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": {
                "name": "linearprojects.linear.cerebral.work"
            },
            "spec": {
                "group": OPERATOR_API_GROUP,
                "scope": "Cluster",
                "names": {
                    "plural": "linearprojects",
                    "singular": "linearproject",
                    "kind": "LinearProject",
                    "shortNames": ["lproj"]
                },
                "versions": [{
                    "name": "v1alpha1",
                    "served": true,
                    "storage": true,
                    "subresources": { "status": {} },
                    "schema": {
                        "openAPIV3Schema": {
                            "type": "object",
                            "required": ["spec"],
                            "properties": {
                                "spec": {
                                    "type": "object",
                                    "required": ["projectRef", "team"],
                                    "properties": {
                                        "projectRef": { "type": "string" },
                                        "team": { "type": "string" },
                                        "syncInterval": { "type": "string", "default": "5m" }
                                    }
                                },
                                "status": {
                                    "type": "object",
                                    "properties": {
                                        "triageCount": { "type": "integer" },
                                        "staleCount": { "type": "integer" },
                                        "lastSync": { "type": "string" },
                                        "milestones": { "type": "array", "items": { "type": "object", "x-kubernetes-preserve-unknown-fields": true } },
                                        "conditions": { "type": "array", "items": { "type": "object", "x-kubernetes-preserve-unknown-fields": true } }
                                    }
                                }
                            }
                        }
                    }
                }]
            }
        }),
        json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": {
                "name": "lineardigestschedules.linear.cerebral.work"
            },
            "spec": {
                "group": OPERATOR_API_GROUP,
                "scope": "Namespaced",
                "names": {
                    "plural": "lineardigestschedules",
                    "singular": "lineardigestschedule",
                    "kind": "LinearDigestSchedule",
                    "shortNames": ["ldigest"]
                },
                "versions": [{
                    "name": "v1alpha1",
                    "served": true,
                    "storage": true,
                    "subresources": { "status": {} },
                    "schema": {
                        "openAPIV3Schema": {
                            "type": "object",
                            "required": ["spec"],
                            "properties": {
                                "spec": {
                                    "type": "object",
                                    "required": ["schedule", "team", "since", "output"],
                                    "properties": {
                                        "schedule": { "type": "string" },
                                        "team": { "type": "string" },
                                        "since": { "type": "string" },
                                        "json": { "type": "boolean", "default": true },
                                        "output": {
                                            "type": "object",
                                            "required": ["configMap"],
                                            "properties": {
                                                "configMap": { "type": "string" },
                                                "namespace": { "type": "string" }
                                            }
                                        }
                                    }
                                },
                                "status": {
                                    "type": "object",
                                    "properties": {
                                        "lastRun": { "type": "string" },
                                        "lastConfigMapVersion": { "type": "string" },
                                        "issueCount": { "type": "integer" }
                                    }
                                }
                            }
                        }
                    }
                }]
            }
        }),
        json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": {
                "name": "linearticketbindings.linear.cerebral.work"
            },
            "spec": {
                "group": OPERATOR_API_GROUP,
                "scope": "Namespaced",
                "names": {
                    "plural": "linearticketbindings",
                    "singular": "linearticketbinding",
                    "kind": "LinearTicketBinding",
                    "shortNames": ["lticket"]
                },
                "versions": [{
                    "name": "v1alpha1",
                    "served": true,
                    "storage": true,
                    "subresources": { "status": {} },
                    "schema": {
                        "openAPIV3Schema": {
                            "type": "object",
                            "required": ["spec"],
                            "properties": {
                                "spec": {
                                    "type": "object",
                                    "required": ["ticket", "resource", "rules"],
                                    "properties": {
                                        "ticket": { "type": "string" },
                                        "apply": { "type": "boolean", "default": false },
                                        "resource": {
                                            "type": "object",
                                            "required": ["apiVersion", "kind", "name", "namespace"],
                                            "properties": {
                                                "apiVersion": { "type": "string" },
                                                "kind": { "type": "string" },
                                                "name": { "type": "string" },
                                                "namespace": { "type": "string" }
                                            }
                                        },
                                        "rules": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "required": ["when", "then"],
                                                "properties": {
                                                    "when": { "type": "string" },
                                                    "then": { "type": "string", "enum": ["close", "comment", "update"] },
                                                    "state": { "type": "string" },
                                                    "comment": { "type": "string" }
                                                }
                                            }
                                        }
                                    }
                                },
                                "status": {
                                    "type": "object",
                                    "properties": {
                                        "lastEvent": { "type": "string" },
                                        "ticketState": { "type": "string" },
                                        "plannedAction": { "type": "string" },
                                        "applied": { "type": "boolean" },
                                        "shippingComment": { "type": "string" },
                                        "lastSync": { "type": "string" }
                                    }
                                }
                            }
                        }
                    }
                }]
            }
        }),
    ]
}

/// Emit the three `linear.cerebral.work/v1alpha1` CustomResourceDefinitions as multi-document YAML.
#[must_use]
pub fn emit_operator_crds_yaml() -> String {
    const CRD_LINEAR_PROJECTS: &str = "\
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: linearprojects.linear.cerebral.work
spec:
  group: linear.cerebral.work
  scope: Cluster
  names:
    plural: linearprojects
    singular: linearproject
    kind: LinearProject
    shortNames:
      - lproj
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      schema:
        openAPIV3Schema:
          type: object
          required:
            - spec
          properties:
            spec:
              type: object
              required:
                - projectRef
                - team
              properties:
                projectRef:
                  type: string
                team:
                  type: string
                syncInterval:
                  type: string
                  default: 5m
            status:
              type: object
              properties:
                triageCount:
                  type: integer
                staleCount:
                  type: integer
                lastSync:
                  type: string
                milestones:
                  type: array
                  items:
                    type: object
                    x-kubernetes-preserve-unknown-fields: true
                conditions:
                  type: array
                  items:
                    type: object
                    x-kubernetes-preserve-unknown-fields: true";

    const CRD_LINEAR_DIGEST_SCHEDULES: &str = "\
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: lineardigestschedules.linear.cerebral.work
spec:
  group: linear.cerebral.work
  scope: Namespaced
  names:
    plural: lineardigestschedules
    singular: lineardigestschedule
    kind: LinearDigestSchedule
    shortNames:
      - ldigest
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      schema:
        openAPIV3Schema:
          type: object
          required:
            - spec
          properties:
            spec:
              type: object
              required:
                - schedule
                - team
                - since
                - output
              properties:
                schedule:
                  type: string
                team:
                  type: string
                since:
                  type: string
                json:
                  type: boolean
                  default: true
                output:
                  type: object
                  required:
                    - configMap
                  properties:
                    configMap:
                      type: string
                    namespace:
                      type: string
            status:
              type: object
              properties:
                lastRun:
                  type: string
                lastConfigMapVersion:
                  type: string
                issueCount:
                  type: integer";

    const CRD_LINEAR_TICKET_BINDINGS: &str = "\
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: linearticketbindings.linear.cerebral.work
spec:
  group: linear.cerebral.work
  scope: Namespaced
  names:
    plural: linearticketbindings
    singular: linearticketbinding
    kind: LinearTicketBinding
    shortNames:
      - lticket
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      schema:
        openAPIV3Schema:
          type: object
          required:
            - spec
          properties:
            spec:
              type: object
              required:
                - ticket
                - resource
                - rules
              properties:
                ticket:
                  type: string
                apply:
                  type: boolean
                  default: false
                resource:
                  type: object
                  required:
                    - apiVersion
                    - kind
                    - name
                    - namespace
                  properties:
                    apiVersion:
                      type: string
                    kind:
                      type: string
                    name:
                      type: string
                    namespace:
                      type: string
                rules:
                  type: array
                  items:
                    type: object
                    required:
                      - when
                      - then
                    properties:
                      when:
                        type: string
                      then:
                        type: string
                        enum:
                          - close
                          - comment
                          - update
                      state:
                        type: string
                      comment:
                        type: string
            status:
              type: object
              properties:
                lastEvent:
                  type: string
                ticketState:
                  type: string
                plannedAction:
                  type: string
                applied:
                  type: boolean
                shippingComment:
                  type: string
                lastSync:
                  type: string";

    format!("{CRD_LINEAR_PROJECTS}\n---\n{CRD_LINEAR_DIGEST_SCHEDULES}\n---\n{CRD_LINEAR_TICKET_BINDINGS}\n")
}

/// Reconcile a `LinearProject` specification and observed counts into a [`LinearProjectStatus`].
#[must_use]
pub fn reconcile_linear_project(
    spec: &LinearProjectSpec,
    milestones: Vec<LinearProjectMilestoneStatus>,
    triage_count: usize,
    stale_count: usize,
    now_iso: &str,
) -> LinearProjectStatus {
    let stale_condition = if stale_count > 0 {
        K8sCondition {
            condition_type: "Stale".to_string(),
            status: "True".to_string(),
            reason: "StaleIssuesPresent".to_string(),
            message: format!(
                "Project {} ({}) has {stale_count} stale issue(s)",
                spec.project_ref, spec.team
            ),
            last_transition_time: now_iso.to_string(),
        }
    } else {
        K8sCondition {
            condition_type: "Stale".to_string(),
            status: "False".to_string(),
            reason: "NoStaleIssues".to_string(),
            message: format!(
                "Project {} ({}) has no stale issues",
                spec.project_ref, spec.team
            ),
            last_transition_time: now_iso.to_string(),
        }
    };
    let ready_condition = K8sCondition {
        condition_type: "Ready".to_string(),
        status: "True".to_string(),
        reason: "Reconciled".to_string(),
        message: format!(
            "Synced project {} for team {} ({} milestone(s), {} triage)",
            spec.project_ref,
            spec.team,
            milestones.len(),
            triage_count
        ),
        last_transition_time: now_iso.to_string(),
    };
    LinearProjectStatus {
        milestones,
        triage_count,
        stale_count,
        last_sync: now_iso.to_string(),
        conditions: vec![ready_condition, stale_condition],
    }
}

/// Reconcile a `LinearDigestSchedule` and [`DigestResult`] into a status and rendered `ConfigMap`.
#[must_use]
pub fn reconcile_linear_digest_schedule(
    meta: &K8sObjectMeta,
    spec: &LinearDigestScheduleSpec,
    digest: &DigestResult,
    revision: u32,
    now_iso: &str,
) -> (LinearDigestScheduleStatus, Value) {
    let target_ns = spec
        .output
        .namespace
        .clone()
        .or_else(|| meta.namespace.clone())
        .unwrap_or_else(|| "linear-system".to_string());
    let version = format!("{}-v{revision}", spec.output.config_map);
    let use_json = spec.json.unwrap_or(true);
    let data = if use_json {
        let payload = serde_json::to_string_pretty(digest).unwrap_or_else(|_| "{}".to_string());
        json!({ "digest.json": payload })
    } else {
        let text = crate::models::render_standup_markdown(digest, &spec.since);
        json!({ "digest.txt": text })
    };
    let config_map = json!({
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {
            "name": spec.output.config_map,
            "namespace": target_ns,
            "annotations": {
                "linear.cerebral.work/version": version,
                "linear.cerebral.work/team": spec.team,
                "linear.cerebral.work/since": spec.since
            }
        },
        "data": data
    });
    let status = LinearDigestScheduleStatus {
        last_run: now_iso.to_string(),
        last_config_map_version: version,
        issue_count: digest.total,
    };
    (status, config_map)
}

/// Reconcile a `LinearTicketBinding` against an observed workload condition event.
///
/// Honors `spec.apply`: when `false` (default), records `planned_action` with `applied: false`
/// without mutating Linear state.
#[must_use]
pub fn reconcile_linear_ticket_binding(
    spec: &LinearTicketBindingSpec,
    observed_event: &str,
    current_ticket_state: &str,
    now_iso: &str,
) -> LinearTicketBindingStatus {
    let matched = spec
        .rules
        .iter()
        .find(|r| r.when.eq_ignore_ascii_case(observed_event));

    let Some(rule) = matched else {
        return LinearTicketBindingStatus {
            last_event: observed_event.to_string(),
            ticket_state: current_ticket_state.to_string(),
            planned_action: Some("none".to_string()),
            applied: false,
            shipping_comment: None,
            last_sync: now_iso.to_string(),
        };
    };

    let comment = rule.comment.clone().unwrap_or_else(|| {
        format!(
            "Kubernetes {}/{} in namespace {} reported {} for {}",
            spec.resource.kind,
            spec.resource.name,
            spec.resource.namespace,
            observed_event,
            spec.ticket
        )
    });

    let next_state = if spec.apply {
        match rule.then.as_str() {
            "close" => "Done".to_string(),
            "update" => rule
                .state
                .clone()
                .unwrap_or_else(|| current_ticket_state.to_string()),
            _ => current_ticket_state.to_string(),
        }
    } else {
        current_ticket_state.to_string()
    };

    LinearTicketBindingStatus {
        last_event: observed_event.to_string(),
        ticket_state: next_state,
        planned_action: Some(rule.then.clone()),
        applied: spec.apply,
        shipping_comment: Some(comment),
        last_sync: now_iso.to_string(),
    }
}

/// Reconcile an arbitrary Custom Resource JSON manifest (`LinearProject`, `LinearDigestSchedule`, or `LinearTicketBinding`).
///
/// # Errors
///
/// Returns [`DomainError::Validation`] if the JSON document is malformed or has an unsupported `kind`.
pub fn reconcile_cr_manifest_json(raw: &str, now_iso: &str) -> Result<Value, DomainError> {
    let doc: Value = serde_json::from_str(raw.trim())
        .map_err(|e| DomainError::Validation(format!("Invalid Custom Resource JSON: {e}")))?;
    let kind = doc
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| DomainError::Validation("Custom Resource is missing 'kind'".to_string()))?;
    let name = doc
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .unwrap_or("unnamed")
        .to_string();
    let namespace = doc
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .map(str::to_string);
    let meta = K8sObjectMeta { name, namespace };
    let spec_val = doc
        .get("spec")
        .cloned()
        .ok_or_else(|| DomainError::Validation(format!("{kind} is missing 'spec'")))?;

    match kind {
        "LinearProject" => {
            let spec: LinearProjectSpec = serde_json::from_value(spec_val).map_err(|e| {
                DomainError::Validation(format!("Invalid LinearProject.spec: {e}"))
            })?;
            let stale_count = doc
                .pointer("/status/staleCount")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let triage_count = doc
                .pointer("/status/triageCount")
                .and_then(Value::as_u64)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(0);
            let status = reconcile_linear_project(&spec, Vec::new(), triage_count, stale_count, now_iso);
            Ok(json!({
                "apiVersion": OPERATOR_API_VERSION,
                "kind": "LinearProject",
                "metadata": meta,
                "spec": spec,
                "status": status
            }))
        }
        "LinearDigestSchedule" => {
            let spec: LinearDigestScheduleSpec = serde_json::from_value(spec_val).map_err(|e| {
                DomainError::Validation(format!("Invalid LinearDigestSchedule.spec: {e}"))
            })?;
            let empty_digest = crate::models::build_digest_groups(now_iso, Vec::new());
            let (status, config_map) =
                reconcile_linear_digest_schedule(&meta, &spec, &empty_digest, 1, now_iso);
            Ok(json!({
                "apiVersion": OPERATOR_API_VERSION,
                "kind": "LinearDigestSchedule",
                "metadata": meta,
                "spec": spec,
                "status": status,
                "configMap": config_map
            }))
        }
        "LinearTicketBinding" => {
            let spec: LinearTicketBindingSpec = serde_json::from_value(spec_val).map_err(|e| {
                DomainError::Validation(format!("Invalid LinearTicketBinding.spec: {e}"))
            })?;
            let observed_event = doc
                .pointer("/status/lastEvent")
                .and_then(Value::as_str)
                .or_else(|| spec.rules.first().map(|r| r.when.as_str()))
                .unwrap_or("Succeeded");
            let current_state = doc
                .pointer("/status/ticketState")
                .and_then(Value::as_str)
                .unwrap_or("In Progress");
            let status =
                reconcile_linear_ticket_binding(&spec, observed_event, current_state, now_iso);
            Ok(json!({
                "apiVersion": OPERATOR_API_VERSION,
                "kind": "LinearTicketBinding",
                "metadata": meta,
                "spec": spec,
                "status": status
            }))
        }
        other => Err(DomainError::Validation(format!(
            "Unsupported Custom Resource kind '{other}' (expected LinearProject, LinearDigestSchedule, or LinearTicketBinding)"
        ))),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn emits_three_crds_in_yaml_and_json() {
        let crds = emit_operator_crds_json();
        assert_eq!(crds.len(), 3);
        let yaml = emit_operator_crds_yaml();
        assert!(yaml.contains("name: linearprojects.linear.cerebral.work"));
        assert!(yaml.contains("name: lineardigestschedules.linear.cerebral.work"));
        assert!(yaml.contains("name: linearticketbindings.linear.cerebral.work"));
    }

    #[test]
    fn reconciles_linear_project_stale_condition() {
        let spec = LinearProjectSpec {
            project_ref: "lnr".to_string(),
            team: "CER".to_string(),
            sync_interval: Some("5m".to_string()),
        };
        let status_stale =
            reconcile_linear_project(&spec, Vec::new(), 2, 3, "2026-10-14T00:00:00Z");
        let stale_cond = status_stale
            .conditions
            .iter()
            .find(|c| c.condition_type == "Stale")
            .unwrap();
        assert_eq!(stale_cond.status, "True");
        assert_eq!(stale_cond.reason, "StaleIssuesPresent");

        let status_clean =
            reconcile_linear_project(&spec, Vec::new(), 0, 0, "2026-10-14T00:00:00Z");
        let clean_cond = status_clean
            .conditions
            .iter()
            .find(|c| c.condition_type == "Stale")
            .unwrap();
        assert_eq!(clean_cond.status, "False");
        assert_eq!(clean_cond.reason, "NoStaleIssues");
    }

    #[test]
    fn reconciles_ticket_binding_dry_run_vs_apply() {
        let mut spec = LinearTicketBindingSpec {
            ticket: "CER-1699".to_string(),
            apply: false,
            resource: BoundResourceRef {
                api_version: "batch/v1".to_string(),
                kind: "Job".to_string(),
                name: "migrate-db".to_string(),
                namespace: "default".to_string(),
            },
            rules: vec![TicketBindingRule {
                when: "Succeeded".to_string(),
                then: "close".to_string(),
                state: None,
                comment: None,
            }],
        };
        let dry = reconcile_linear_ticket_binding(
            &spec,
            "Succeeded",
            "In Progress",
            "2026-10-14T00:00:00Z",
        );
        assert!(!dry.applied);
        assert_eq!(dry.ticket_state, "In Progress");
        assert_eq!(dry.planned_action.as_deref(), Some("close"));

        spec.apply = true;
        let applied = reconcile_linear_ticket_binding(
            &spec,
            "Succeeded",
            "In Progress",
            "2026-10-14T00:00:00Z",
        );
        assert!(applied.applied);
        assert_eq!(applied.ticket_state, "Done");
        assert!(applied
            .shipping_comment
            .as_deref()
            .unwrap()
            .contains("Job/migrate-db"));
    }
}
