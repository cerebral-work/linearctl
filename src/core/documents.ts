import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";
import { resolveTeamByKey } from "./teams.js";
import { resolveIssueId } from "./issues.js";
import { resolveProject } from "./projects.js";

export interface DocumentInfo {
  id: string;
  slugId: string;
  title: string;
  url: string;
  project: string | null;
}

const LIST_QUERY = /* GraphQL */ `
  query DocsList($filter: DocumentFilter, $first: Int!, $after: String) {
    documents(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        slugId
        title
        url
        project {
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** List documents, optionally scoped to a project. One paginated query. */
export async function listDocuments(
  client: LinearClient,
  opts: { project?: string } = {},
): Promise<DocumentInfo[]> {
  const projectId = opts.project ? (await resolveProject(client, opts.project)).id : undefined;
  type Vars = Record<string, unknown> & { first: number; after: string | null };
  const out: DocumentInfo[] = [];
  let after: string | null = null;
  do {
    const vars: Vars = {
      filter: projectId ? { project: { id: { eq: projectId } } } : {},
      first: 100,
      after,
    };
    const res = await withRetry(() =>
      client.client.rawRequest<
        {
          documents: {
            nodes: Array<{
              id: string;
              slugId: string;
              title: string;
              url: string;
              project: { name: string } | null;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        },
        Vars
      >(LIST_QUERY, vars),
    );
    const page = res.data?.documents;
    if (!page) throw new Error("documents query returned no data");
    for (const n of page.nodes) {
      out.push({ ...n, project: n.project?.name ?? null });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out;
}

export interface DocCreateParams {
  title: string;
  content: string;
  project?: string;
  issue?: string;
  teamKey?: string;
}

/** Create a document under a project, issue, or team (exactly one parent). */
export async function createDocument(
  client: LinearClient,
  params: DocCreateParams,
): Promise<DocumentInfo> {
  const parents = [params.project, params.issue, params.teamKey].filter(Boolean);
  if (parents.length !== 1) {
    throw new Error("doc create needs exactly one parent: --project, --issue, or --team.");
  }
  const input: Parameters<LinearClient["createDocument"]>[0] = {
    title: params.title,
    content: params.content,
  };
  if (params.project) input.projectId = (await resolveProject(client, params.project)).id;
  if (params.issue) input.issueId = await resolveIssueId(client, params.issue);
  if (params.teamKey) input.teamId = (await resolveTeamByKey(client, params.teamKey)).id;

  const res = await withRetry(() => client.createDocument(input));
  const doc = await res.document;
  if (!res.success || !doc) throw new Error("Linear reported the document create did not succeed.");
  return { id: doc.id, slugId: doc.slugId, title: doc.title, url: doc.url, project: null };
}

/** Update a document's content and/or title by id or slug. */
export async function updateDocument(
  client: LinearClient,
  ref: string,
  changes: { content?: string; title?: string },
): Promise<DocumentInfo> {
  if (changes.content === undefined && changes.title === undefined) {
    throw new Error("doc update needs --content and/or --title.");
  }
  const doc = await withRetry(() => client.document(ref));
  const res = await withRetry(() => client.updateDocument(doc.id, changes));
  const updated = await res.document;
  if (!res.success || !updated) {
    throw new Error("Linear reported the document update did not succeed.");
  }
  return {
    id: updated.id,
    slugId: updated.slugId,
    title: updated.title,
    url: updated.url,
    project: null,
  };
}
