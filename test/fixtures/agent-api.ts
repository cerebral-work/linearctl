// Child-process-only HTTP fixture. Never loaded by production entrypoints.
const scenario = process.env.LINEARCTL_TEST_SCENARIO;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const { query, variables } = JSON.parse(String(init?.body ?? "{}"));
  const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  if (scenario === "team" && query.includes("teams(")) return Response.json({ data: { teams: connection(variables?.filter ? [] : [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: "Operations" }]) } });
  if (scenario === "label") {
    if (query.includes("teams(")) return Response.json({ data: { teams: connection([{ id: "t1", key: "ENG", name: "Engineering" }]) } });
    if (query.includes("issueLabels(")) return Response.json({ data: { issueLabels: connection(["skill", "skills-ui", "skies", "unrelated"].map(name => ({ id: name, name }))) } });
  }
  if (scenario === "bulk" && query.includes("query Resolve")) return Response.json({ data: { r0: { id: "issue-uuid", identifier: "ENG-123" } } });
  if (scenario === "dup" && query.includes("teams(")) return Response.json({ data: { teams: connection([{ id: "t1", key: "ENG", name: "Engineering" }]) } });
  if (scenario === "dup" && query.includes("issues(")) return Response.json({ data: { issues: connection([{ id: "i1", identifier: "ENG-123", title: "Fix timeout", url: "https://example.com/ENG-123", state: { name: "Todo", type: "unstarted" }, labels: { nodes: [] } }]) } });
  if (scenario === "userinput") return Response.json({ errors: [{ message: 'Duplicate label name - Label "annex-iii-2027" already exists in team Business Development', extensions: { type: "userinput", userError: true } }] }, { status: 400 });
  if (scenario === "auth") return Response.json({ errors: [{ message: "Invalid API key", extensions: { code: "AUTHENTICATION_ERROR", type: "authentication error" } }] }, { status: 401 });
  if (scenario === "rate_limit") return Response.json({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] }, { status: 429, headers: { "X-RateLimit-Requests-Remaining": "0" } });
  throw new Error("fixture transport failure");
}) as unknown as typeof fetch;
