import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { bridgeStatus, BridgeCommandError, pairPi, runBridgeCommand, setApp, startLogin, type LoginEvent } from "../src/bridge-cli.ts";
import { fakeBridge, STATUS } from "./fake-bridge.ts";

const posix = { skip: process.platform === "win32" };

test("runs the bridge without a shell and returns stdout", posix, async () => {
  const bridge = fakeBridge(`console.log(JSON.stringify(args))`);
  assert.equal(await runBridgeCommand(bridge, ["status", "--json; rm -rf ~"]), '["status","--json; rm -rf ~"]\n');
});

test("reports the bridge's error message, without stack noise", posix, async () => {
  const bridge = fakeBridge(`console.error("Error: the bridge is running; stop it first"); process.exit(1)`);
  await assert.rejects(runBridgeCommand(bridge, ["login"]), (e: unknown) => e instanceof BridgeCommandError && e.message === "the bridge is running; stop it first");
});

test("times out a hanging command", posix, async () => {
  const bridge = fakeBridge(`await new Promise(() => setInterval(() => {}, 1000))`);
  await assert.rejects(runBridgeCommand(bridge, ["status"], { timeoutMs: 200 }), /did not respond/);
});

test("parses and validates status", posix, async () => {
  assert.deepEqual(await bridgeStatus(fakeBridge(`console.log(JSON.stringify(${JSON.stringify(STATUS)}))`)), STATUS);
  for (const bad of [{ ...STATUS, running: "yes" }, { ...STATUS, state: "hacked" }, { ...STATUS, approver_id: "x" }, { ...STATUS, api_port: 80 }, { ...STATUS, logged_in: undefined }, "not json"]) {
    const bridge = fakeBridge(`console.log(${JSON.stringify(typeof bad === "string" ? bad : JSON.stringify(bad))})`);
    await assert.rejects(bridgeStatus(bridge), BridgeCommandError, JSON.stringify(bad));
  }
});

test("pairs by passing the public key on stdin", posix, async () => {
  const bridge = fakeBridge(`
    process.stdin.on("end", () => {
      if (args.join(" ") !== "pair-pi" || input.trim() !== "PUBKEY=") process.exit(3);
      console.log(JSON.stringify({ approver_id: "a".repeat(64) }));
    });`);
  assert.equal(await pairPi(bridge, "PUBKEY="), "a".repeat(64));
  await assert.rejects(pairPi(fakeBridge(`console.log("{}")`), "PUBKEY="), BridgeCommandError);
});

test("stores the API credentials by passing them on stdin, never as arguments", posix, async () => {
  const bridge = fakeBridge(`
    process.stdin.on("end", () => {
      const creds = JSON.parse(input);
      if (args.join(" ") !== "set-app" || creds.api_id !== 12345 || creds.api_hash !== "0123456789abcdef0123456789abcdef") process.exit(3);
    });`);
  await setApp(bridge, { api_id: 12345, api_hash: "0123456789abcdef0123456789abcdef" });
  await assert.rejects(setApp(fakeBridge(`console.error("Error: api_hash must be the 32-character code shown on my.telegram.org"); process.exit(1)`), { api_id: 1, api_hash: "x" }), /api_hash/);
});

test("streams login events and sends the user's answers on stdin", posix, async () => {
  const bridge = fakeBridge(`
    const say = (e) => console.log(JSON.stringify(e));
    if (args.join(" ") !== "login --json --method phone") process.exit(3);
    say({ event: "need_phone" });
    let buffered = "";
    process.stdin.on("data", (d) => {
      buffered += d;
      const lines = buffered.split("\\n");
      buffered = lines.pop();
      for (const line of lines) {
        const a = JSON.parse(line);
        if (a.phone === "+15550000001") { say({ event: "code_sent", code_type: "app", code_length: 5 }); say({ event: "need_code" }); }
        else if (a.code === "24680") say({ event: "need_password", hint: "the usual", message: "Enter the password." });
        else if (a.password === "secret") { say({ event: "logged_in", message: "Logged in to Telegram as Test User." }); process.exit(0); }
        else { console.error("Error: unexpected answer"); process.exit(1); }
      }
    });`);
  const events: LoginEvent[] = [];
  const login = startLogin(bridge, "phone", (event) => {
    events.push(event);
    if (event.event === "need_phone") login.answer({ phone: "+15550000001" });
    if (event.event === "need_code") login.answer({ code: "24680" });
    if (event.event === "need_password") login.answer({ password: "secret" });
  });
  assert.deepEqual(await login.done, { ok: true });
  assert.deepEqual(events.map((e) => e.event), ["need_phone", "code_sent", "need_code", "need_password", "logged_in"]);
  assert.deepEqual(events[1], { event: "code_sent", code_type: "app", code_length: 5 });
  assert.deepEqual(events[3], { event: "need_password", hint: "the usual", message: "Enter the password." });
});

test("cancelling a login stops the bridge process", posix, async () => {
  const pidFile = `${fakeBridge("")}.pid`;
  const bridge = fakeBridge(`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000))`);
  const login = startLogin(bridge, "qr", () => {});
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  login.cancel();
  assert.equal((await login.done).ok, false);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), "the bridge process is still alive");
});

test("ignores malformed login output instead of trusting it", posix, async () => {
  const bridge = fakeBridge(`
    console.log("not json");
    console.log(JSON.stringify({ event: "qr", modules: ["01x"] }));
    console.log(JSON.stringify({ event: "qr", modules: ["01", "1x"] }));
    console.log(JSON.stringify({ event: "code_sent", code_type: "pigeon", code_length: 5 }));
    console.log(JSON.stringify({ event: "need_password", hint: "\\u001b[2J" }));
    console.log(JSON.stringify({ event: "run_command", command: "rm -rf ~" }));
    console.log(JSON.stringify({ event: "qr", modules: ["0000", "0110", "0110", "0000"], expires_in: 30 }));
    console.log(JSON.stringify({ event: "logged_in", message: "ok" }));
    process.exit(0);`);
  const events: LoginEvent[] = [];
  assert.deepEqual(await startLogin(bridge, "qr", (e) => events.push(e)).done, { ok: true });
  assert.deepEqual(events.map((e) => e.event), ["need_password", "qr", "logged_in"]);
  assert.deepEqual(events[0], { event: "need_password", hint: "", message: "" }, "a hint with control characters is dropped");
});
