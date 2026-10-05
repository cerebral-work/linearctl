import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, parse, validate } from "graphql";

/**
 * Offline contract test: every GraphQL document embedded in src/ must validate
 * against the vendored Linear schema (test/fixtures/linear-schema.graphql).
 * Catches variable-type mismatches such as `$id: String!` feeding a filter
 * comparator that expects `ID`, which Linear otherwise rejects only at runtime:
 *   Variable "$id" of type "String!" used in position expecting type "ID".
 */

const SRC = join(import.meta.dir, "..", "src");
const SCHEMA = buildSchema(
  readFileSync(join(import.meta.dir, "fixtures", "linear-schema.graphql"), "utf8"),
);

/** Real count at time of writing is higher; this floor stops a broken
 *  extractor from passing vacuously. Raise it when documents are added. */
const MIN_DOCUMENTS = 60;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

interface Doc {
  file: string;
  text: string;
  interpolated: boolean;
}

/** Template literals whose body starts with query/mutation/subscription
 *  (optionally after a `/* GraphQL *\/` tag). `${...}` is replaced with a
 *  neutral token so dynamically assembled documents still parse. */
function extractDocuments(): Doc[] {
  const docs: Doc[] = [];
  const re = /`([^`]*)`/g;
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      const body = m[1];
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      if (/^\s*(\*|\/\/)/.test(src.slice(lineStart, m.index))) continue; // inside a comment
      const interpolated = body.includes("${");
      // A document: operation keyword, optional name, optional variable list,
      // then a selection set. Error-message strings that merely start with
      // the word "mutation" do not match. The runtime-assembled documents in
      // batch.ts declare their variables via interpolation.
      const isDoc = interpolated
        ? /^\s*(query|mutation)\s+\w+\(\$\{/.test(body)
        : /^\s*(query|mutation|subscription)\s*\w*\s*(\([^)]*\))?\s*\{/.test(body);
      if (!isDoc) continue;
      docs.push({ file: file.slice(SRC.length + 1), text: body, interpolated });
    }
  }
  return docs;
}

describe("embedded GraphQL documents validate against the Linear schema", () => {
  const docs = extractDocuments();

  test(`extractor found at least ${MIN_DOCUMENTS} documents`, () => {
    console.log(`graphql-documents: extracted ${docs.length} documents`);
    expect(docs.length).toBeGreaterThanOrEqual(MIN_DOCUMENTS);
  });

  for (const d of docs) {
    if (d.interpolated) continue; // covered by the assembled-document tests below
    const label = `${d.file}: ${d.text.trim().split("\n")[0].slice(0, 70)}`;
    test(label, () => {
      const res = validate(SCHEMA, parse(d.text));
      expect(res.map((e) => e.message)).toEqual([]);
    });
  }

  // Documents assembled at runtime (batch.ts) are rebuilt here with the same
  // shape so the declared variable types are still checked.
  test("batch resolve document (batch.ts)", () => {
    const decls = ["$r0: String!", "$r1: String!"].join(", ");
    const doc = `query Resolve(${decls}) { r0: issue(id: $r0) { id identifier } r1: issue(id: $r1) { id identifier } }`;
    expect(validate(SCHEMA, parse(doc)).map((e) => e.message)).toEqual([]);
  });
  test("batch update document (batch.ts)", () => {
    const doc = `mutation Batch($id0: String!, $in0: IssueUpdateInput!) { m0: issueUpdate(id: $id0, input: $in0) { success } }`;
    expect(validate(SCHEMA, parse(doc)).map((e) => e.message)).toEqual([]);
  });
  test("every interpolated document is accounted for", () => {
    // Interpolated documents cannot be validated directly; each is mirrored
    // by an assembled-document test above. A new one must be added there.
    const names = docs.filter((d) => d.interpolated).map((d) => d.file).sort();
    expect(names).toEqual(["core/batch.ts", "core/batch.ts"]);
  });
});
