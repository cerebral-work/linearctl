import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DigestResult, renderBlackwallToml } from "../src/core/grooming.js";
import {
  emitOperatorCrdsJson,
  emitOperatorCrdsYaml,
  reconcileCrManifestJson,
  reconcileLinearDigestSchedule,
  reconcileLinearProject,
  reconcileLinearTicketBinding,
} from "../src/core/k8s-operator.js";

describe("digest schema_version and blackwall format", () => {
  test("renderBlackwallToml emits schema_version = 1 and [[task]] entries", () => {
    const result: DigestResult = {
      schema_version: 1,
      since: "2026-10-14T00:00:00Z",
      total: 1,
      groups: [
        {
          type: "started",
          count: 1,
          items: [
            {
              identifier: "CER-1695",
              title: "K8s CRD LinearProject",
              state: "In Progress",
              assignee: "todie",
              url: "https://linear.app/cerebral/issue/CER-1695",
            },
          ],
        },
      ],
    };

    expect(result.schema_version).toBe(1);
    const toml = renderBlackwallToml(result);
    expect(toml).toContain("schema_version = 1");
    expect(toml).toContain("[[task]]");
    expect(toml).toContain('id = "CER-1695"');
    expect(toml).toContain('prompt = "Resolve CER-1695: K8s CRD LinearProject"');
  });
});

describe("k8s operator CRDs and reconcilers", () => {
  test("emitOperatorCrdsJson and emitOperatorCrdsYaml return all 3 CRDs", () => {
    const crds = emitOperatorCrdsJson();
    expect(crds.length).toBe(3);

    const yaml = emitOperatorCrdsYaml();
    expect(yaml).toContain("name: linearprojects.linear.cerebral.work");
    expect(yaml).toContain("name: lineardigestschedules.linear.cerebral.work");
    expect(yaml).toContain("name: linearticketbindings.linear.cerebral.work");
  });

  test("reconcileLinearProject computes Ready and Stale conditions", () => {
    const ready = reconcileLinearProject(
      {
        projectRef: "linearctl",
        team: "CER",
        syncInterval: "5m",
      },
      [{ name: "M1", targetDate: "2026-10-30", done: 4, total: 5, percent: 80 }],
      2,
      0,
      "2026-10-14T00:00:00Z",
    );
    expect(ready.triageCount).toBe(2);
    expect(ready.staleCount).toBe(0);
    expect(ready.conditions[0]?.type).toBe("Ready");
    expect(ready.conditions[0]?.status).toBe("True");
    expect(ready.conditions[1]?.type).toBe("Stale");
    expect(ready.conditions[1]?.status).toBe("False");
  });

  test("reconcileLinearDigestSchedule renders versioned ConfigMap and status", () => {
    const digest: DigestResult = {
      schema_version: 1,
      since: "2026-10-14T00:00:00Z",
      total: 3,
      groups: [],
    };
    const { status, configMap } = reconcileLinearDigestSchedule(
      { name: "daily-digest", namespace: "linear-system" },
      {
        schedule: "0 9 * * *",
        team: "CER",
        since: "24h",
        json: true,
        output: {
          configMap: "linear-digest-latest",
          namespace: "linear-system",
        },
      },
      digest,
      2,
      "2026-10-14T00:00:00Z",
    );
    expect(status.issueCount).toBe(3);
    expect(status.lastConfigMapVersion).toBe("linear-digest-latest-v2");
    expect((configMap.metadata as { name: string }).name).toBe("linear-digest-latest");
  });

  test("reconcileLinearTicketBinding handles dry-run vs apply", () => {
    const dryRun = reconcileLinearTicketBinding(
      {
        ticket: "CER-1698",
        resource: {
          apiVersion: "batch/v1",
          kind: "Job",
          name: "migrate-db",
          namespace: "linear-system",
        },
        rules: [{ when: "Succeeded", then: "close" }],
        apply: false,
      },
      "Succeeded",
      "In Progress",
      "2026-10-14T00:00:00Z",
    );
    expect(dryRun.plannedAction).toBe("close");
    expect(dryRun.applied).toBe(false);
    expect(dryRun.ticketState).toBe("In Progress");

    const applied = reconcileLinearTicketBinding(
      {
        ticket: "CER-1698",
        resource: {
          apiVersion: "batch/v1",
          kind: "Job",
          name: "migrate-db",
          namespace: "linear-system",
        },
        rules: [{ when: "Succeeded", then: "close" }],
        apply: true,
      },
      "Succeeded",
      "In Progress",
      "2026-10-14T00:00:00Z",
    );
    expect(applied.plannedAction).toBe("close");
    expect(applied.applied).toBe(true);
    expect(applied.ticketState).toBe("Done");
  });

  test("reconcileCrManifestJson dispatches across CRD kinds", () => {
    const res = reconcileCrManifestJson(
      JSON.stringify({
        kind: "LinearDigestSchedule",
        metadata: {
          name: "daily-digest",
          namespace: "linear-system",
        },
        spec: {
          schedule: "0 9 * * *",
          team: "CER",
          since: "24h",
          output: {
            configMap: "linear-digest-cm",
          },
        },
      }),
      "2026-10-14T00:00:00Z",
    );
    expect(res.kind).toBe("LinearDigestSchedule");
    const status = res.status as { lastConfigMapVersion: string };
    expect(status.lastConfigMapVersion).toBe("linear-digest-cm-v1");
  });

  test("Helm chart includes static CRDs and opt-in MCP supergateway template", () => {
    const root = join(import.meta.dir, "..");
    const crdProject = readFileSync(
      join(root, "deploy/chart/crds/linearprojects.linear.cerebral.work.yaml"),
      "utf8",
    );
    const crdDigest = readFileSync(
      join(root, "deploy/chart/crds/lineardigestschedules.linear.cerebral.work.yaml"),
      "utf8",
    );
    const crdBinding = readFileSync(
      join(root, "deploy/chart/crds/linearticketbindings.linear.cerebral.work.yaml"),
      "utf8",
    );
    const mcpTemplate = readFileSync(
      join(root, "deploy/chart/templates/mcp-service.yaml"),
      "utf8",
    );
    const valuesYaml = readFileSync(join(root, "deploy/chart/values.yaml"), "utf8");

    expect(crdProject).toContain("kind: CustomResourceDefinition");
    expect(crdDigest).toContain("kind: CustomResourceDefinition");
    expect(crdBinding).toContain("kind: CustomResourceDefinition");
    expect(mcpTemplate).toContain("{{- if .Values.mcp.enabled }}");
    expect(mcpTemplate).toContain("linearctl mcp serve");
    expect(valuesYaml).toContain("supergateway:");
  });
});
