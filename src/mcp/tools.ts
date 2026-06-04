import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { LinearClient } from "@linear/sdk";
import { getWhoami } from "../core/whoami.js";
import { createIssue, updateIssue, closeIssue } from "../core/issues.js";
import { createProject, listProjects } from "../core/projects.js";

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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ team, title, description, project, labels }) =>
      run(() =>
        createIssue(client, {
          teamKey: team,
          title,
          description,
          projectId: project,
          labels,
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, state, assignee, labels, project, priority }) =>
      run(() =>
        updateIssue(client, id, {
          state,
          assignee,
          labels,
          projectId: project,
          priority,
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
}
