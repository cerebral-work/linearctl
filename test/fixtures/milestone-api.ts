// Child-process-only fixture. Unexpected lookups/issue filters fail loudly.
const milestoneId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000010";
const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const { query, variables } = JSON.parse(String(init?.body ?? "{}"));
  const scenario = process.env.MILESTONE_TEST_SCENARIO;
  if (query.includes("projects(")) {
    return Response.json({ data: { projects: connection([{ id: projectId, name: "Example project" }]) } });
  }
  if (query.includes("projectMilestones(")) {
    if (scenario === "uuid") throw new Error("UUID path must not resolve milestones");
    if (scenario === "scoped-missing" && variables.filter.project?.id?.eq !== projectId)
      throw new Error("lookup was not scoped to the resolved project");
    const name = variables.filter.name?.eqIgnoreCase;
    if (name === "Launch") return Response.json({ data: { projectMilestones: connection([{ id: milestoneId, name: "Launch" }, { id: secondId, name: "Launch" }]) } });
    if (name) return Response.json({ data: { projectMilestones: connection([]) } });
    return Response.json({ data: { projectMilestones: connection(["Launch", "Launch QA", "Launch UI", "Unrelated"].map((name, i) => ({ id: `m${i}`, name }))) } });
  }
  // A typo must fail before the issue query: an empty result must not mask it.
  if (scenario?.includes("missing")) throw new Error("unknown milestone reached issue query");
  const expected = scenario === "uuid" ? { id: { eq: milestoneId } } : { id: { in: [milestoneId, secondId] } };
  if (JSON.stringify(variables.filter) !== JSON.stringify({ and: [{ projectMilestone: expected }] })) {
    throw new Error("resolved milestone ids or --state all did not reach the issue query");
  }
  return Response.json({ data: { issues: connection(scenario === "empty" ? [] : [
    { id: "issue-1", identifier: "ENG-123", title: "Example", url: "https://example.com/issue", priority: 3, description: "", updatedAt: "2026-10-01T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: null, labels: { nodes: [] } },
  ]) } });
}) as unknown as typeof fetch;
