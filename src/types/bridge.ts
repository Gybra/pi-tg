import type { CODE_TYPES, STATES as BRIDGE_STATES } from "../bridge-cli.ts";
import type { STATES as RUNTIME_STATES } from "../bridge-client.ts";
import type { SendInput } from "./approval.ts";

export type RuntimeStatus = {
  state: (typeof RUNTIME_STATES)[number];
  connected: boolean;
  approver_id: string;
};

export type BridgeClient = {
  status(signal?: AbortSignal): Promise<RuntimeStatus>;
  /** Returns the bridge's draft as received; callers validate it with decodeDraft. */
  prepare(input: SendInput, signal: AbortSignal): Promise<unknown>;
  cancel(draftID: string, signal?: AbortSignal): Promise<void>;
  revoke(signal?: AbortSignal): Promise<void>;
  preview(draftID: string, signal: AbortSignal): Promise<Uint8Array>;
};

export type BridgeStatus = {
  version: string;
  running: boolean;
  state: (typeof BRIDGE_STATES)[number];
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

export type BridgeRelease = { version: string | null; assets: Record<string, { file: string; sha256: string }> };
