import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { CODE_TYPES, STATES as BRIDGE_STATES } from "./bridge-cli.ts";
import type { STATES as RUNTIME_STATES } from "./bridge-client.ts";
import type { KINDS, PEER_KINDS } from "./protocol.ts";

export type SendKind = (typeof KINDS)[number];

export type PeerKind = (typeof PEER_KINDS)[number];

export type SendInput = { kind: SendKind; recipient: string; message: string; media_id: string };

export type AttachmentView = { id: string; name: string; mime: string; size: number; sha256: string };

export type ApprovalPayload = {
  version: 1;
  draft_id: string;
  account_id: string;
  peer_id: string;
  peer_kind: PeerKind;
  peer_name: string;
  peer_username: string;
  message: string;
  kind: SendKind;
  attachment: AttachmentView | null;
  expires_at: number;
};

export type DraftView = { draft_id: string; payload_b64: string; challenge_b64: string; approver_id: string; expires_at: number };

export type ApprovalProof = { draft_id: string; signature_b64: string };

export type SessionSigner = {
  readonly publicKeyB64: string;
  readonly approverID: string;
  sign(challenge: Uint8Array): string;
  dispose(): void;
};

export type ReviewedDraft = { wire: DraftView; payload: ApprovalPayload; payloadBytes: Uint8Array; challengeBytes: Uint8Array };

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

export type ApprovalController = {
  handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined>;
  cancelAll(): Promise<void>;
};

export type Deps = {
  agentDir: string;
  dataDir(): string;
  release: BridgeRelease;
  platform: NodeJS.Platform;
  arch: string;
  fetchImpl?: typeof fetch;
  createSigner(): SessionSigner;
  connect(bridgePath: string): BridgeClient | Promise<BridgeClient>;
};

