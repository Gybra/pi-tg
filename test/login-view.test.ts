import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LoginAnswer, LoginEvent, LoginProcess } from "../src/types/bridge.ts";
import { renderQRLines, runLoginScreen } from "../src/login-view.ts";

const KEYS = { enter: "\r", escape: "\x1b", backspace: "\x7f" };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const QR = ["000000", "011110", "010010", "010010", "011110", "000000"];

function fakeLogins() {
  const runs: { onEvent: (e: LoginEvent) => void; answers: LoginAnswer[]; cancelled: boolean; finish: (r: { ok: true } | { ok: false; error: string }) => void }[] = [];
  const start = (onEvent: (e: LoginEvent) => void): LoginProcess => {
    let finish!: (r: { ok: true } | { ok: false; error: string }) => void;
    const done = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => (finish = resolve));
    const run = { onEvent, answers: [] as LoginAnswer[], cancelled: false, finish };
    runs.push(run);
    return { answer: (a) => run.answers.push(a), cancel: () => { run.cancelled = true; finish({ ok: false, error: "cancelled" }); }, done };
  };
  return { runs, start };
}

function openScreen(mode = "tui", rows = 60) {
  const logins = fakeLogins();
  let view: { render(w: number): string[]; handleInput(d: string): void } | undefined;
  let renders = 0;
  const ctx = {
    mode,
    hasUI: mode !== "print",
    ui: {
      custom: (factory: (...a: unknown[]) => typeof view) =>
        new Promise((resolve) => {
          view = factory({ terminal: { rows }, requestRender: () => renders++ }, theme, {}, resolve);
        }),
    },
  };
  const result = runLoginScreen(ctx as never, logins.start);
  return { logins, result, view: () => view!, screen: (width = 80) => view!.render(width).join("\n"), renders: () => renders };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const type = (s: ReturnType<typeof openScreen>, text: string) => s.view().handleInput(text);

test("renders QR modules as dark-on-light half blocks", () => {
  const lines = renderQRLines(QR);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(line.startsWith("\x1b[30;47m") && line.endsWith("\x1b[0m"));
    assert.equal(visibleWidth(line), 6);
  }
});

test("shows each QR code with where to scan it, and finishes when logged in", async () => {
  const s = openScreen();
  await flush();
  s.logins.runs[0].onEvent({ event: "qr", modules: QR, expires_in: 30 });
  let screen = s.screen();
  assert.ok(screen.includes("Settings › Devices › Link Desktop Device") && screen.includes("\x1b[30;47m"), screen);
  assert.ok(s.renders() > 0, "a new code must trigger a redraw");
  s.logins.runs[0].onEvent({ event: "logged_in", message: "Logged in to Telegram as Test User." });
  screen = s.screen();
  assert.ok(screen.includes("Test User") && !screen.includes("\x1b[30;47m"), "the QR disappears once logged in");
  s.logins.runs[0].finish({ ok: true });
  assert.equal(await s.result, true);
});

test("asks for the phone number and the code, explaining where the code arrives", async () => {
  const s = openScreen();
  await flush();
  const run = s.logins.runs[0];
  run.onEvent({ event: "need_phone" });
  assert.match(s.screen(), /country code/);
  type(s, "+39 333 12");
  type(s, "x");
  s.view().handleInput(KEYS.backspace);
  type(s, "3 4567");
  assert.ok(s.screen().includes("+39 333 123 4567"), "the typed number is shown");
  s.view().handleInput(KEYS.enter);
  assert.deepEqual(run.answers, [{ phone: "+39 333 123 4567" }]);

  run.onEvent({ event: "code_sent", code_type: "app", code_length: 5 });
  run.onEvent({ event: "need_code" });
  const screen = s.screen();
  assert.match(screen, /Telegram app/);
  assert.match(screen, /not an SMS/);
  assert.match(screen, /5/);
  type(s, " 24680 ");
  s.view().handleInput(KEYS.enter);
  assert.deepEqual(run.answers[1], { code: "24680" });

  run.onEvent({ event: "notice", message: "Wrong code. Check the latest code Telegram sent you and try again." });
  run.onEvent({ event: "need_code" });
  assert.match(s.screen(), /Wrong code/);
  assert.ok(!s.screen().includes("24680"), "the previous code is not shown again");
});

test("masks the two-step verification password and keeps no copy of it", async () => {
  const s = openScreen();
  await flush();
  const run = s.logins.runs[0];
  run.onEvent({ event: "need_password", hint: "the usual", message: "This account has two-step verification. Enter its password." });
  type(s, "correct horse");
  const screen = s.screen();
  assert.ok(!screen.includes("correct horse") && screen.includes("•".repeat(13)) && screen.includes("the usual"), screen);
  s.view().handleInput(KEYS.enter);
  assert.deepEqual(run.answers, [{ password: "correct horse" }]);
  assert.ok(!s.screen().includes("•••"), "the field is cleared after sending");
});

test("Enter on an empty field sends nothing, and control characters are not typed", async () => {
  const s = openScreen();
  await flush();
  s.logins.runs[0].onEvent({ event: "need_phone" });
  s.view().handleInput(KEYS.enter);
  type(s, "\x1b[A");
  type(s, "\x03");
  assert.deepEqual(s.logins.runs[0].answers, []);
});

test("Escape cancels the login and stops the process", async () => {
  const s = openScreen();
  await flush();
  s.logins.runs[0].onEvent({ event: "need_phone" });
  type(s, "+1555");
  s.view().handleInput(KEYS.escape);
  assert.equal(await s.result, false);
  assert.equal(s.logins.runs[0].cancelled, true);
});

test("a failed login can be retried with Enter", async () => {
  const s = openScreen();
  await flush();
  s.logins.runs[0].finish({ ok: false, error: "the code expired; start again to get a new one" });
  await flush();
  assert.ok(s.screen().includes("expired") && s.screen().includes("Enter"));
  s.view().handleInput(KEYS.enter);
  await flush();
  assert.equal(s.logins.runs.length, 2, "Enter starts a new login");
  s.logins.runs[1].finish({ ok: true });
  assert.equal(await s.result, true);
});

test("explains a terminal too small for the QR code instead of drawing a broken one", async () => {
  const big = Array.from({ length: 60 }, () => "1".repeat(60));
  const narrow = openScreen("tui", 60);
  await flush();
  narrow.logins.runs[0].onEvent({ event: "qr", modules: big, expires_in: 30 });
  const screen = narrow.view().render(40);
  assert.ok(screen.join("\n").includes("at least 60 columns"), screen.join("\n"));
  for (const line of screen) assert.ok(visibleWidth(line) <= 40);
  const short = openScreen("tui", 20);
  await flush();
  short.logins.runs[0].onEvent({ event: "qr", modules: big, expires_in: 30 });
  assert.ok(short.view().render(100).join("\n").includes("rows"));
});

test("needs the interactive TUI", async () => {
  const s = openScreen("rpc");
  assert.equal(await s.result, false);
  assert.equal(s.logins.runs.length, 0);
});
