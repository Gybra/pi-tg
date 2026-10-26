import { Agent, request } from "node:http";
import type { BridgeClient, RuntimeStatus } from "./types/bridge.ts";

// The bridge listens on 127.0.0.1 at its configured port and rejects any other Host header.
export const DEFAULT_API_PORT = 8081;
const JSON_LIMIT = 4 * 1024 * 1024;
const PREVIEW_LIMIT = 16 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const DRAFT_ID = /^[0-9a-f]{32}$/;
export const STATES = ["not_logged_in", "connecting", "online", "offline", "action_required", "stopped"] as const;
// Guidance written by the bridge for the user or model; anything else is dropped.
const DETAIL = /^[^\p{Cc}\p{Cf}]{1,500}$/u;

/**
 * A failed bridge call. `code` is the bridge's fixed error code, or a local one such as "unreachable";
 * `detail` is the bridge's guidance for this refusal, when it gave one.
 */
export class BridgeError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(`Telegram bridge error: ${code}`);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Talks to the bridge's loopback API. Requests are never retried or redirected,
 * and never go through a proxy: a dedicated agent ignores proxy settings.
 */
export function createBridgeClient(token: Uint8Array, options: { port?: number } = {}): BridgeClient {
  if (token.length !== 32) throw new Error("the bridge API token must be 32 bytes");
  const port = options.port ?? DEFAULT_API_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("the bridge API port must be between 1024 and 65535");
  const authorization = `Bearer ${Buffer.from(token).toString("hex")}`;
  const host = `127.0.0.1:${port}`;
  const agent = new Agent({ keepAlive: false });

  function call(method: string, path: string, body: unknown, signal: AbortSignal | undefined, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string | number> = { Host: host, Authorization: authorization };
      if (payload) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": payload.length });
      const req = request({ host: "127.0.0.1", port, method, path, headers, agent, signal, timeout: TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            req.destroy(new BridgeError("bad_response"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const data = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(data);
          else reject(errorFrom(data));
        });
        res.on("error", (error) => reject(toBridgeError(error, signal)));
      });
      req.on("timeout", () => req.destroy(new BridgeError("timeout")));
      req.on("error", (error) => reject(toBridgeError(error, signal)));
      req.end(payload);
    });
  }

  async function callJSON(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const data = await call(method, path, body, signal, JSON_LIMIT);
    if (data.length === 0) return undefined;
    try {
      return JSON.parse(data.toString("utf8"));
    } catch {
      throw new BridgeError("bad_response");
    }
  }

  function draftPath(draftID: string, suffix = ""): string {
    if (!DRAFT_ID.test(draftID)) throw new BridgeError("invalid_request");
    return `/api/drafts/${draftID}${suffix}`;
  }

  return {
    async status(signal) {
      return parseStatus(await callJSON("GET", "/api/status", undefined, signal));
    },
    prepare(input, signal) {
      return callJSON("POST", "/api/drafts", input, signal);
    },
    async cancel(draftID, signal) {
      await callJSON("DELETE", draftPath(draftID), undefined, signal);
    },
    async revoke(signal) {
      await callJSON("DELETE", "/api/approver", undefined, signal);
    },
    async preview(draftID, signal) {
      return call("GET", draftPath(draftID, "/preview"), undefined, signal, PREVIEW_LIMIT);
    },
  };
}

function parseStatus(value: unknown): RuntimeStatus {
  const s = value as Record<string, unknown>;
  const valid =
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(s).sort().join() === "approver_id,connected,state" &&
    STATES.includes(s.state as RuntimeStatus["state"]) &&
    typeof s.connected === "boolean" &&
    typeof s.approver_id === "string" && /^([0-9a-f]{64})?$/.test(s.approver_id);
  if (!valid) throw new BridgeError("bad_response");
  return s as RuntimeStatus;
}

function errorFrom(data: Buffer): BridgeError {
  try {
    const body = JSON.parse(data.toString("utf8")) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && /^[a-z_]{1,32}$/.test(body.error)) {
      return new BridgeError(body.error, typeof body.message === "string" && DETAIL.test(body.message) ? body.message : undefined);
    }
  } catch {
    // fall through
  }
  return new BridgeError("bad_response");
}

function toBridgeError(error: unknown, signal: AbortSignal | undefined): BridgeError {
  if (error instanceof BridgeError) return error;
  return new BridgeError(signal?.aborted ? "aborted" : "unreachable");
}
