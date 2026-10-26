import type { BridgeClient, BridgeRelease } from "./bridge.ts";
import type { SessionSigner } from "./approval.ts";

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
