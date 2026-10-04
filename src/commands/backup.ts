import { makeClient } from "../client.js";
import {
  BackupUsageError,
  ENTITY_NAMES,
  resolveSince,
  runBackup,
  verifyBackup,
} from "../core/backup.js";
import { printJson } from "../lib/output.js";
import pkg from "../../package.json";

export interface BackupOptions {
  out?: string;
  includeHistory?: boolean;
  since?: string;
  team?: string[];
  limit?: number;
  entities?: string;
  resume?: boolean;
  /** commander negatable: `--no-markdown` sets false; default true. */
  markdown?: boolean;
  verify?: string;
  tolerance?: number;
  offline?: boolean;
  json?: boolean;
}

function usage(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(3);
}

/**
 * `linearctl backup --out <dir>` — read-only dump of the workspace to
 * `<dir>/linear-<UTC>/`. `linearctl backup --verify <dir>` — integrity and
 * drift check of an existing dump. Exit codes: 0 ok · 1 error or hash/count
 * mismatch · 2 live drift beyond --tolerance · 3 usage.
 */
export async function backup(opts: BackupOptions): Promise<void> {
  try {
    if (opts.verify) {
      if (opts.out || opts.resume || opts.includeHistory) usage("--verify cannot be combined with --out/--resume/--include-history");
      const tolerance = opts.tolerance ?? 0.02;
      if (!(tolerance >= 0 && tolerance <= 1)) usage("--tolerance must be a fraction between 0 and 1 (0.02 = 2%)");
      const result = await verifyBackup(opts.verify, {
        client: opts.offline ? undefined : makeClient(),
        tolerance,
      });
      if (opts.json) printJson(result);
      else {
        const lines = [
          ...result.hashMismatches.map((l) => `HASH   ${l}`),
          ...result.countMismatches.map((l) => `COUNT  ${l}`),
          ...result.integrity.map((l) => `REF    ${l}`),
          ...result.drift.map((l) => `DRIFT  ${l}`),
          ...result.sampleMismatches.map((l) => `SAMPLE ${l}`),
          ...result.notes.map((l) => `note   ${l}`),
        ];
        console.log(lines.length ? lines.join("\n") : "verify: clean");
        console.log(`exit ${result.exitCode}`);
      }
      process.exit(result.exitCode);
    }

    if (!opts.out) usage("--out <dir> is required (or use --verify <dir>)");
    const entities = opts.entities?.split(",").map((s) => s.trim()).filter(Boolean);
    if (entities?.some((e) => !ENTITY_NAMES.includes(e))) {
      usage(`unknown entity in --entities; valid: ${ENTITY_NAMES.join(", ")}`);
    }
    if (opts.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit > 0)) usage("--limit must be a positive integer");
    const since = opts.since ? resolveSince(opts.since) : undefined;

    const progress = (line: string) => process.stderr.write(`  ${line}\n`);
    const { dir, manifest } = await runBackup(makeClient(), {
      out: opts.out,
      entities,
      teams: opts.team,
      limit: opts.limit,
      since,
      includeHistory: opts.includeHistory,
      resume: opts.resume,
      markdown: opts.markdown !== false,
      version: pkg.version,
      log: opts.json ? () => {} : progress,
    });

    if (opts.json) {
      printJson({ dir, manifest });
      return;
    }
    const counts = Object.entries(manifest.entities)
      .map(([k, v]) => `${k}=${v.count}`)
      .join(" ");
    console.log(`backup written: ${dir}`);
    console.log(counts);
    if (manifest.partial) console.log("partial: yes (scope narrowed by flags)");
    for (const w of manifest.warnings) console.log(`warning: ${w}`);
  } catch (err) {
    if (err instanceof BackupUsageError) usage(err.message);
    throw err;
  }
}
