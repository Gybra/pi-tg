import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createApprovalController, createSessionSigner, destroySessionSigner, isOutgoingTelegramCall, type ApprovalController } from "../src/approval.ts";
import { bridgeStatus, pairPi, runBridgeCommand, setApp, startLogin, type BridgeStatus } from "../src/bridge-cli.ts";
import { createBridgeClient, type BridgeClient } from "../src/bridge-client.ts";
import { bridgeDataDir, checkBridgeExecutable, configPath, findConfiguredServer, isSameBridge, loadBridgeToken, loadConfig, saveConfig } from "../src/config.ts";
import { protectedToolCall } from "../src/guard.ts";
import { assetFor, installBridge, type BridgeRelease } from "../src/install.ts";
import { runLoginScreen } from "../src/login-view.ts";
import type { SessionSigner } from "../src/protocol.ts";
import { reviewDraft } from "../src/review.ts";
import { askCredentials } from "../src/wizard.ts";

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

const defaultDeps = (): Deps => ({
  agentDir: getAgentDir(),
  dataDir: () => {
    try {
      return bridgeDataDir();
    } catch {
      return "";
    }
  },
  release: JSON.parse(readFileSync(new URL("../bridge-release.json", import.meta.url), "utf8")) as BridgeRelease,
  platform: process.platform,
  arch: process.arch,
  createSigner: () => createSessionSigner(),
  connect: async (bridgePath) => createBridgeClient(await loadBridgeToken(), { port: (await bridgeStatus(bridgePath)).api_port }),
});

export default function (pi: ExtensionAPI): void {
  setup(pi, defaultDeps());
}

const interactive = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;
const NOT_SET_UP = "Telegram is not set up in Pi yet: the user can run /telegram-setup. Nothing was sent.";

function describe(s: BridgeStatus, pairing: string): string {
  const bridge = s.running ? s.state.replaceAll("_", " ") : "not running";
  const account = s.logged_in ? "logged in" : s.configured ? "not logged in" : "not set up";
  return `Telegram bridge: ${bridge} · ${account} · autostart ${s.autostart ? "on" : "off"} · ${pairing}`;
}

export function setup(pi: ExtensionAPI, deps: Deps): void {
  // One approval key per Pi process: it survives /new and /resume, and is
  // destroyed (and its bridge trust revoked) when Pi quits or reloads.
  let signer: SessionSigner | undefined;
  let client: BridgeClient | undefined;
  let controller: ApprovalController | undefined;
  let registeredBridge: string | undefined;
  const installDir = join(deps.agentDir, "pi-tg-bridge");
  const guardPaths = { dataDir: deps.dataDir(), installDir, configFile: configPath(deps.agentDir) };

  const bridgePath = async () => (await loadConfig(configPath(deps.agentDir)).catch(() => null))?.bridgePath;

  async function getClient(path: string): Promise<BridgeClient> {
    client ??= await deps.connect(path);
    return client;
  }

  /** Asks once per Pi process before trusting this session to approve messages. */
  async function ensurePaired(ctx: ExtensionContext): Promise<boolean> {
    const path = await bridgePath();
    if (!signer || !path || !interactive(ctx)) return false;
    const ok = await ctx.ui.confirm(
      "Allow this Pi session to approve Telegram messages?",
      "Pi asks this once per session. You will still see and approve every message before it is sent.",
    );
    return ok && (await pairPi(path, signer.publicKeyB64)) === signer.approverID;
  }

  async function getController(): Promise<ApprovalController | undefined> {
    const path = await bridgePath();
    if (!signer || !path) return undefined;
    try {
      controller ??= createApprovalController(await getClient(path), signer, reviewDraft, undefined, ensurePaired);
    } catch {
      return undefined;
    }
    return controller;
  }

  /** Registers the bridge for this Pi runtime only, unless Pi's own MCP files already define "telegram". */
  async function registerBridge(ctx: ExtensionContext, path: string): Promise<void> {
    if (registeredBridge === path) return;
    const existing = await findConfiguredServer(deps.agentDir, ctx.cwd);
    if (existing) {
      if (!isSameBridge(existing, path)) {
        ctx.ui.notify(`${existing.source} already defines a "telegram" server, which Pi uses instead of ${path}. It was left unchanged.`, "warning");
      }
      return;
    }
    pi.registerMcpServer("telegram", { command: path, args: ["mcp"], timeout: 180, exposure: "codemode" });
    registeredBridge = path;
  }

  pi.on("session_start", async (_event, ctx) => {
    signer ??= deps.createSigner();
    try {
      const config = await loadConfig(configPath(deps.agentDir));
      if (config) await registerBridge(ctx, config.bridgePath);
    } catch (error) {
      ctx.ui.notify((error as Error).message, "warning");
    }
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    const blocked = protectedToolCall(event as { toolName: string; input: Record<string, unknown> }, guardPaths);
    if (blocked) return { block: true, reason: blocked };
    if (!isOutgoingTelegramCall(event)) return undefined;
    const ready = await getController();
    if (!ready) {
      delete (event.input as Record<string, unknown>).approval;
      return { block: true, reason: NOT_SET_UP };
    }
    return ready.handle(event, ctx);
  });

  pi.on("session_shutdown", async (event) => {
    await controller?.cancelAll();
    if (event.reason !== "quit" && event.reason !== "reload") return;
    const current = signer;
    signer = undefined;
    controller = undefined;
    if (!current) return;
    try {
      const path = await bridgePath();
      if (!path) return;
      const bridge = await getClient(path);
      const status = await bridge.status(AbortSignal.timeout(2000));
      if (status.approver_id === current.approverID) await bridge.revoke(AbortSignal.timeout(2000));
    } catch {
      // The bridge may be down; its stale public key is useless without this process's private key.
    } finally {
      destroySessionSigner(current);
    }
  });

  /** Finds the bridge executable: the one given, the configured one, or a verified download. */
  async function chooseBridge(ctx: ExtensionContext, given: string): Promise<string | undefined> {
    if (given) {
      const problem = await checkBridgeExecutable(given);
      if (problem) return void ctx.ui.notify(`Not a usable bridge: ${problem}.`, "error");
      const ok = await ctx.ui.confirm("Use this Telegram bridge?", `${given}\n\nPi will run "${given} mcp" for its sessions. Pi's settings and mcp.json are not changed.`);
      return ok ? given : undefined;
    }
    const configured = await bridgePath();
    if (configured && !(await checkBridgeExecutable(configured))) return configured;
    const asset = assetFor(deps.release, deps.platform, deps.arch);
    const download = `Download and install tg-mcp v${deps.release.version} (checksum verified)`;
    const existing = "Use an existing tg-mcp executable";
    const choice = await ctx.ui.select(
      "Pi talks to Telegram through a small helper program, the tg-mcp bridge. Which one should it use?",
      asset ? [download, existing] : [existing],
    );
    if (choice === download) {
      ctx.ui.notify(`Downloading tg-mcp v${deps.release.version}…`, "info");
      return installBridge({ installDir, release: deps.release, platform: deps.platform, arch: deps.arch, fetchImpl: deps.fetchImpl });
    }
    if (choice !== existing) return undefined;
    const path = (await ctx.ui.input("Absolute path to the tg-mcp executable", "/usr/local/bin/tg-mcp"))?.trim();
    if (!path) return undefined;
    const problem = await checkBridgeExecutable(path);
    if (problem) return void ctx.ui.notify(`Not a usable bridge: ${problem}.`, "error");
    return path;
  }

  /** Logs this computer in, asking first; returns false when the user stops. */
  async function logIn(ctx: ExtensionContext, path: string, status: BridgeStatus): Promise<boolean> {
    const ok = await ctx.ui.confirm(
      "Log this computer in to your Telegram account?",
      "It will appear in your Telegram apps under Settings › Devices as tg-mcp, and you can end it there at any time. Nobody is added to your chats and nothing is sent without your approval.",
    );
    if (!ok) {
      ctx.ui.notify("Not logged in yet. Run /telegram-setup again when you are ready.", "info");
      return false;
    }
    if (status.running) await runBridgeCommand(path, ["stop"]); // a bridge without a session holds the API port
    const qr = "Scan a QR code with Telegram on my phone (recommended)";
    const phone = "Use my phone number and a login code";
    const choice = await ctx.ui.select("How do you want to log in?", [qr, phone]);
    if (!choice) return false;
    if (!(await runLoginScreen(ctx, (onEvent) => startLogin(path, choice === phone ? "phone" : "qr", onEvent)))) {
      ctx.ui.notify("Telegram was not logged in. Run /telegram-setup again to retry.", "warning");
      return false;
    }
    return true;
  }

  pi.registerCommand("telegram-setup", {
    description: "Set up Telegram for Pi step by step: install the bridge, create API credentials, log in and start it",
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return ctx.ui.notify("Telegram setup needs Pi's interactive terminal.", "error");
      try {
        const path = await chooseBridge(ctx, args.trim());
        if (!path) return;
        await saveConfig(configPath(deps.agentDir), { bridgePath: path });
        await registerBridge(ctx, path);
        let status = await bridgeStatus(path);
        if (!status.configured) {
          const credentials = await askCredentials(ctx);
          if (!credentials) return ctx.ui.notify("Telegram is not set up yet: it needs your API credentials. Run /telegram-setup again when you have them.", "info");
          await setApp(path, credentials);
          status = await bridgeStatus(path);
        }
        if (!status.logged_in) {
          if (!(await logIn(ctx, path, status))) return;
          status = await bridgeStatus(path);
        }
        if (!status.running && !status.autostart) {
          const always = "Start automatically when I log in (recommended)";
          const now = "Start it now, until I log out";
          const choice = await ctx.ui.select("The bridge keeps Telegram connected in the background. When should it run?", [always, now, "Don't start it now"]);
          if (choice === always) await runBridgeCommand(path, ["autostart", "enable"]);
          else if (choice === now) await runBridgeCommand(path, ["start"]);
        } else if (!status.running) {
          await runBridgeCommand(path, ["start"]);
        }
        client = controller = undefined; // reconnect with the bridge's current address
        ctx.ui.notify(
          "Telegram is ready. Ask Pi about your chats. Before the first message it sends, Pi asks once to approve messages from this session; every message is shown to you before it is sent.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Telegram setup failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("telegram-pair", {
    description: "Let this Pi session approve outgoing Telegram messages",
    handler: async (_args, ctx) => {
      if (!interactive(ctx)) return ctx.ui.notify("Pairing needs Pi's interactive terminal.", "error");
      if (!(await bridgePath())) return ctx.ui.notify("Run /telegram-setup first.", "error");
      try {
        const paired = await ensurePaired(ctx);
        ctx.ui.notify(paired ? "This Pi session can now approve Telegram messages." : "Not paired.", paired ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Pairing failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("telegram-status", {
    description: "Show the Telegram bridge, login and pairing status",
    handler: async (_args, ctx) => {
      const path = await bridgePath();
      if (!path) return ctx.ui.notify("Telegram is not set up: run /telegram-setup.", "info");
      try {
        const s = await bridgeStatus(path);
        const pairing = signer && s.approver_id === signer.approverID ? "this session can approve messages" : s.approver_id ? "paired with another Pi session" : "not paired (Pi asks before the first message)";
        ctx.ui.notify(describe(s, pairing), "info");
      } catch (error) {
        ctx.ui.notify(`Telegram bridge status unavailable: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("telegram-uninstall", {
    description: "Remove the Telegram bridge from this computer; optionally log out and delete its data",
    handler: async (_args, ctx) => {
      if (!interactive(ctx)) return ctx.ui.notify("Uninstalling needs Pi's interactive terminal.", "error");
      const path = await bridgePath();
      if (!path) return ctx.ui.notify("Telegram is not set up in Pi: there is nothing to uninstall.", "info");
      const dataDir = deps.dataDir() || "the bridge's data directory";
      const go = await ctx.ui.confirm(
        "Uninstall the Telegram bridge?",
        "The bridge stops, no longer starts at login, and Pi stops offering the Telegram tools. Your Telegram data on this computer is kept unless you choose to delete it next.",
      );
      if (!go) return;
      const logout = await ctx.ui.confirm(
        "Also log this computer out of Telegram?",
        "This ends the tg-mcp session on Telegram's side. If you skip it, the session stays listed in your Telegram apps under Settings › Devices, where you can end it later.",
      );
      let purge = await ctx.ui.confirm(
        "Also delete all Telegram data on this computer?",
        `This deletes ${dataDir}: the session, your API credentials, cached messages and downloaded files.`,
      );
      if (purge) purge = await ctx.ui.confirm("Delete the Telegram data now?", "This cannot be undone.");
      try {
        await controller?.cancelAll();
        const flags = [...(logout ? ["--logout"] : []), ...(purge ? ["--purge"] : []), "--yes"];
        await runBridgeCommand(path, ["uninstall", ...flags], { timeoutMs: 120_000 });
        if (registeredBridge) {
          pi.unregisterMcpServer("telegram");
          registeredBridge = undefined;
        }
        client = controller = undefined;
        await rm(configPath(deps.agentDir), { force: true });
        if (path.startsWith(installDir + sep)) await rm(installDir, { recursive: true, force: true }); // downloaded by this extension
        ctx.ui.notify(
          [
            "The Telegram bridge is uninstalled: it is stopped and no longer starts at login.",
            purge ? "The Telegram data on this computer was deleted." : `Your Telegram data is kept in ${dataDir}.`,
            logout ? "This computer is logged out of Telegram." : "This computer is still listed in your Telegram apps under Settings › Devices: end the session there if you no longer need it.",
          ].join(" "),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`Uninstall failed: ${(error as Error).message}`, "error");
      }
    },
  });
}
