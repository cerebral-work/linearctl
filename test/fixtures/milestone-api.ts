// Isolated subprocess fixture: require both the new flag and complete state scope.
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const { variables } = JSON.parse(String(init?.body ?? "{}"));
  if (JSON.stringify(variables.filter) !== JSON.stringify({ and: [{ projectMilestone: { name: { eqIgnoreCase: "Launch" } } }] })) {
    throw new Error("milestone flag did not reach the GraphQL filter");
  }
  return Response.json({ data: { issues: {
    nodes: [{ id: "issue-1", identifier: "ENG-123", title: "Example", url: "https://example.com/issue", priority: 3, description: "", updatedAt: "2026-10-01T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: null, labels: { nodes: [] } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } });
}) as unknown as typeof fetch;
