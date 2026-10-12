import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Runs the installed tg-mcp executable directly, never through a shell.
// Credentials, phone numbers, codes and passwords go to its standard input, never into arguments.

const STATES = ["stopped", "not_logged_in", "connecting", "online", "offline", "action_required"] as const;
const CODE_TYPES = ["app", "sms", "call", "email", "other"] as const;
// Text the bridge shows the user: no control or format characters that could rewrite the screen.
const PLAIN = /^[^\p{Cc}\p{Cf}]*$/u;

export type BridgeStatus = {
  version: string;
  running: boolean;
  state: (typeof STATES)[number];
  connected: boolean;
  configured: boolean;
  logged_in: boolean;
  approver_id: string;
  autostart: boolean;
  api_port: number;
  data_dir: string;
  log_file: string;
};

export type LoginEvent =
  | { event: "qr"; modules: string[]; expires_in: number }
  | { event: "need_phone" | "need_code" }
  | { event: "code_sent"; code_type: (typeof CODE_TYPES)[number]; code_length: number }
  | { event: "need_password"; hint: string; message: string }
  | { event: "notice" | "logged_in"; message: string };

export type LoginAnswer = { phone: string } | { code: string } | { password: string } | { cancel: true };

export type LoginProcess = {
  /** Answers need_phone, need_code or need_password. */
  answer(answer: LoginAnswer): void;
  cancel(): void;
  done: Promise<{ ok: true } | { ok: false; error: string }>;
};

export class BridgeCommandError extends Error {}

/** The bridge prints errors as "Error: <message>"; keep just the message. */
function bridgeMessage(stderr: string): string {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  return line.replace(/^Error:\s*/, "").slice(0, 500) || "tg-mcp failed";
}

export function runBridgeCommand(bridgePath: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bridgePath, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.killed || error.signal) return reject(new BridgeCommandError(`tg-mcp ${args[0]} did not respond`));
      reject(new BridgeCommandError(bridgeMessage(stderr)));
    });
    child.stdin?.end(options.input ?? "");
  });
}

function parseStatus(text: string): BridgeStatus {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BridgeCommandError("tg-mcp returned an unreadable status");
  }
  const valid =
    typeof s === "object" && s !== null &&
    typeof s.version === "string" && typeof s.running === "boolean" && STATES.includes(s.state as BridgeStatus["state"]) &&
    typeof s.connected === "boolean" && typeof s.configured === "boolean" && typeof s.logged_in === "boolean" && typeof s.autostart === "boolean" &&
    typeof s.approver_id === "string" && /^([0-9a-f]{64})?$/.test(s.approver_id) &&
    Number.isInteger(s.api_port) && (s.api_port as number) >= 1024 && (s.api_port as number) <= 65535 &&
    typeof s.data_dir === "string" && typeof s.log_file === "string";
  if (!valid) throw new BridgeCommandError("tg-mcp returned an unexpected status");
  return s as BridgeStatus;
}

export async function bridgeStatus(bridgePath: string): Promise<BridgeStatus> {
  return parseStatus(await runBridgeCommand(bridgePath, ["status", "--json"], { timeoutMs: 15_000 }));
}

/** Trusts this Pi session's public key to approve messages. Returns the bridge's fingerprint of it. */
export async function pairPi(bridgePath: string, publicKeyB64: string): Promise<string> {
  const out = await runBridgeCommand(bridgePath, ["pair-pi"], { input: publicKeyB64 + "\n" });
  try {
    const id = (JSON.parse(out) as { approver_id?: unknown }).approver_id;
    if (typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) return id;
  } catch {
    // reported below
  }
  throw new BridgeCommandError("tg-mcp did not confirm the pairing");
}

/** Stores the user's Telegram API credentials in the bridge's private config. */
export async function setApp(bridgePath: string, credentials: { api_id: number; api_hash: string }): Promise<void> {
  await runBridgeCommand(bridgePath, ["set-app"], { input: JSON.stringify(credentials) + "\n" });
}

const text = (value: unknown, max: number) => (typeof value === "string" && PLAIN.test(value) ? value.slice(0, max) : "");

function parseLoginEvent(line: string): LoginEvent | undefined {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    const modules = e.modules;
    switch (e.event) {
      case "qr":
        if (Array.isArray(modules) && modules.length > 0 && modules.length <= 200 &&
          modules.every((row) => typeof row === "string" && row.length === modules.length && /^[01]+$/.test(row))) {
          return { event: "qr", modules: modules as string[], expires_in: typeof e.expires_in === "number" ? e.expires_in : 0 };
        }
        return undefined;
      case "need_phone":
      case "need_code":
        return { event: e.event };
      case "code_sent":
        if (!CODE_TYPES.includes(e.code_type as (typeof CODE_TYPES)[number])) return undefined;
        return { event: "code_sent", code_type: e.code_type as (typeof CODE_TYPES)[number], code_length: Number.isInteger(e.code_length) ? (e.code_length as number) : 0 };
      case "need_password":
        return { event: "need_password", hint: text(e.hint, 200), message: text(e.message, 300) };
      case "notice":
      case "logged_in":
        return typeof e.message === "string" ? { event: e.event, message: text(e.message, 300) } : undefined;
    }
  } catch {
    // not an event
  }
  return undefined;
}

/** Runs `tg-mcp login --json`, passing each valid event to onEvent. */
export function startLogin(bridgePath: string, method: "qr" | "phone", onEvent: (event: LoginEvent) => void): LoginProcess {
  const child = spawn(bridgePath, ["login", "--json", "--method", method], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
  child.stdin.on("error", () => {}); // the process may exit before reading an answer
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = parseLoginEvent(line);
    if (event) onEvent(event);
  });
  const done = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: bridgeMessage(stderr) }));
  });
  return {
    answer: (answer) => child.stdin.write(JSON.stringify(answer) + "\n"),
    cancel: () => child.kill(),
    done,
  };
}
