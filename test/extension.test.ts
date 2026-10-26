import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setup } from "../extensions/index.ts";
import { createSessionSigner } from "../src/approval.ts";
import { BridgeError } from "../src/bridge-client.ts";
import type { SessionSigner } from "../src/types/approval.ts";
import type { BridgeClient, BridgeRelease } from "../src/types/bridge.ts";
import type { Deps } from "../src/types/extension.ts";
import { fakeBridge } from "./fake-bridge.ts";
import { textPayload, wireFor } from "./helpers.ts";

const posix = { skip: process.platform === "win32" };
type Handler = (event: unknown, ctx: unknown) => unknown;
type State = { running: boolean; configured: boolean; loggedIn: boolean; autostart: boolean; approver: string; credentials: string };

/** A tg-mcp stand-in that keeps its state in a file and logs every command (never stdin, which may hold secrets). */
function statefulBridge(initial: Partial<State> = {}) {
  const stateFile = join(mkdtempSync(join(tmpdir(), "pi-tg-state-")), "state.json");
  writeFileSync(stateFile, JSON.stringify({ running: false, configured: false, loggedIn: false, autostart: false, approver: "", credentials: "", ...initial }));
  const path = fakeBridge(`
    const fs = require("fs");
    const file = ${JSON.stringify(stateFile)};
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    const save = () => fs.writeFileSync(file, JSON.stringify(st));
    fs.appendFileSync(file + ".log", args.join(" ") + "\\n");
    const say = (e) => console.log(JSON.stringify(e));
    switch (args[0]) {
      case "status":
        say({ version: "0.1.0", running: st.running, state: st.running ? (st.loggedIn ? "online" : "not_logged_in") : "stopped", connected: st.running && st.loggedIn,
          configured: st.configured, logged_in: st.loggedIn, approver_id: st.approver, autostart: st.autostart, api_port: 8081, data_dir: "/data", log_file: "/data/bridge.log" });
        return;
      case "start": st.running = true; save(); return;
      case "stop": st.running = false; save(); return;
      case "autostart": st.autostart = args[1] === "enable"; st.running = st.autostart; save(); return;
      case "set-app":
        process.stdin.on("end", () => { st.credentials = input.trim(); st.configured = true; save(); });
        return;
      case "login":
        if (st.running) { console.error("Error: the bridge is running; stop it first with tg-mcp stop"); process.exit(1); }
        say({ event: "qr", modules: ["0000", "0110", "0110", "0000"], expires_in: 30 });
        st.loggedIn = true; save();
        say({ event: "logged_in", message: "Logged in to Telegram as Test User." });
        process.exit(0);
      case "pair-pi":
        process.stdin.on("end", () => {
          st.approver = require("crypto").createHash("sha256").update(Buffer.from(input.trim(), "base64")).digest("hex");
          save();
          say({ approver_id: st.approver });
        });
        return;
      case "uninstall":
        st.running = false; st.autostart = false;
        if (args.includes("--logout")) st.loggedIn = false;
        if (args.includes("--purge")) { st.configured = false; st.loggedIn = false; }
        save();
        return;
    }
    console.error("Error: unknown command"); process.exit(2);`);
  return {
    path,
    state: () => JSON.parse(readFileSync(stateFile, "utf8")) as State,
    commands: () => (existsSync(stateFile + ".log") ? readFileSync(stateFile + ".log", "utf8").trim().split("\n") : []),
  };
}

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const registered: unknown[] = [];
  const unregistered: string[] = [];
  const pi = {
    registerMcpServer(name: string, config: unknown) {
      registered.push({ name, config });
    },
    unregisterMcpServer(name: string) {
      unregistered.push(name);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => {};
    },
    registerTool() {
      throw new Error("the extension must not register model-callable tools");
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
  };
  return {
    pi,
    registered,
    unregistered,
    command: (name: string, args: string, ctx: unknown) => commands.get(name)!(args, ctx),
    emit: (name: string, event: unknown, ctx: unknown = uiCtx().ctx) => handlers.get(name)?.(event, ctx),
  };
}

function uiCtx(answers: { inputs?: (string | undefined)[]; confirm?: boolean[]; select?: string[] } = {}, mode = "tui") {
  const notes: string[] = [];
  const asked: string[] = [];
  const confirms = [...(answers.confirm ?? [])];
  const selects = [...(answers.select ?? [])];
  const inputs = [...(answers.inputs ?? [])];
  const ctx = {
    mode,
    hasUI: mode !== "print" && mode !== "json",
    cwd: mkdtempSync(join(tmpdir(), "pi-tg-project-")),
    ui: {
      input: async (title: string) => (asked.push(title), inputs.shift()),
      confirm: async (title: string) => (asked.push(title), confirms.shift() ?? false),
      select: async (title: string, options: string[]) => {
        asked.push(title);
        const wanted = selects.shift();
        return options.find((o) => wanted !== undefined && o.startsWith(wanted));
      },
      notify: (message: string) => notes.push(message),
      // The login screen: run the real component until the login process finishes.
      custom: (factory: (...a: unknown[]) => unknown) =>
        new Promise((resolve) => factory({ terminal: { rows: 60 }, requestRender() {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, resolve)),
    },
  };
  return { ctx, notes, asked };
}

function deps(options: { client?: Partial<BridgeClient>; release?: BridgeRelease; fetchImpl?: typeof fetch } = {}) {
  const signers: SessionSigner[] = [];
  let revoked = 0;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-tg-agent-"));
  const value: Deps = {
    agentDir,
    dataDir: () => join(agentDir, "bridge-data"),
    release: options.release ?? { version: null, assets: {} },
    platform: process.platform,
    arch: process.arch,
    fetchImpl: options.fetchImpl,
    createSigner: () => {
      const signer = createSessionSigner();
      signers.push(signer);
      return signer;
    },
    connect: (): BridgeClient => ({
      status: async () => ({ state: "online", connected: true, approver_id: signers[0]?.approverID ?? "" }),
      prepare: async () => {
        throw new BridgeError("unreachable");
      },
      cancel: async () => {},
      revoke: async () => {
        revoked++;
      },
      preview: async () => new Uint8Array(),
      ...options.client,
    }),
  };
  return { deps: value, signers, revoked: () => revoked };
}

const CREDENTIALS = ["12345", "0123456789abcdef0123456789abcdef"];
const configFile = (d: { deps: Deps }) => join(d.deps.agentDir, "pi-tg.json");
const configure = (d: { deps: Deps }, bridgePath: string) => writeFileSync(configFile(d), JSON.stringify({ bridgePath }));
const outgoing = () => ({ type: "tool_call", toolCallId: "1", toolName: "mcp__telegram__send_message", input: { recipient: "user:1000002", message: "hi", approval: { draft_id: "x", signature_b64: "y" } } });
const start = { type: "session_start", reason: "startup" };
const changes = (bridge: ReturnType<typeof statefulBridge>) => bridge.commands().filter((c) => !c.startsWith("status"));

test("registers no tools and blocks sends until set up", async () => {
  const { pi, emit } = fakePi();
  setup(pi as never, deps().deps);
  const event = outgoing();
  const result = (await emit("tool_call", event)) as { block?: boolean; reason?: string };
  assert.equal(result?.block, true);
  assert.equal("approval" in event.input, false);
  await emit("session_start", start);
  assert.match(((await emit("tool_call", outgoing())) as { reason: string }).reason, /\/telegram-setup.*Nothing was sent/);
});

test("/telegram-setup guides a new user through credentials, login and autostart", posix, async () => {
  const bridge = statefulBridge();
  const { pi, registered, command } = fakePi();
  const d = deps();
  setup(pi as never, d.deps);
  const settings = join(d.deps.agentDir, "settings.json");
  writeFileSync(settings, '{"packages":[]}');
  const { ctx, notes, asked } = uiCtx({ confirm: [true, true, true, true], inputs: CREDENTIALS, select: ["Scan a QR code", "Start automatically"] });
  await command("telegram-setup", bridge.path, ctx);
  assert.deepEqual(bridge.state(), {
    running: true, configured: true, loggedIn: true, autostart: true, approver: "",
    credentials: '{"api_id":12345,"api_hash":"0123456789abcdef0123456789abcdef"}',
  });
  assert.deepEqual(changes(bridge), ["set-app", "login --json --method qr", "autostart enable"], "credentials travel on stdin, never in arguments");
  assert.ok(asked.some((q) => /API terms/.test(q)) && asked.some((q) => /API credentials/.test(q)) && asked.some((q) => /Log this computer in/.test(q)));
  assert.deepEqual(registered, [{ name: "telegram", config: { command: bridge.path, args: ["mcp"], timeout: 180, exposure: "codemode" } }]);
  assert.deepEqual(JSON.parse(readFileSync(configFile(d), "utf8")), { bridgePath: bridge.path });
  assert.equal(readFileSync(settings, "utf8"), '{"packages":[]}', "Pi settings are not modified");
  assert.match(notes.join("\n"), /ready/i);
});

test("/telegram-setup skips what is done and stops a bridge without a session before logging in", posix, async () => {
  const notLoggedIn = statefulBridge({ running: true, configured: true });
  const one = fakePi();
  setup(one.pi as never, deps().deps);
  await one.command("telegram-setup", notLoggedIn.path, uiCtx({ confirm: [true, true], select: ["Use my phone number", "Start it now"] }).ctx);
  assert.deepEqual(changes(notLoggedIn), ["stop", "login --json --method phone", "start"]);

  const ready = statefulBridge({ running: true, configured: true, loggedIn: true, autostart: true });
  const two = fakePi();
  setup(two.pi as never, deps().deps);
  const { ctx, asked } = uiCtx({ confirm: [true] });
  await two.command("telegram-setup", ready.path, ctx);
  assert.deepEqual(changes(ready), [], "nothing to do for a running, logged-in bridge");
  assert.ok(!asked.some((q) => /credentials|Log this computer/.test(q)), "no step offered twice");
});

test("/telegram-setup changes nothing when the user declines or the path is unusable", posix, async () => {
  const bridge = statefulBridge();
  for (const [args, answers] of [
    [bridge.path, { confirm: [false] }],
    [bridge.path, { confirm: [true, false] }], // accepts the bridge, declines Telegram's API terms
    [bridge.path, { confirm: [true, true, false] }], // accepts the terms, declines the credentials guide
    [bridge.path, { confirm: [true, true, true], inputs: ["12345", undefined] }], // cancels at the api_hash
    ["relative/tg-mcp", { confirm: [true] }],
    ["", { select: ["Use an existing"], inputs: [undefined] }],
  ] as const) {
    const { pi, registered, command } = fakePi();
    const d = deps();
    setup(pi as never, d.deps);
    await command("telegram-setup", args, uiCtx(answers as never).ctx);
    if ((answers as unknown as { confirm?: boolean[] }).confirm?.[0] !== true) {
      assert.equal(registered.length, 0, JSON.stringify(args));
      assert.equal(existsSync(configFile(d)), false);
    }
  }
  assert.deepEqual(changes(bridge), []);
});

test("/telegram-setup downloads a verified bridge when a release is available", posix, async () => {
  const bridge = statefulBridge({ running: true, configured: true, loggedIn: true });
  const binary = readFileSync(bridge.path);
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as "darwin"];
  const cpu = { arm64: "arm64", x64: "amd64" }[process.arch as "arm64"];
  const release: BridgeRelease = { version: "9.9.9", assets: { [`${os}-${cpu}`]: { file: `tg-mcp-${os}-${cpu}`, sha256: createHash("sha256").update(binary).digest("hex") } } };
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => (urls.push(url), new Response(binary))) as unknown as typeof fetch;
  const { pi, registered, command } = fakePi();
  const d = deps({ release, fetchImpl });
  setup(pi as never, d.deps);
  await command("telegram-setup", "", uiCtx({ select: ["Download"], confirm: [] }).ctx);
  const installed = join(d.deps.agentDir, "pi-tg-bridge", "9.9.9", "tg-mcp");
  assert.deepEqual(urls, [`https://github.com/Gybra/tg-mcp/releases/download/v9.9.9/tg-mcp-${os}-${cpu}`]);
  assert.deepEqual(registered, [{ name: "telegram", config: { command: installed, args: ["mcp"], timeout: 180, exposure: "codemode" } }]);
});

test("a configured bridge is registered at session start unless mcp.json already defines telegram", async () => {
  for (const conflict of [false, true]) {
    const { pi, registered, emit } = fakePi();
    const d = deps();
    configure(d, process.execPath);
    const mcpFile = join(d.deps.agentDir, "mcp.json");
    const mcpContent = JSON.stringify({ mcpServers: { telegram: { command: "/usr/bin/other-telegram", args: ["serve"] } } });
    if (conflict) writeFileSync(mcpFile, mcpContent);
    setup(pi as never, d.deps);
    const { ctx, notes } = uiCtx();
    await emit("session_start", start, ctx);
    assert.equal(registered.length, conflict ? 0 : 1);
    if (conflict) {
      assert.match(notes.join("\n"), /already defines a "telegram" server/);
      assert.equal(readFileSync(mcpFile, "utf8"), mcpContent);
    }
  }
});

test("/telegram-pair trusts this session's key after confirmation", posix, async () => {
  const bridge = statefulBridge({ running: true, configured: true, loggedIn: true });
  const { pi, emit, command } = fakePi();
  const d = deps();
  configure(d, bridge.path);
  setup(pi as never, d.deps);
  await emit("session_start", start);
  await command("telegram-pair", "", uiCtx({ confirm: [false] }).ctx);
  assert.equal(bridge.state().approver, "", "declined");
  const { ctx, notes } = uiCtx({ confirm: [true] });
  await command("telegram-pair", "", ctx);
  assert.equal(bridge.state().approver, d.signers[0].approverID);
  assert.match(notes.join("\n"), /can now approve/);
});

test("the first send asks once to pair the session, then reviews the message", posix, async () => {
  const bridge = statefulBridge({ running: true, configured: true, loggedIn: true });
  let signer: SessionSigner | undefined;
  const d = deps({
    client: {
      prepare: async () => {
        if (bridge.state().approver !== signer!.approverID) throw new BridgeError("not_paired");
        return wireFor(textPayload({ expires_at: Math.floor(Date.now() / 1000) + 120 }), signer!.publicKeyB64);
      },
    },
  });
  configure(d, bridge.path);
  const { pi, emit } = fakePi();
  setup(pi as never, d.deps);
  await emit("session_start", start);
  signer = d.signers[0];
  const { ctx, asked } = uiCtx({ confirm: [true] });
  (ctx.ui as Record<string, unknown>).custom = async () => false; // the user cancels the review
  const result = (await emit("tool_call", outgoing(), ctx)) as { block?: boolean; reason?: string };
  assert.ok(asked.some((q) => /approve Telegram messages/.test(q)), "pairing consent asked");
  assert.equal(bridge.state().approver, signer.approverID);
  assert.match(result.reason ?? "", /declined/, "the message itself still went through review");
});

test("keeps the session key across new sessions and revokes it on quit or reload", async () => {
  for (const reason of ["quit", "reload"]) {
    const { pi, emit } = fakePi();
    const fake = deps();
    configure(fake, process.execPath);
    setup(pi as never, fake.deps);
    await emit("session_start", start);
    await emit("session_shutdown", { type: "session_shutdown", reason: "new" });
    await emit("session_start", { type: "session_start", reason: "new" });
    assert.equal(fake.signers.length, 1, "a new session in the same Pi process keeps the pairing");
    assert.equal(fake.revoked(), 0);
    await emit("session_shutdown", { type: "session_shutdown", reason });
    assert.equal(fake.revoked(), 1, reason);
    assert.throws(() => fake.signers[0].sign(new Uint8Array(1)), /disposed/, `${reason} destroys the key`);
  }
});

test("does not revoke an approver paired by another Pi session", async () => {
  const { pi, emit } = fakePi();
  const fake = deps({ client: { status: async () => ({ state: "online", connected: true, approver_id: "0".repeat(64) }) } });
  configure(fake, process.execPath);
  setup(pi as never, fake.deps);
  await emit("session_start", start);
  await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(fake.revoked(), 0);
});

test("blocks the model from the bridge's session, credentials and login, even before a session starts", async () => {
  const { pi, emit } = fakePi();
  const d = deps();
  setup(pi as never, d.deps);
  for (const [tool, input] of [
    ["read", { path: join(d.deps.dataDir(), "session.json") }],
    ["bash", { command: "echo KEY | tg-mcp pair-pi" }],
    ["bash", { command: "tg-mcp login --json" }],
  ] as const) {
    assert.equal(((await emit("tool_call", { type: "tool_call", toolCallId: "1", toolName: tool, input })) as { block?: boolean })?.block, true, JSON.stringify(input));
  }
  assert.equal(await emit("tool_call", { type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "ls" } }), undefined);
});

test("commands refuse outside the interactive TUI", async () => {
  const { pi, command, emit } = fakePi();
  setup(pi as never, deps().deps);
  await emit("session_start", start);
  for (const name of ["telegram-pair", "telegram-setup", "telegram-uninstall"]) {
    const { ctx, notes } = uiCtx({}, "rpc");
    await command(name, "", ctx);
    assert.match(notes.join("\n"), /interactive/, name);
  }
});

test("/telegram-status reports the bridge, the account and this session's pairing", posix, async () => {
  const bridge = statefulBridge({ running: true, configured: true, loggedIn: true, autostart: true });
  const { pi, command, emit } = fakePi();
  const d = deps();
  configure(d, bridge.path);
  setup(pi as never, d.deps);
  await emit("session_start", start);
  const { ctx, notes } = uiCtx();
  await command("telegram-status", "", ctx);
  assert.match(notes.join("\n"), /online.*logged in.*autostart on.*not paired/s);
});

test("/telegram-uninstall keeps data by default and asks separately to log out and to delete", posix, async () => {
  const keep = statefulBridge({ running: true, configured: true, loggedIn: true, autostart: true });
  const one = fakePi();
  const d1 = deps();
  configure(d1, keep.path);
  setup(one.pi as never, d1.deps);
  await one.emit("session_start", start);
  const { ctx, asked, notes } = uiCtx({ confirm: [true, false, false] });
  await one.command("telegram-uninstall", "", ctx);
  assert.deepEqual(changes(keep), ["uninstall --yes"]);
  assert.ok(asked.some((q) => /log this computer out/i.test(q)) && asked.some((q) => /delete/i.test(q)));
  assert.equal(existsSync(configFile(d1)), false, "the extension's config is removed");
  assert.deepEqual(one.unregistered, ["telegram"]);
  assert.match(notes.join("\n"), /Settings › Devices/);

  const purge = statefulBridge({ running: true, configured: true, loggedIn: true });
  const two = fakePi();
  const d2 = deps();
  configure(d2, purge.path);
  setup(two.pi as never, d2.deps);
  await two.command("telegram-uninstall", "", uiCtx({ confirm: [true, true, true, true] }).ctx);
  assert.deepEqual(changes(purge), ["uninstall --logout --purge --yes"]);

  const halfway = statefulBridge({ running: true, configured: true, loggedIn: true });
  const three = fakePi();
  const d3 = deps();
  configure(d3, halfway.path);
  setup(three.pi as never, d3.deps);
  await three.command("telegram-uninstall", "", uiCtx({ confirm: [true, false, true, false] }).ctx);
  assert.deepEqual(changes(halfway), ["uninstall --yes"], "deleting data needs a second confirmation");

  const declined = statefulBridge({ running: true, configured: true, loggedIn: true });
  const four = fakePi();
  const d4 = deps();
  configure(d4, declined.path);
  setup(four.pi as never, d4.deps);
  await four.command("telegram-uninstall", "", uiCtx({ confirm: [false] }).ctx);
  assert.deepEqual(changes(declined), []);
  assert.equal(existsSync(configFile(d4)), true);
});

test("/telegram-uninstall removes a bridge the extension downloaded, never one the user provided", posix, async () => {
  const bridge = statefulBridge({ running: true, configured: true, loggedIn: true });
  const { pi, command } = fakePi();
  const d = deps();
  const installed = join(d.deps.agentDir, "pi-tg-bridge", "1.0.0", "tg-mcp");
  mkdirSync(join(d.deps.agentDir, "pi-tg-bridge", "1.0.0"), { recursive: true });
  writeFileSync(installed, readFileSync(bridge.path), { mode: 0o755 });
  configure(d, installed);
  setup(pi as never, d.deps);
  await command("telegram-uninstall", "", uiCtx({ confirm: [true, false, false] }).ctx);
  assert.equal(existsSync(join(d.deps.agentDir, "pi-tg-bridge")), false);
  assert.equal(existsSync(bridge.path), true);
});
