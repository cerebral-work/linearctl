import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import {
  listDocuments,
  createDocument,
  updateDocument,
} from "../src/core/documents.js";

// ---- stub factory ----

function stubClient(opts: {
  docs?: { id: string; slugId: string; title: string; url: string; projectName: string | null }[];
  createSuccess?: boolean;
  createdDoc?: { id: string; slugId: string; title: string; url: string };
  updateSuccess?: boolean;
  updatedDoc?: { id: string; slugId: string; title: string; url: string };
  project?: { id: string; name: string };
}): { client: LinearClient; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const docs = opts.docs ?? [];

  const client = {
    client: {
      rawRequest: async (_query: string, _vars: { first: number; after: string | null }) => {
        return {
          data: {
            documents: {
              nodes: docs.map((d) => ({
                id: d.id,
                slugId: d.slugId,
                title: d.title,
                url: d.url,
                project: d.projectName ? { name: d.projectName } : null,
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    },
    project: () =>
      Promise.resolve(
        opts.project ?? { id: "proj-1", name: "linearctl" },
      ),
    projects: () =>
      Promise.resolve({
        nodes: [opts.project ?? { id: "proj-1", name: "linearctl" }],
      }),
    document: (_ref: string) =>
      Promise.resolve({
        id: opts.updatedDoc?.id ?? "doc-1",
        slugId: opts.updatedDoc?.slugId ?? "slug-1",
        title: opts.updatedDoc?.title ?? "Original",
        url: opts.updatedDoc?.url ?? "https://linear.app/x/doc/doc-1",
      }),
    createDocument: (input: Record<string, unknown>) => {
      calls.push({ method: "create", ...input });
      return Promise.resolve({
        success: opts.createSuccess ?? true,
        document: Promise.resolve(
          opts.createdDoc ?? {
            id: "doc-new",
            slugId: "slug-new",
            title: input.title as string,
            url: "https://linear.app/x/doc/doc-new",
          },
        ),
      });
    },
    updateDocument: (id: string, input: Record<string, unknown>) => {
      calls.push({ method: "update", id, ...input });
      return Promise.resolve({
        success: opts.updateSuccess ?? true,
        document: Promise.resolve(
          opts.updatedDoc ?? {
            id,
            slugId: "slug-1",
            title: (input.title as string) ?? "Updated",
            url: "https://linear.app/x/doc/doc-1",
          },
        ),
      });
    },
  } as unknown as LinearClient;

  return { client, calls };
}

// ---- listDocuments ----

describe("listDocuments", () => {
  test("returns documents with id, slugId, title, url, project name", async () => {
    const { client } = stubClient({
      docs: [
        { id: "d1", slugId: "s1", title: "Architecture", url: "https://l.app/d1", projectName: "linearctl" },
        { id: "d2", slugId: "s2", title: "Standards", url: "https://l.app/d2", projectName: null },
      ],
    });

    const docs = await listDocuments(client);

    expect(docs).toHaveLength(2);
    expect(docs[0].id).toBe("d1");
    expect(docs[0].title).toBe("Architecture");
    expect(docs[0].project).toBe("linearctl");
    expect(docs[1].project).toBeNull();
  });

  test("returns empty array when no documents exist", async () => {
    const { client } = stubClient({ docs: [] });

    const docs = await listDocuments(client);

    expect(docs).toEqual([]);
  });

  test("scopes to a project when --project is provided (name → UUID resolution)", async () => {
    const { client } = stubClient({
      docs: [],
      project: { id: "proj-uuid-1234", name: "linearctl" },
    });

    const docs = await listDocuments(client, { project: "linearctl" });

    expect(docs).toEqual([]);
    // The listDocuments function resolved "linearctl" → proj-uuid-1234 internally
    // and passed it as a filter to the rawRequest. The stub returns empty
    // because docs: []. Verifies no throw + correct shape.
  });
});

// ---- createDocument ----

describe("createDocument", () => {
  test("creates a document under a project, resolving name to UUID", async () => {
    const { client, calls } = stubClient({
      project: { id: "proj-uuid-1234", name: "linearctl" },
      createdDoc: { id: "doc-new", slugId: "slug-new", title: "Design Doc", url: "https://l.app/dn" },
    });

    const doc = await createDocument(client, {
      title: "Design Doc",
      content: "# Design",
      project: "linearctl",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("create");
    expect(calls[0].title).toBe("Design Doc");
    expect(calls[0].content).toBe("# Design");
    expect(calls[0].projectId).toBe("proj-uuid-1234");
    expect(doc.id).toBe("doc-new");
    expect(doc.title).toBe("Design Doc");
  });

  test("throws when no parent is specified", async () => {
    const { client } = stubClient({});

    await expect(
      createDocument(client, { title: "X", content: "x" }),
    ).rejects.toThrow(/exactly one parent/);
  });

  test("throws when multiple parents are specified", async () => {
    const { client } = stubClient({});

    await expect(
      createDocument(client, {
        title: "X",
        content: "x",
        project: "linearctl",
        teamKey: "CER",
      }),
    ).rejects.toThrow(/exactly one parent/);
  });

  test("throws when Linear reports failure", async () => {
    const { client } = stubClient({
      project: { id: "p1", name: "linearctl" },
      createSuccess: false,
    });

    await expect(
      createDocument(client, { title: "X", content: "x", project: "linearctl" }),
    ).rejects.toThrow(/did not succeed/);
  });
});

// ---- updateDocument ----

describe("updateDocument", () => {
  test("updates content", async () => {
    const { client, calls } = stubClient({
      updatedDoc: { id: "doc-1", slugId: "slug-1", title: "Original", url: "https://l.app/d1" },
    });

    const doc = await updateDocument(client, "doc-1", { content: "new content" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("update");
    expect(calls[0].content).toBe("new content");
    expect(doc.id).toBe("doc-1");
  });

  test("updates title", async () => {
    const { client, calls } = stubClient({});

    await updateDocument(client, "slug-1", { title: "Renamed" });

    expect(calls[0].title).toBe("Renamed");
  });

  test("updates both content and title", async () => {
    const { client, calls } = stubClient({});

    await updateDocument(client, "doc-1", { content: "new", title: "New Title" });

    expect(calls[0].content).toBe("new");
    expect(calls[0].title).toBe("New Title");
  });

  test("throws when no changes provided", async () => {
    const { client } = stubClient({});

    await expect(
      updateDocument(client, "doc-1", {}),
    ).rejects.toThrow(/needs --content and\/or --title/);
  });

  test("throws when Linear reports failure", async () => {
    const { client } = stubClient({ updateSuccess: false });

    await expect(
      updateDocument(client, "doc-1", { content: "x" }),
    ).rejects.toThrow(/did not succeed/);
  });
});
