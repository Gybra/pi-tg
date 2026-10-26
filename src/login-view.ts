import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { LoginAnswer, LoginEvent, LoginProcess } from "./types.ts";

type Question = "phone" | "code" | "password";

type Phase =
  | { kind: "starting" }
  | { kind: "qr"; modules: string[]; expiresIn: number }
  | { kind: "ask"; question: Question; hint: string }
  | { kind: "checking" }
  | { kind: "logged_in"; message: string }
  | { kind: "failed"; error: string };

const CODE_PLACE: Record<string, string> = {
  app: "in your Telegram app on another device (phone, tablet or computer). It is not an SMS: open Telegram and look for a message from Telegram",
  sms: "by SMS",
  call: "with a phone call",
  email: "by email",
  other: "",
};

const MAX_INPUT = 256;

/** Draws QR modules two rows per line, dark on light whatever the terminal theme, so phones can scan it. */
export function renderQRLines(modules: string[]): string[] {
  const lines: string[] = [];
  for (let y = 0; y < modules.length; y += 2) {
    let line = "";
    for (let x = 0; x < modules[y].length; x++) {
      const top = modules[y][x] === "1";
      const bottom = modules[y + 1]?.[x] === "1";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines;
}

/** True for typed or pasted text; control sequences such as arrow keys are not text. */
const isText = (data: string) => data.length > 0 && !/[\p{Cc}]/u.test(data);

class LoginScreen implements Component {
  phase: Phase = { kind: "starting" };
  notice = "";
  codeInfo = "";
  value = "";

  private readonly theme: Pick<Theme, "fg" | "bold">;
  private readonly rows: () => number;
  private readonly keys: (data: string) => void;

  constructor(theme: Pick<Theme, "fg" | "bold">, rows: () => number, keys: (data: string) => void) {
    this.theme = theme;
    this.rows = rows;
    this.keys = keys;
  }

  render(width: number): string[] {
    const t = this.theme;
    const text: string[] = [];
    let qr: string[] = [];
    switch (this.phase.kind) {
      case "starting":
        text.push("Connecting to Telegram…");
        break;
      case "checking":
        text.push("Checking with Telegram…");
        break;
      case "qr": {
        const size = this.phase.modules.length;
        const height = Math.ceil(size / 2);
        if (width < size) text.push(t.fg("warning", `Make the terminal at least ${size} columns wide to show the QR code.`));
        else if (this.rows() < height + 6) text.push(t.fg("warning", `Make the terminal at least ${height + 6} rows tall to show the QR code.`));
        else qr = renderQRLines(this.phase.modules);
        text.push(
          `On your phone open Telegram › Settings › Devices › Link Desktop Device, and scan this code. A new code appears every ${this.phase.expiresIn} s.`,
        );
        break;
      }
      case "ask":
        text.push(...this.question(this.phase.question, this.phase.hint));
        text.push(`> ${this.phase.question === "password" ? "•".repeat([...this.value].length) : this.value}█`);
        text.push(t.fg("muted", "Enter to continue · Esc to cancel"));
        break;
      case "logged_in":
        text.push(t.fg("success", this.phase.message));
        break;
      case "failed":
        text.push(t.fg("error", `Login failed: ${this.phase.error}`), "Press Enter to try again, or Esc to close.");
        break;
    }
    if (this.notice) text.push(t.fg("warning", this.notice));
    if (this.phase.kind !== "failed" && this.phase.kind !== "ask") text.push(t.fg("muted", "Esc to cancel"));
    const wrapped = text.flatMap((line) => wrapTextWithAnsi(line, Math.max(width, 10)));
    return [t.fg("accent", t.bold("Log in to Telegram")), ...qr, ...wrapped].map((line) => truncateToWidth(line, width));
  }

  private question(question: Question, hint: string): string[] {
    switch (question) {
      case "phone":
        return ["Enter the phone number of your Telegram account, with the country code. Example: +39 333 123 4567."];
      case "code":
        return [this.codeInfo || "Enter the login code Telegram sent you."];
      case "password": {
        const lines = ["This account has two-step verification. Enter its password (it is not shown while you type)."];
        if (hint) lines.push(`Your hint: ${hint}`);
        return lines;
      }
    }
  }

  handleInput(data: string): void {
    this.keys(data);
  }

  invalidate(): void {}
}

function answerFor(question: Question, value: string): LoginAnswer {
  switch (question) {
    case "phone":
      return { phone: value.trim() };
    case "code":
      return { code: value.trim() };
    case "password":
      return { password: value };
  }
}

/**
 * Runs `tg-mcp login` inside Pi: shows QR codes, or asks for the phone
 * number, the login code and the two-step verification password, and passes the
 * answers only to the bridge. Resolves true once logged in, false when cancelled
 * or outside the TUI.
 */
export async function runLoginScreen(ctx: ExtensionContext, start: (onEvent: (event: LoginEvent) => void) => LoginProcess): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return false;
  return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
    let current: LoginProcess | undefined;
    let finished = false;
    const finish = (loggedIn: boolean) => {
      if (finished) return;
      finished = true;
      screen.value = "";
      done(loggedIn);
    };
    const onEvent = (event: LoginEvent) => {
      switch (event.event) {
        case "qr":
          screen.phase = { kind: "qr", modules: event.modules, expiresIn: event.expires_in };
          break;
        case "need_phone":
          screen.phase = { kind: "ask", question: "phone", hint: "" };
          break;
        case "code_sent": {
          const length = event.code_length ? `${event.code_length}-character ` : "";
          const place = CODE_PLACE[event.code_type];
          screen.codeInfo = `Telegram sent a ${length}login code${place ? ` ${place}` : ""}. Enter it here.`;
          break;
        }
        case "need_code":
          screen.phase = { kind: "ask", question: "code", hint: "" };
          break;
        case "need_password":
          screen.phase = { kind: "ask", question: "password", hint: event.hint };
          break;
        case "logged_in":
          screen.phase = { kind: "logged_in", message: event.message };
          screen.notice = "";
          break;
        case "notice":
          screen.notice = event.message;
          break;
      }
      tui.requestRender();
    };
    const run = () => {
      screen.phase = { kind: "starting" };
      screen.notice = screen.codeInfo = screen.value = "";
      const login = start(onEvent);
      current = login;
      login.done.then((result) => {
        if (current !== login || finished) return;
        if (result.ok) return finish(true);
        screen.phase = { kind: "failed", error: result.error };
        tui.requestRender();
      });
    };
    const keys = (data: string) => {
      const phase = screen.phase;
      if (data === "\x1b") {
        current?.cancel();
        finish(false);
      } else if (phase.kind === "failed" && (data === "\r" || data === "\n")) {
        run();
      } else if (phase.kind === "ask") {
        if (data === "\r" || data === "\n") {
          if (screen.value.trim() === "") return;
          current?.answer(answerFor(phase.question, screen.value));
          screen.value = "";
          screen.notice = "";
          screen.phase = { kind: "checking" };
        } else if (data === "\x7f" || data === "\b") {
          screen.value = [...screen.value].slice(0, -1).join("");
        } else if (isText(data) && screen.value.length + data.length <= MAX_INPUT) {
          screen.value += data;
        } else {
          return;
        }
      } else {
        return;
      }
      tui.requestRender();
    };
    const screen = new LoginScreen(theme, () => tui.terminal.rows, keys);
    run();
    return screen;
  });
}
