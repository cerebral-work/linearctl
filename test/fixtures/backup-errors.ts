// Child-process-only fixture: exercise the real CLI boundary without API access or retry sleeps.
import "./agent-api.js";
const timer = globalThis.setTimeout;
globalThis.setTimeout = ((callback: TimerHandler, _delay?: number, ...args: unknown[]) => timer(callback, 0, ...args)) as typeof setTimeout;
if (process.env.LINEARCTL_TEST_SCENARIO === "not_found") {
  globalThis.fetch = (async () => Response.json({ errors: [{ message: "Missing resource", extensions: { code: "NOT_FOUND" } }] }, { status: 404 })) as unknown as typeof fetch;
}
if (process.env.LINEARCTL_TEST_SCENARIO === "drift") {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    const root = query.match(/query Count[\s\S]*?\{\s*(\w+)\(/)?.[1];
    if (!root) throw new Error("unexpected verification query");
    return Response.json({ data: { [root]: { nodes: [{ id: "extra-1" }, { id: "extra-2" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
  }) as unknown as typeof fetch;
}
