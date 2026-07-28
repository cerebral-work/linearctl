/**
 * Unix-domain-socket control transport for the `linearctl operator` daemon
 * (CER-1149).
 *
 * A minimal HTTP-ish request/response protocol over AF_UNIX:
 *
 *   REQUEST  = REQUEST-LINE CRLF *(HEADER CRLF) CRLF LENGTH-DELIMITED-BODY
 *   REQUEST-LINE = "POST" SP PATH  ; or "GET" SP PATH  — no HTTP version, no host
 *   HEADER   = NAME ":" SP VALUE  ; e.g. "Content-Length: 42"
 *   LENGTH-DELIMITED-BODY = body of exactly Content-Length bytes (may be JSON)
 *
 *   RESPONSE = STATUS CRLF *(HEADER CRLF) CRLF LENGTH-DELIMITED-BODY
 *
 * Why not raw HTTP? Bun's `Bun.serve` can listen on a Unix socket, but it speaks
 * a real (stateless, streamed) HTTP/1.1 dialect that is heavy for a one-shot
 * delegate probe. This length-prefixed JSON framing is what `linearctl watch`
 * speaks on its delegate-to-operator branch: connect, send one request, read
 * one response, close. The client connect-timeout ensures the watch fallback
 * fires fast when no daemon is running.
 *
 * Uses `node:net` — Bun supports it. No external deps.
 */

import { createServer, connect, type Socket, type Server } from "node:net";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

/** Default socket path — matches the spec (XDG state dir). */
export const DEFAULT_OPERATOR_SOCKET = `${homedir()}/.local/state/linearctl/operator.sock`;

/** Default connect timeout for the client — fast-fail to the watch fallback. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 250;

/** A parsed control request handed to the handler. */
export interface ControlRequest {
  /** Method: "GET" or "POST". */
  method: string;
  /** Path: e.g. "/delegate", "/healthz". */
  path: string;
  /** Headers (lowercased names). */
  headers: Record<string, string>;
  /** Raw body bytes (empty when no Content-Length). */
  body: string;
}

/** The response a handler returns; serialized by the server. */
export interface ControlResponse {
  /** HTTP-ish status code (200, 404, 500). */
  status: number;
  /** Response headers (lowercased names). */
  headers?: Record<string, string>;
  /** Body text (often JSON). */
  body?: string;
}

/** A dispatcher maps a request to a response. Throw → 500. */
export type ControlHandler = (req: ControlRequest) => Promise<ControlResponse> | ControlResponse;

/** A bound control server; call `close()` to shut down (unlinks the socket). */
export interface ControlServer {
  /** The socket path actually listening on (after `listen`). */
  readonly socketPath: string;
  /** Stop listening and unlink the socket file. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Parse one full request from a buffer. Returns the parsed request + the byte
 * length consumed, or `null` if the buffer does not yet contain a complete
 * request (the server waits for more data).
 */
function tryParseRequest(buf: string): { req: ControlRequest; consumed: number } | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const head = buf.slice(0, headerEnd);
  const lines = head.split("\r\n");
  const requestLine = lines.shift();
  if (!requestLine) return null;

  const parts = requestLine.split(" ");
  const method = parts[0] ?? "";
  const path = parts[1] ?? "";

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = value;
  }

  const contentLength = headers["content-length"] ? parseInt(headers["content-length"], 10) : 0;
  if (Number.isNaN(contentLength) || contentLength < 0) return null;

  const bodyStart = headerEnd + 4;
  if (buf.length < bodyStart + contentLength) return null; // body incomplete

  const body = buf.slice(bodyStart, bodyStart + contentLength);
  return {
    req: { method, path, headers, body },
    consumed: bodyStart + contentLength,
  };
}

/** Serialize a response into the wire framing. */
function serializeResponse(res: ControlResponse): string {
  const statusText = res.status === 200 ? "OK" : res.status === 404 ? "Not Found" : "Error";
  const body = res.body ?? "";
  const headers: Record<string, string> = { ...(res.headers ?? {}) };
  if (!headers["content-length"]) headers["content-length"] = String(Buffer.byteLength(body, "utf8"));

  let head = `${res.status} ${statusText}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    head += `${name}: ${value}\r\n`;
  }
  head += "\r\n";
  return head + body;
}

/**
 * Start the control server on a Unix socket.
 *
 * `mkdir -p`s the parent dir, unlinks any stale socket file first (so a prior
 * crash doesn't EADDRINUSE), and registers a `close` that unlinks again on
 * shutdown (load-bearing: a crashing daemon must not orphan the socket).
 */
export function startControlServer(
  handler: ControlHandler,
  opts: { socketPath?: string } = {},
): Promise<ControlServer> {
  const socketPath = opts.socketPath ?? DEFAULT_OPERATOR_SOCKET;

  try {
    mkdirSync(dirname(socketPath), { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return Promise.reject(err);
    }
  }

  const { promise, resolve, reject } = Promise.withResolvers<ControlServer>();

  const server: Server = createServer((socket: Socket) => {
    let buf = "";
    socket.setEncoding("utf8");

    socket.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString("utf8");
      // Drain all complete requests in the buffer (keep-alive could batch).
      for (;;) {
        const parsed = tryParseRequest(buf);
        if (!parsed) break;
        buf = buf.slice(parsed.consumed);
        const { req } = parsed;

        Promise.resolve()
          .then(() => handler(req))
          .then((res) => socket.write(serializeResponse(res)))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            socket.write(serializeResponse({
              status: 500,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ok: false, error: msg }),
            }));
          })
          .finally(() => socket.end());
      }
    });

    socket.on("error", () => {
      // ECONNRESET on a peer that severed mid-request: swallow, don't crash.
    });
  });

  server.once("error", reject);

  server.listen(socketPath, () => {
    server.removeListener("error", reject);

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      const { promise: closedP, resolve: resolveClose } = Promise.withResolvers<void>();
      server.close(() => resolveClose());
      await closedP;
      try {
        unlinkSync(socketPath);
      } catch {
        // already gone — fine
      }
    };

    resolve({ socketPath, close });
  });

  return promise;
}

/** A one-shot client request/response over the Unix socket. */
export interface ControlClient {
  /** Send a request and read exactly one response; throws on timeout/socket error. */
  request: (method: string, path: string, body?: string) => Promise<ControlResponse>;
}

/**
 * Make a control client. Connection is lazy per-request. The connect timeout
 * ensures `linearctl watch`'s delegate attempt fails fast to the fallback path
 * when no daemon is listening (ECONNREFUSED resolves before the timeout).
 */
export function makeControlClient(
  socketPath: string,
  opts: { connectTimeoutMs?: number } = {},
): ControlClient {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const request = (method: string, path: string, body: string = ""): Promise<ControlResponse> => {
    const { promise, resolve, reject } = Promise.withResolvers<ControlResponse>();
    const socket = connect(socketPath);
    const bodyBuf = Buffer.from(body, "utf8");
    const head =
      `${method} ${path}\r\n` +
      `Content-Length: ${bodyBuf.length}\r\n` +
      `\r\n`;

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`control socket ${method} ${path} timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    socket.once("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    socket.once("connect", () => {
      socket.write(head);
      if (bodyBuf.length) socket.write(bodyBuf);

      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: Buffer | string) => {
        buf += chunk.toString("utf8");
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        const status = parseInt(statusLine.split(" ")[0] ?? "500", 10);
        const headLines = buf.slice(0, headerEnd).split("\r\n").slice(1);
        const headers: Record<string, string> = {};
        for (const line of headLines) {
          const idx = line.indexOf(":");
          if (idx === -1) continue;
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        const contentLength = headers["content-length"] ? parseInt(headers["content-length"], 10) : 0;
        const bodyStart = headerEnd + 4;
        if (buf.length < bodyStart + contentLength) return; // body incomplete

        clearTimeout(timer);
        const respBody = buf.slice(bodyStart, bodyStart + contentLength);
        cleanup();
        resolve({ status, headers, body: respBody });
      });
    });

    return promise;
  };

  return { request };
}
