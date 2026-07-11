import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { LinearClient } from "@linear/sdk";
import { getWhoami } from "../core/whoami.js";
import { createIssue, updateIssue, closeIssue, createComment } from "../core/issues.js";
import {
  createProject,
  listProjects,
  getProjectOverview,
  setProjectOverview,
} from "../core/projects.js";
import { triage, digest, stale } from "../core/grooming.js";
import { milestones } from "../core/milestones.js";
import { sinceToDate } from "../lib/time.js";

/**
 * Run a core call and shape it into a tool result: the JSON payload as a text
 * block, or an `isError` result carrying the message. Core fns throw on failure;
 * this is the single place that maps those throws to MCP errors so a bad call
 * never crashes the server. (structuredContent + outputSchema is a later polish.)
 */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return {
      content: [
        { type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    };
  }
}

/**
 * Register the v1 tool surface on the server. Each tool is a thin adapter over a
 * `core/*` fn — same logic the CLI runs. Annotations follow docs/plugin-spec.md
 * D6: reads are `readOnlyHint`, writes are non-destructive, and no
 * delete/archive tool is exposed at all.
 */
export function registerTools(server: McpServer, client: LinearClient): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Resolve the authenticated Linear viewer and organization.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(() => getWhoami(client)),
  );

  server.registerTool(
    "project_list",
    {
      title: "List projects",
      description:
        "List Linear projects, optionally restricted to a team key (e.g. CER).",
      inputSchema: { team: z.string().optional().describe("team key, e.g. CER") },
      annotations: { readOnlyHint: true },
    },
    async ({ team }) => run(async () => ({ projects: await listProjects(client, team) })),
  );

  server.registerTool(
    "file_issue",
    {
      title: "File an issue",
      description:
        "Create a Linear issue in a team (and optionally a project). Returns identifier + url.",
      inputSchema: {
        team: z.string().describe("team key, e.g. CER"),
        title: z.string(),
        description: z.string().optional().describe("markdown body"),
        project: z.string().optional().describe("project id to attach to"),
        labels: z.array(z.string()).optional().describe("label names"),
        assignee: z
          .string()
          .optional()
          .describe("assignee: 'me', an email, a display name, or a user id"),
        priority: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe("priority: 1=Urgent 2=High 3=Medium 4=Low, 0=unset"),
        milestone: z
          .string()
          .optional()
          .describe("project milestone (name or id; pair with project for name lookup)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ team, title, description, project, labels, assignee, priority, milestone }) =>
      run(() =>
        createIssue(client, {
          teamKey: team,
          title,
          description,
          projectId: project,
          labels,
          assignee,
          priority,
          milestone,
        }),
      ),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create a project",
      description: "Create a Linear project under a team. Returns name + url + id.",
      inputSchema: {
        name: z.string(),
        team: z.string().describe("team key, e.g. CER"),
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, team, description }) =>
      run(() => createProject(client, { name, teamKey: team, description })),
  );

  server.registerTool(
    "issue_update",
    {
      title: "Update an issue",
      description:
        "Update a Linear issue's state, assignee, labels, project, or priority. State/assignee/labels resolve by name against the issue's team.",
      inputSchema: {
        id: z.string().describe("issue id or identifier, e.g. CER-123"),
        state: z.string().optional().describe("workflow state name, e.g. 'In Progress'"),
        assignee: z.string().optional().describe("'me', an email, a display name, or a user id"),
        labels: z.array(z.string()).optional().describe("label names (replaces existing)"),
        project: z.string().optional().describe("project id to move the issue to"),
        priority: z.number().int().min(0).max(4).optional().describe("0=None 1=Urgent 2=High 3=Medium 4=Low"),
        title: z.string().optional().describe("replace the issue title"),
        description: z.string().optional().describe("replace the description (markdown)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, state, assignee, labels, project, priority, title, description }) =>
      run(() =>
        updateIssue(client, id, {
          state,
          assignee,
          labels,
          projectId: project,
          priority,
          title,
          description,
        }),
      ),
  );

  server.registerTool(
    "issue_close",
    {
      title: "Close an issue",
      description: "Move a Linear issue to its team's completed state.",
      inputSchema: { id: z.string().describe("issue id or identifier, e.g. CER-123") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) => run(() => closeIssue(client, id)),
  );

  server.registerTool(
    "comment_issue",
    {
      title: "Comment on an issue",
      description:
        "Add a comment to a Linear issue. Non-destructive (additive) — the missing write mutation next to issue_update / issue_close.",
      inputSchema: {
        id: z.string().describe("issue id or identifier, e.g. CER-123"),
        body: z.string().describe("comment body (markdown)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, body }) => run(() => createComment(client, id, body)),
  );

  server.registerTool(
    "project_overview_get",
    {
      title: "Read a project overview",
      description:
        "Read a Linear project's overview document (markdown) — the project's Overview tab.",
      inputSchema: {
        project: z.string().describe("project UUID, slug id, or name"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => run(() => getProjectOverview(client, project)),
  );

  server.registerTool(
    "project_overview_set",
    {
      title: "Set a project overview",
      description:
        "Replace a Linear project's overview document with markdown (whole-document replace; refuses empty content).",
      inputSchema: {
        project: z.string().describe("project UUID, slug id, or name"),
        content: z.string().describe("the full overview document as markdown"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ project, content }) =>
      run(() => setProjectOverview(client, project, content)),
  );

  // --- read / grooming tools (CER-1162) ---

  server.registerTool(
    "digest",
    {
      title: "Recent activity digest",
      description:
        "Issues updated within a window, grouped by workflow-state type (completed / started / …).",
      inputSchema: {
        since: z.string().optional().describe("look-back window, e.g. 7d / 24h / 2w (default 7d)"),
        team: z.array(z.string()).optional().describe("team key(s); omit for every team"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since, team }) => run(() => digest(client, sinceToDate(since ?? "7d"), team)),
  );

  server.registerTool(
    "triage",
    {
      title: "Triage surface",
      description:
        "Issues needing triage: in Triage state, or unassigned / unestimated / no-priority (active only). Each row flags why it surfaced.",
      inputSchema: {
        team: z.array(z.string()).optional().describe("team key(s); omit for every team"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ team }) => run(() => triage(client, team)),
  );

  server.registerTool(
    "milestone",
    {
      title: "Milestone burn-down",
      description:
        "Per-milestone done-vs-total (with percent) for a project, or all accessible milestones.",
      inputSchema: {
        project: z.string().optional().describe("project UUID, slug id, or name"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => run(() => milestones(client, project)),
  );

  server.registerTool(
    "stale",
    {
      title: "Stale sweep",
      description:
        "Active issues by last-update age, bucketed warn (>older-than) / critical (>~90d). Read-only — surfacing only.",
      inputSchema: {
        team: z.array(z.string()).optional().describe("team key(s); omit for every team"),
        olderThan: z.string().optional().describe("warn threshold, e.g. 30d / 2w (default 30d)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ team, olderThan }) =>
      run(() => {
        const now = new Date();
        const warnCutoff = sinceToDate(olderThan ?? "30d", now);
        const ninetyCutoff = sinceToDate("90d", now);
        const criticalCutoff = warnCutoff < ninetyCutoff ? warnCutoff : ninetyCutoff;
        return stale(client, { teamKeys: team, warnCutoff, criticalCutoff, now });
      }),
  );
}
