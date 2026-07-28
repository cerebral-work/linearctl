/**
 * 1Password read helpers for the `linear-unsigned-oauth` item (CER-1148).
 *
 * Reads secrets via `op read 'op://<vault>/<item>/<field>'` — never echoes,
 * caches to disk, logs, or commits. Field IDs are used (not labels) because
 * the `dev_user_token` field label has a trailing space bug — field IDs are
 * stable regardless of label typos.
 *
 * Estate secret-naming rule: never echo/printf/`${VAR:-}`-expand any var
 * matching `*KEY*`/`*TOKEN*`/`*SECRET*`/`*CRED*`/`*PASSWORD*`. This module
 * returns secret strings to the caller for immediate use (mint → hold in
 * memory → pass to fetch → let GC collect); it never prints them.
 */

import { execFileSync } from "node:child_process";

/** The 1Password item reference for the Linear unsigned OAuth app. */
export const LINEAR_OAUTH_ITEM = {
  vault: "cloud",
  item: "linear-unsigned-oauth",
  itemId: "me2kbjlb7xurnjp333vju5l7zm",
  // field IDs (stable; labels are not — `dev_user_token` has a trailing space)
  fields: {
    credential: "credential", // client_secret (the OAuth app secret)
    clientId: "26za4ioosshacw7vn2jwgmf4cu",
    webhookUrl: "73ldnmye2kavtciji4v36i3nre",
    webhookSecret: "zfgau2zjmlgsaxam2mh24jmz6a",
    devAppToken: "uaoaxvx42cir2dgqdfgk7vlgca",
    devUserToken: "ex2h6hzl7orh6gdrio6zeqrwia", // NB: label has trailing space — read by ID
    redirectUrl: "5ehgmyh4uwnli5sgrhkkmemdva",
  },
} as const;

/** A read secret handle — the value flows through here to the caller; nothing is persisted. */
export interface Secret {
  /** The secret value. Only hold in memory long enough to use it. */
  readonly value: string;
  /** Opaque reference for error messages without revealing the value. */
  readonly redacted: string;
}

/** Read a single 1Password field by its `op://` reference. Throws on missing/op failure. */
export function readSecret(reference: string): Secret {
  try {
    const value = execFileSync("op", ["read", reference], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!value) {
      throw new Error(`1Password returned empty value for ${reference}`);
    }
    return { value, redacted: `<redacted ${reference}>` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to read 1Password secret ${reference}: ${msg}\n` +
        `  ensure ` + "`op`" + ` is signed in (run ` + "`op signin`" + `) and the field resolves.`,
    );
  }
}

/** `op://cloud/linear-unsigned-oauth/<fieldId>` reference builder. */
export function ref(fieldId: string): string {
  return `op://${LINEAR_OAUTH_ITEM.vault}/${LINEAR_OAUTH_ITEM.item}/${fieldId}`;
}

/** All fields the linearctl OAuth path reads from 1Password. Each returns a Secret handle. */
export function readLinearOAuthCreds(): {
  clientId: Secret;
  clientSecret: Secret;
  webhookUrl: Secret;
  webhookSecret: Secret;
  devAppToken: Secret;
  devUserToken: Secret;
  redirectUrl: Secret;
} {
  return {
    clientId: readSecret(ref(LINEAR_OAUTH_ITEM.fields.clientId)),
    clientSecret: readSecret(ref(LINEAR_OAUTH_ITEM.fields.credential)),
    webhookUrl: readSecret(ref(LINEAR_OAUTH_ITEM.fields.webhookUrl)),
    webhookSecret: readSecret(ref(LINEAR_OAUTH_ITEM.fields.webhookSecret)),
    devAppToken: readSecret(ref(LINEAR_OAUTH_ITEM.fields.devAppToken)),
    devUserToken: readSecret(ref(LINEAR_OAUTH_ITEM.fields.devUserToken)),
    redirectUrl: readSecret(ref(LINEAR_OAUTH_ITEM.fields.redirectUrl)),
  };
}
