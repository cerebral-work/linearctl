/** Stable CLI failure contract. Core callers may inspect kind without parsing prose. */
export const EXIT_CODES = { other: 1, usage: 2, auth: 3, not_found: 4, rate_limit: 5, refused: 6 } as const;
export type ErrorKind = keyof typeof EXIT_CODES;
export class CliError extends Error {
  readonly code: number;
  constructor(readonly kind: ErrorKind, message: string, readonly hint = "") {
    super(message);
    this.name = "CliError";
    this.code = EXIT_CODES[kind];
  }
}
export const usageError = (message: string, hint = "") => new CliError("usage", message, hint);
export const notFoundError = (message: string, hint = "") => new CliError("not_found", message, hint);
export const refusedError = (message: string, hint = "") => new CliError("refused", message, hint);

/** Map SDK / HTTP failures at the boundary; do not dump request headers or bodies. */
export function cliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const e = (err ?? {}) as { status?: number; type?: string; code?: string; name?: string; message?: unknown; userError?: boolean;
    errors?: Array<{ message?: unknown; type?: string; userError?: boolean; extensions?: { type?: string; code?: string; userError?: boolean } }> };
  const types = [e.type, e.code, ...(e.errors ?? []).flatMap(g => [g.type, g.extensions?.type, g.extensions?.code])].join(" ");
  const message = typeof e.message === "string" ? e.message : String(err);
  // Read only the first structured GraphQL diagnostic, never SDK query/variables/raw.
  // The SDK flattens extensions.userError onto each LinearGraphQLError.
  const first = e.errors?.[0];
  const userError = first?.userError ?? first?.extensions?.userError ?? e.userError;
  const detail = typeof first?.message === "string" && first.message.trim() ? first.message : message;
  const summary = detail.split(/\r?\n|: \{"(?:response|request)"/)[0].trim();
  const usageMessage = `${summary && summary !== "[object Object]" ? summary : "Linear rejected an invalid input."}${typeof userError === "boolean" ? ` (userError=${userError})` : ""}`;
  if (e.status === 429 || /ratelimit|rate_limit/i.test(types) || /ratelimited|rate limit|too many requests/i.test(message))
    return new CliError("rate_limit", "Linear API rate limit exhausted.", "Wait for quota to reset; check linearctl ratelimit --json.");
  if (e.status === 401 || /authentication|unauthenticated|invalid_api_key/i.test(types))
    return new CliError("auth", "Linear authentication failed.", "Set a valid LINEAR_API_KEY in the environment.");
  if (e.status === 404 || /entitynotfound|not_found/i.test(types))
    return notFoundError("Requested resource was not found.");
  if (e.status === 403 || /forbidden|permission/i.test(types)) return refusedError("Permission denied for this operation.");
  if (/Missing duplicate relation|Issues can only be moved to a duplicate state when a duplicate issue relation exists/i.test(detail))
    return usageError(usageMessage, "Use linearctl close <id> --duplicate-of <canonical>, or linearctl update <id> --duplicate-of <canonical> to create the relation first.");
  if (/invalid[ _]?input|user[ _]?input|user[ _]?error|bad_user_input/i.test(types) || userError === true) return usageError(usageMessage);
  if (e.name === "GuardrailError") return refusedError(message);
  // SDK messages may contain a serialized GraphQL request. Keep only its summary.
  return new CliError("other", message.split(/\n|: \{"response"/)[0]);
}

export function errorEnvelope(err: unknown, fallbackHint = "") {
  const e = cliError(err);
  const redact = (text: string) => {
    const key = process.env.LINEAR_API_KEY;
    return key ? text.split(key).join("[redacted]") : text;
  };
  return { error: { code: e.code, kind: e.kind, message: redact(e.message), hint: redact([e.hint, fallbackHint].filter(Boolean).join(" ")) } };
}

export function printCliError(err: unknown, json: boolean, hint = ""): number {
  const envelope = errorEnvelope(err, hint);
  process.stderr.write(json ? JSON.stringify(envelope) + "\n" :
    `error: ${envelope.error.message}\n${envelope.error.hint ? envelope.error.hint + "\n" : ""}`);
  return envelope.error.code;
}

/** Preserve partial-success reports on stdout, but never return success for failed rows. */
export function assertBatchSucceeded(failed: Array<{ error?: string; kind?: ErrorKind }>, unresolved: string[] = []): void {
  if (failed.length) {
    const kinds = new Set(failed.map(f => f.kind ?? "other"));
    throw new CliError(kinds.size === 1 ? [...kinds][0] : "other",
      `${failed.length} batch item(s) failed; inspect outcomes on stdout.`, "Some writes may have succeeded; re-read before retrying failed items.");
  }
  if (unresolved.length) throw notFoundError(`${unresolved.length} issue(s) were not found; inspect unresolved identifiers on stdout.`);
}
