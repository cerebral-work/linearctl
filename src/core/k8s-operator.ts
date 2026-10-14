/**
 * Kubernetes operator CRD definitions and Custom Resource reconciliation logic
 * (`linear.cerebral.work/v1alpha1`).
 *
 * Implements:
 * - `LinearProject` (`Scope: Cluster`)
 * - `LinearDigestSchedule` (`Scope: Namespaced`)
 * - `LinearTicketBinding` (`Scope: Namespaced`)
 */

import type { DigestResult } from "./grooming.js";
import { usageError } from "../lib/errors.js";

export const OPERATOR_API_GROUP = "linear.cerebral.work";
export const OPERATOR_API_VERSION = "linear.cerebral.work/v1alpha1";

export interface K8sObjectMeta {
  name: string;
  namespace?: string;
}

export interface K8sCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason: string;
  message: string;
  lastTransitionTime: string;
}

export interface LinearProjectSpec {
  projectRef: string;
  team: string;
  syncInterval?: string;
}

export interface LinearProjectMilestoneStatus {
  name: string;
  targetDate: string | null;
  done: number;
  total: number;
  percent: number;
}

export interface LinearProjectStatus {
  milestones: LinearProjectMilestoneStatus[];
  triageCount: number;
  staleCount: number;
  lastSync: string;
  conditions: K8sCondition[];
}

export interface LinearDigestScheduleSpec {
  schedule: string;
  team: string;
  since: string;
  output: {
    configMap: string;
    namespace?: string;
  };
  json?: boolean;
}

export interface LinearDigestScheduleStatus {
  lastRun: string;
  lastConfigMapVersion: string;
  issueCount: number;
}

export interface BoundResourceRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
}

export interface TicketBindingRule {
  when: string;
  then: "close" | "comment" | "update";
  state?: string;
  comment?: string;
}

export interface LinearTicketBindingSpec {
  ticket: string;
  apply?: boolean;
  resource: BoundResourceRef;
  rules: TicketBindingRule[];
}

export interface LinearTicketBindingStatus {
  lastEvent: string;
  ticketState: string;
  plannedAction?: string;
  applied: boolean;
  shippingComment?: string;
  lastSync: string;
}

export function emitOperatorCrdsJson(): Record<string, unknown>[] {
  return [
    {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: {
        name: "linearprojects.linear.cerebral.work",
      },
      spec: {
        group: OPERATOR_API_GROUP,
        scope: "Cluster",
        names: {
          plural: "linearprojects",
          singular: "linearproject",
          kind: "LinearProject",
          shortNames: ["lproj"],
        },
        versions: [
          {
            name: "v1alpha1",
            served: true,
            storage: true,
            subresources: { status: {} },
            schema: {
              openAPIV3Schema: {
                type: "object",
                required: ["spec"],
                properties: {
                  spec: {
                    type: "object",
                    required: ["projectRef", "team"],
                    properties: {
                      projectRef: { type: "string" },
                      team: { type: "string" },
                      syncInterval: { type: "string", default: "5m" },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      triageCount: { type: "integer" },
                      staleCount: { type: "integer" },
                      lastSync: { type: "string" },
                      milestones: {
                        type: "array",
                        items: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
                      },
                      conditions: {
                        type: "array",
                        items: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
    {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: {
        name: "lineardigestschedules.linear.cerebral.work",
      },
      spec: {
        group: OPERATOR_API_GROUP,
        scope: "Namespaced",
        names: {
          plural: "lineardigestschedules",
          singular: "lineardigestschedule",
          kind: "LinearDigestSchedule",
          shortNames: ["ldigest"],
        },
        versions: [
          {
            name: "v1alpha1",
            served: true,
            storage: true,
            subresources: { status: {} },
            schema: {
              openAPIV3Schema: {
                type: "object",
                required: ["spec"],
                properties: {
                  spec: {
                    type: "object",
                    required: ["schedule", "team", "since", "output"],
                    properties: {
                      schedule: { type: "string" },
                      team: { type: "string" },
                      since: { type: "string" },
                      json: { type: "boolean", default: true },
                      output: {
                        type: "object",
                        required: ["configMap"],
                        properties: {
                          configMap: { type: "string" },
                          namespace: { type: "string" },
                        },
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      lastRun: { type: "string" },
                      lastConfigMapVersion: { type: "string" },
                      issueCount: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
    {
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: {
        name: "linearticketbindings.linear.cerebral.work",
      },
      spec: {
        group: OPERATOR_API_GROUP,
        scope: "Namespaced",
        names: {
          plural: "linearticketbindings",
          singular: "linearticketbinding",
          kind: "LinearTicketBinding",
          shortNames: ["lticket"],
        },
        versions: [
          {
            name: "v1alpha1",
            served: true,
            storage: true,
            subresources: { status: {} },
            schema: {
              openAPIV3Schema: {
                type: "object",
                required: ["spec"],
                properties: {
                  spec: {
                    type: "object",
                    required: ["ticket", "resource", "rules"],
                    properties: {
                      ticket: { type: "string" },
                      apply: { type: "boolean", default: false },
                      resource: {
                        type: "object",
                        required: ["apiVersion", "kind", "name", "namespace"],
                        properties: {
                          apiVersion: { type: "string" },
                          kind: { type: "string" },
                          name: { type: "string" },
                          namespace: { type: "string" },
                        },
                      },
                      rules: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["when", "then"],
                          properties: {
                            when: { type: "string" },
                            then: { type: "string", enum: ["close", "comment", "update"] },
                            state: { type: "string" },
                            comment: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      lastEvent: { type: "string" },
                      ticketState: { type: "string" },
                      plannedAction: { type: "string" },
                      applied: { type: "boolean" },
                      shippingComment: { type: "string" },
                      lastSync: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
  ];
}

export const CRD_LINEAR_PROJECTS_YAML = `\
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
                    x-kubernetes-preserve-unknown-fields: true`;

export const CRD_LINEAR_DIGEST_SCHEDULES_YAML = `\
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
                  type: integer`;

export const CRD_LINEAR_TICKET_BINDINGS_YAML = `\
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
                  type: string`;

export function emitOperatorCrdsYaml(): string {
  return `${CRD_LINEAR_PROJECTS_YAML}\n---\n${CRD_LINEAR_DIGEST_SCHEDULES_YAML}\n---\n${CRD_LINEAR_TICKET_BINDINGS_YAML}\n`;
}

export function reconcileLinearProject(
  spec: LinearProjectSpec,
  milestones: LinearProjectMilestoneStatus[],
  triageCount: number,
  staleCount: number,
  nowIso: string = new Date().toISOString(),
): LinearProjectStatus {
  const staleCondition: K8sCondition =
    staleCount > 0
      ? {
          type: "Stale",
          status: "True",
          reason: "StaleIssuesPresent",
          message: `Project ${spec.projectRef} (${spec.team}) has ${staleCount} stale issue(s)`,
          lastTransitionTime: nowIso,
        }
      : {
          type: "Stale",
          status: "False",
          reason: "NoStaleIssues",
          message: `Project ${spec.projectRef} (${spec.team}) has no stale issues`,
          lastTransitionTime: nowIso,
        };
  const readyCondition: K8sCondition = {
    type: "Ready",
    status: "True",
    reason: "Reconciled",
    message: `Synced project ${spec.projectRef} for team ${spec.team} (${milestones.length} milestone(s), ${triageCount} triage)`,
    lastTransitionTime: nowIso,
  };
  return {
    milestones,
    triageCount,
    staleCount,
    lastSync: nowIso,
    conditions: [readyCondition, staleCondition],
  };
}

export function reconcileLinearDigestSchedule(
  meta: K8sObjectMeta,
  spec: LinearDigestScheduleSpec,
  digest: DigestResult,
  revision: number = 1,
  nowIso: string = new Date().toISOString(),
): { status: LinearDigestScheduleStatus; configMap: Record<string, unknown> } {
  const targetNs = spec.output.namespace ?? meta.namespace ?? "linear-system";
  const version = `${spec.output.configMap}-v${revision}`;
  const useJson = spec.json ?? true;
  const data = useJson
    ? { "digest.json": JSON.stringify(digest, null, 2) }
    : {
        "digest.txt": `${digest.total} issue(s) updated since ${digest.since}\n`,
      };
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: spec.output.configMap,
      namespace: targetNs,
      annotations: {
        "linear.cerebral.work/version": version,
        "linear.cerebral.work/team": spec.team,
        "linear.cerebral.work/since": spec.since,
      },
    },
    data,
  };
  const status: LinearDigestScheduleStatus = {
    lastRun: nowIso,
    lastConfigMapVersion: version,
    issueCount: digest.total,
  };
  return { status, configMap };
}

export function reconcileLinearTicketBinding(
  spec: LinearTicketBindingSpec,
  observedEvent: string,
  currentTicketState: string = "In Progress",
  nowIso: string = new Date().toISOString(),
): LinearTicketBindingStatus {
  const rule = spec.rules.find(
    (r) => r.when.toLowerCase() === observedEvent.toLowerCase(),
  );
  if (!rule) {
    return {
      lastEvent: observedEvent,
      ticketState: currentTicketState,
      plannedAction: "none",
      applied: false,
      lastSync: nowIso,
    };
  }
  const apply = spec.apply === true;
  const shippingComment =
    rule.comment ??
    `Kubernetes ${spec.resource.kind}/${spec.resource.name} in namespace ${spec.resource.namespace} reported ${observedEvent} for ${spec.ticket}`;
  let ticketState = currentTicketState;
  if (apply) {
    if (rule.then === "close") {
      ticketState = "Done";
    } else if (rule.then === "update" && rule.state) {
      ticketState = rule.state;
    }
  }
  return {
    lastEvent: observedEvent,
    ticketState,
    plannedAction: rule.then,
    applied: apply,
    shippingComment,
    lastSync: nowIso,
  };
}

export function reconcileCrManifestJson(
  raw: string,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw usageError(`Invalid Custom Resource JSON: ${msg}`);
  }
  const kind = typeof doc.kind === "string" ? doc.kind : undefined;
  if (!kind) {
    throw usageError("Custom Resource is missing 'kind'");
  }
  const rawMeta = (doc.metadata ?? {}) as Record<string, unknown>;
  const meta: K8sObjectMeta = {
    name: typeof rawMeta.name === "string" ? rawMeta.name : "unnamed",
    ...(typeof rawMeta.namespace === "string" ? { namespace: rawMeta.namespace } : {}),
  };
  const spec = doc.spec as Record<string, unknown> | undefined;
  if (!spec || typeof spec !== "object") {
    throw usageError(`${kind} is missing 'spec'`);
  }
  const rawStatus = (doc.status ?? {}) as Record<string, unknown>;

  if (kind === "LinearProject") {
    const projSpec = spec as unknown as LinearProjectSpec;
    if (!projSpec.projectRef || !projSpec.team) {
      throw usageError("LinearProject.spec requires projectRef and team");
    }
    const triageCount = typeof rawStatus.triageCount === "number" ? rawStatus.triageCount : 0;
    const staleCount = typeof rawStatus.staleCount === "number" ? rawStatus.staleCount : 0;
    const status = reconcileLinearProject(projSpec, [], triageCount, staleCount, nowIso);
    return {
      apiVersion: OPERATOR_API_VERSION,
      kind: "LinearProject",
      metadata: meta,
      spec: projSpec,
      status,
    };
  }

  if (kind === "LinearDigestSchedule") {
    const schedSpec = spec as unknown as LinearDigestScheduleSpec;
    if (!schedSpec.schedule || !schedSpec.team || !schedSpec.since || !schedSpec.output?.configMap) {
      throw usageError("LinearDigestSchedule.spec requires schedule, team, since, and output.configMap");
    }
    const emptyDigest: DigestResult = {
      schema_version: 1,
      since: nowIso,
      total: 0,
      groups: [],
    };
    const { status, configMap } = reconcileLinearDigestSchedule(meta, schedSpec, emptyDigest, 1, nowIso);
    return {
      apiVersion: OPERATOR_API_VERSION,
      kind: "LinearDigestSchedule",
      metadata: meta,
      spec: schedSpec,
      status,
      configMap,
    };
  }

  if (kind === "LinearTicketBinding") {
    const bindSpec = spec as unknown as LinearTicketBindingSpec;
    if (!bindSpec.ticket || !bindSpec.resource || !Array.isArray(bindSpec.rules)) {
      throw usageError("LinearTicketBinding.spec requires ticket, resource, and rules");
    }
    const observedEvent =
      typeof rawStatus.lastEvent === "string"
        ? rawStatus.lastEvent
        : bindSpec.rules[0]?.when ?? "Succeeded";
    const currentTicketState =
      typeof rawStatus.ticketState === "string" ? rawStatus.ticketState : "In Progress";
    const status = reconcileLinearTicketBinding(bindSpec, observedEvent, currentTicketState, nowIso);
    return {
      apiVersion: OPERATOR_API_VERSION,
      kind: "LinearTicketBinding",
      metadata: meta,
      spec: bindSpec,
      status,
    };
  }

  throw usageError(
    `Unsupported Custom Resource kind '${kind}' (expected LinearProject, LinearDigestSchedule, or LinearTicketBinding)`,
  );
}
