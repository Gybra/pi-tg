import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { protectedToolCall } from "../src/guard.ts";

const paths = {
  dataDir: "/Users/ada/Library/Application Support/tg-mcp",
  installDir: "/Users/ada/.pi/agent/pi-tg-bridge",
  configFile: "/Users/ada/.pi/agent/pi-tg.json",
};

const call = (toolName: string, input: Record<string, unknown>) => protectedToolCall({ toolName, input }, paths);

test("blocks model access to the session, credentials, login, logout and pairing", () => {
  for (const [tool, input] of [
    ["read", { path: join(paths.dataDir, "session.json") }],
    ["read", { path: join(paths.dataDir, "config.json") }],
    ["read", { path: "~/Library/Application Support/tg-mcp/approver.json" }],
    ["bash", { command: 'cat "$HOME/Library/Application Support/tg-mcp/api-token"' }],
    ["bash", { command: "sqlite3 ~/.local/share/tg-mcp/telegram.db .dump" }],
    ["powershell", { command: "Get-Content $env:LOCALAPPDATA\\tg-mcp\\session.json" }],
    ["bash", { command: "echo KEY= | /opt/tools/tg-mcp pair-pi" }],
    ["bash", { command: "tg-mcp pair-pi < key.txt" }],
    ["bash", { command: "echo '{\"api_id\":1}' | tg-mcp set-app" }],
    ["bash", { command: "/opt/tools/tg-mcp login --json --method phone" }],
    ["bash", { command: "tg-mcp logout" }],
    ["bash", { command: "tg-mcp uninstall --purge --yes" }],
    ["bash", { command: '"C:/Tools/tg-mcp.exe" login' }],
    ["bash", { command: "cp /tmp/evil ~/.pi/agent/pi-tg-bridge/1.0.0/tg-mcp" }],
    ["write", { path: paths.configFile, content: "{}" }],
    ["bash", { command: "cat ~/Library/Application\\ Support/tg-mcp/outbox/../session.json" }],
    ["grep", { pattern: "x", path: "/Users/ada/Library/Application Support/tg-mcp" }],
  ] as const) {
    assert.ok(call(tool, input as Record<string, unknown>), `${tool} ${JSON.stringify(input)} was allowed`);
  }
});

test("allows the outbox and ordinary work, including this repository", () => {
  for (const [tool, input] of [
    ["bash", { command: `cp report.pdf "${paths.dataDir}/outbox/report.pdf"` }],
    ["write", { path: join(paths.dataDir, "outbox", "notes.txt"), content: "hi" }],
    ["bash", { command: "go test ./... && git status" }],
    ["bash", { command: "git log --grep login && npm run login" }],
    ["read", { path: "/Users/ada/Documents/GO/tg-mcp/tg-bridge/login.go" }],
    ["bash", { command: "/opt/tools/tg-mcp status --json" }],
    ["edit", { path: "/Users/ada/Documents/pi-tg/src/guard.ts", edits: [{ oldText: "a", newText: "Application Support/tg-mcp pair-pi" }] }],
    ["write", { path: "/Users/ada/Documents/notes.md", content: "session.json lives in Application Support/tg-mcp" }],
  ] as const) {
    assert.equal(call(tool, input as Record<string, unknown>), undefined, `${tool} ${JSON.stringify(input)} was blocked`);
  }
});

test("lets the model read downloaded attachments, such as voice messages", () => {
  assert.equal(call("read", { path: join(paths.dataDir, "downloads", "9f2c.ogg") }), undefined);
  assert.equal(call("bash", { command: 'ffprobe "$HOME/Library/Application Support/tg-mcp/downloads/9f2c.ogg"' }), undefined);
  assert.ok(call("read", { path: join(paths.dataDir, "downloads", "..", "session.json") }));
});

test("an unknown data directory never blocks everything", () => {
  const unknown = { ...paths, dataDir: "" };
  assert.equal(protectedToolCall({ toolName: "bash", input: { command: "ls -la" } }, unknown), undefined);
  assert.ok(protectedToolCall({ toolName: "bash", input: { command: "cat ~/.local/share/tg-mcp/session.json" } }, unknown));
});

test("ignores other tools, including the Telegram MCP tools themselves", () => {
  assert.equal(call("mcp__telegram__list_messages", { query: "session.json" }), undefined);
  assert.equal(call("mcp__github__search", { q: "approver.json" }), undefined);
});
