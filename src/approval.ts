import { createHash, createPublicKey, generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { BridgeError, type BridgeClient } from "./bridge-client.ts";
import { decodeDraft, type ApprovalProof, type ReviewedDraft, type SendInput, type SessionSigner } from "./protocol.ts";

/**
 * Holds this Pi session's approval key. The private key lives only in this closure:
 * it is never persisted, exported or reachable from the returned object.
 */
export function createSessionSigner(privateKey: KeyObject = generateKeyPairSync("ed25519").privateKey): SessionSigner {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("approval key must be Ed25519");
  let key: KeyObject | undefined = privateKey;
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x as string, "base64url");
  return {
    publicKeyB64: raw.toString("base64"),
    approverID: createHash("sha256").update(raw).digest("hex"),
    sign(challenge: Uint8Array): string {
      if (!key) throw new Error("approval signer disposed");
      return ed25519Sign(null, challenge, key).toString("base64");
    },
    dispose(): void {
      key = undefined;
    },
  };
}

export function destroySessionSigner(signer: SessionSigner): void {
  signer.dispose();
}

/** Signs a reviewed draft. Only call after the user approved this exact draft. */
export function createProof(draft: ReviewedDraft, signer: SessionSigner, nowSeconds: number): ApprovalProof {
  if (nowSeconds >= draft.payload.expires_at) throw new Error("draft expired");
  if (draft.wire.approver_id !== signer.approverID) throw new Error("draft belongs to another approver");
  return { draft_id: draft.payload.draft_id, signature_b64: signer.sign(draft.challengeBytes) };
}

const OUTGOING_TOOLS = {
  mcp__telegram__send_message: "text",
  mcp__telegram__send_file: "file",
  mcp__telegram__send_audio_message: "voice",
} as const;

export function isOutgoingTelegramCall(event: { toolName: string }): boolean {
  return Object.hasOwn(OUTGOING_TOOLS, event.toolName);
}

/** Maps an outgoing tool call to the bridge's send input; undefined for anything unexpected. */
export function toSendInput(toolName: string, input: Record<string, unknown>): SendInput | undefined {
  const kind = OUTGOING_TOOLS[toolName as keyof typeof OUTGOING_TOOLS];
  const { approval: _ignored, ...args } = input;
  const keys = Object.keys(args).sort().join();
  if (kind === "text" && keys === "message,recipient" && typeof args.recipient === "string" && typeof args.message === "string") {
    return { kind, recipient: args.recipient, message: args.message, media_id: "" };
  }
  if ((kind === "file" || kind === "voice") && keys === "media_id,recipient" && typeof args.recipient === "string" && typeof args.media_id === "string") {
    return { kind, recipient: args.recipient, message: "", media_id: args.media_id };
  }
  return undefined;
}

export type Review = (ctx: ExtensionContext, draft: ReviewedDraft, signal: AbortSignal, preview?: Uint8Array) => Promise<boolean>;

export type ApprovalController = {
  handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined>;
  cancelAll(): Promise<void>;
};

const NOT_SENT = "Nothing was sent.";

function block(reason: string): ToolCallEventResult {
  return { block: true, reason };
}

function bridgeFailure(error: unknown): string {
  const code = error instanceof BridgeError ? error.code : "";
  if (error instanceof BridgeError && error.detail) return `${error.detail} ${NOT_SENT}`;
  switch (code) {
    case "not_paired":
      return `This Pi session is not paired with the Telegram bridge, so it cannot approve messages; the user can run /telegram-pair. ${NOT_SENT}`;
    case "unreachable":
    case "offline":
    case "timeout":
      return `The Telegram bridge is not reachable or not connected. ${NOT_SENT}`;
    case "invalid_request":
      return `The Telegram bridge rejected this message (unsupported recipient or content). ${NOT_SENT}`;
    case "not_found":
      return `The bridge does not know this recipient; find its chat_id with list_chats or search_contacts first. ${NOT_SENT}`;
    case "rate_limited":
      return `Telegram is limiting this account; wait before sending again. ${NOT_SENT}`;
    case "media_not_found":
      return `That file is not in the bridge's outbox; the user must copy it there first. ${NOT_SENT}`;
    case "unsupported_media":
      return `The bridge does not support this file type for this kind of message. ${NOT_SENT}`;
    case "secret_rejected":
      return `The bridge refused this content because it looks like a credential or private key. ${NOT_SENT}`;
    case "busy":
      return `Too many Telegram messages are waiting for approval. ${NOT_SENT}`;
    default:
      return error instanceof Error && error.message === "draft expired"
        ? `The approval expired before it was confirmed. ${NOT_SENT}`
        : `The Telegram approval failed${code ? ` (${code})` : ""}. ${NOT_SENT}`;
  }
}

/**
 * Gates the three outgoing Telegram tools: each call gets its own bridge draft,
 * a full review by the user and, only after approval, a single-use signed proof.
 * The bridge verifies the proof; this hook only collects the user's decision.
 */
export function createApprovalController(
  client: BridgeClient,
  signer: SessionSigner,
  review: Review,
  now: () => number = () => Math.floor(Date.now() / 1000),
  ensurePaired?: (ctx: ExtensionContext) => Promise<boolean>,
): ApprovalController {
  let active: AbortController | undefined;

  // The bridge only drafts for a paired session: pair once, with the user's consent, then retry.
  async function prepare(input: SendInput, signal: AbortSignal, ctx: ExtensionContext): Promise<unknown> {
    try {
      return await client.prepare(input, signal);
    } catch (error) {
      if (!(error instanceof BridgeError && error.code === "not_paired") || !ensurePaired || !(await ensurePaired(ctx))) throw error;
      return client.prepare(input, signal);
    }
  }

  async function cancelDraft(draftID: string | undefined): Promise<void> {
    if (draftID) await client.cancel(draftID, AbortSignal.timeout(5000)).catch(() => {});
  }

  return {
    async handle(event, ctx) {
      if (!isOutgoingTelegramCall(event)) return undefined;
      const input = event.input as Record<string, unknown>;
      delete input.approval; // only a proof created below after review is ever accepted
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        return block(`Telegram messages can only be approved in Pi's interactive terminal. ${NOT_SENT}`);
      }
      const sendInput = toSendInput(event.toolName, input);
      if (!sendInput) return block(`Unsupported arguments for this Telegram tool. ${NOT_SENT}`);
      if (active) return block(`Another Telegram message is waiting for approval; send one message at a time. ${NOT_SENT}`);

      const cancel = new AbortController();
      active = cancel;
      const turn = AbortSignal.any(ctx.signal ? [cancel.signal, ctx.signal] : [cancel.signal]);
      let draftID: string | undefined;
      try {
        const draft = decodeDraft(await prepare(sendInput, turn, ctx), signer, now());
        draftID = draft.payload.draft_id;
        const signal = AbortSignal.any([turn, AbortSignal.timeout((draft.payload.expires_at - now()) * 1000)]);
        const preview = draft.payload.attachment ? await client.preview(draftID, signal) : undefined;
        const approved = await review(ctx, draft, signal, preview);
        if (!approved || signal.aborted) {
          await cancelDraft(draftID);
          return block(`The user declined this Telegram message in the approval dialog, so it was not sent. ${NOT_SENT} Do not retry unless the user asks.`);
        }
        input.approval = createProof(draft, signer, now());
        return undefined;
      } catch (error) {
        await cancelDraft(draftID);
        return block(bridgeFailure(error));
      } finally {
        active = undefined;
      }
    },
    async cancelAll() {
      active?.abort();
    },
  };
}
