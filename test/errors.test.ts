import { describe, expect, test } from "bun:test";
import { cliError, errorEnvelope, printCliError } from "../src/lib/errors.js";
import { spyOn } from "bun:test";

const diagnostic = 'Duplicate label name - Label "annex-iii-2027" already exists in team Business Development';
describe("Linear user-input diagnostics", () => {
  test("raw GraphQL first message and userError survive in text and JSON", () => {
    const err = { errors: [
      { message: diagnostic, extensions: { type: "userinput", userError: true } },
      { message: "second diagnostic must not replace the first" },
    ], query: "private query", variables: { body: "private body" } };
    expect(cliError(err)).toMatchObject({ kind: "usage", code: 2, message: diagnostic + " (userError=true)" });
    expect(errorEnvelope(err).error).toMatchObject({ kind: "usage", code: 2, message: diagnostic + " (userError=true)" });
    const chunks: string[] = [];
    const writer = spyOn(process.stderr, "write").mockImplementation(((text: string) => { chunks.push(String(text)); return true; }) as never);
    try {
      expect(printCliError(err, false)).toBe(2);
      expect(chunks.join("")).toContain(diagnostic);
      expect(chunks.join("")).toContain("userError=true");
      chunks.length = 0;
      expect(printCliError(err, true)).toBe(2);
      expect(JSON.parse(chunks.join("")).error.message).toBe(diagnostic + " (userError=true)");
      expect(chunks.join("")).not.toContain("private");
    } finally { writer.mockRestore(); }
  });
  test("SDK-flattened UserError and boolean userError are recognized", () => {
    for (const err of [
      { type: "UserError", errors: [{ type: "UserError", message: diagnostic, userError: true }] },
      { errors: [{ message: diagnostic, userError: true }] },
      { errors: [{ message: diagnostic, extensions: { type: "invalid input", userError: false } }] },
    ]) {
      expect(cliError(err).code).toBe(2);
      expect(errorEnvelope(err).error.message).toContain(diagnostic);
    }
  });
  test("specific auth, permission and rate failures take precedence over userError", () => {
    for (const [status, code] of [[401, 3], [403, 6], [404, 4], [429, 5]]) {
      expect(cliError({ status, errors: [{ message: diagnostic, userError: true }] }).code).toBe(code);
    }
  });
  test("fallback keeps a safe summary, without request dumps", () => {
    expect(cliError({ type: "invalid_input", message: 'Invalid name: {"response":{"secret":"hidden"}}' }).message).toBe("Invalid name");
    expect(cliError({ type: "invalid_input" }).message).toBe("Linear rejected an invalid input.");
  });
  test("known API key is redacted from preserved diagnostics", () => {
    const prior = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "test-only-diagnostic-key";
    try {
      const msg = errorEnvelope({ errors: [{ message: "Bad value test-only-diagnostic-key", extensions: { type: "userinput" } }] }).error.message;
      expect(msg).toBe("Bad value [redacted]");
    } finally {
      if (prior === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prior;
    }
  });
  test("structured missing-duplicate error retains message and actionable hint", () => {
    const message = "Missing duplicate relation - Issues can only be moved to a duplicate state when a duplicate issue relation exists";
    const e = cliError({ errors: [{ message, extensions: { type: "userinput", userError: true } }] });
    expect(e.code).toBe(2);
    expect(e.message).toContain(message);
    expect(e.hint).toContain("--duplicate-of <canonical>");
  });
});
