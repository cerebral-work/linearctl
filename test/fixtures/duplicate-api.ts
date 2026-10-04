export {};
// Isolated CLI fixture; every request is intercepted, including mutations.
let relation = false;
let closed = false;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const { query, variables: v } = JSON.parse(String(init?.body));
  if (query.includes("query DuplicateIssue")) {
    const canonical = v.id === "CAN-1";
    return Response.json({ data: { issue: { id: canonical ? "canonical" : "source", identifier: canonical ? "CAN-1" : "SRC-1", title: "Title", url: "https://example.com", team: { id: "team" }, assignee: null, state: { id: closed ? "dupe" : "todo", name: closed ? "Duplicate" : "Todo", type: closed ? "duplicate" : "unstarted" } } } });
  }
  if (query.includes("query DuplicateRelations")) return Response.json({ data: { issue: { relations: { nodes: relation ? [{ type: "duplicate", relatedIssue: { id: "canonical" } }] : [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  if (query.includes("query DuplicateState")) return Response.json({ data: { workflowStates: { nodes: [{ id: "dupe", name: "Duplicate" }] } } });
  if (query.includes("mutation DuplicateRelationCreate")) {
    if (v.input.issueId !== "source" || v.input.relatedIssueId !== "canonical" || v.input.type !== "duplicate") throw new Error("wrong duplicate direction");
    relation = true;
    return Response.json({ data: { issueRelationCreate: { success: true } } });
  }
  if (query.includes("mutation DuplicateClose")) {
    if (!relation || v.id !== "source" || JSON.stringify(v.input) !== JSON.stringify({ stateId: "dupe" })) throw new Error("invalid close sequencing or fields");
    closed = true;
    return Response.json({ data: { issueUpdate: { success: true } } });
  }
  throw new Error("unexpected request in duplicate fixture");
}) as unknown as typeof fetch;
