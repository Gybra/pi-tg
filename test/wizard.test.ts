import assert from "node:assert/strict";
import test from "node:test";
import { askCredentials, CREDENTIALS_GUIDE, parseApiHash, parseApiID, TERMS_NOTICE } from "../src/wizard.ts";

test("the guide walks a beginner through my.telegram.org", () => {
  for (const step of ["https://my.telegram.org", "Telegram app", "API development tools", "App title", "Short name", "Desktop", "Create application", "api_id", "api_hash", "private"]) {
    assert.ok(CREDENTIALS_GUIDE.includes(step), step);
  }
});

test("the terms notice explains the AI clause and who is responsible, before anything is set up", async () => {
  for (const point of ["unofficial", "§1.5", "artificial intelligence", "model provider", "your responsibility", "https://core.telegram.org/api/terms"]) {
    assert.ok(TERMS_NOTICE.includes(point), point);
  }
  const { ctx, prompts } = fakeCtx(true, ["12345", "0123456789abcdef0123456789abcdef"]);
  await askCredentials(ctx);
  assert.equal(prompts[0], TERMS_NOTICE, "the terms come first");
});

test("accepts api_id and api_hash as copied from the page, and nothing else", () => {
  assert.equal(parseApiID(" 12345678 "), 12345678);
  assert.equal(parseApiID("2147483647"), 2147483647);
  for (const bad of ["", "0", "-5", "12a", "1.5", "2147483648", "App api_id: 123"]) assert.equal(parseApiID(bad), undefined, bad);
  assert.equal(parseApiHash(" 0123456789ABCDEF0123456789abcdef\n"), "0123456789abcdef0123456789abcdef");
  for (const bad of ["", "0123", "0123456789abcdef0123456789abcdeg", "0123456789abcdef0123456789abcdef0"]) assert.equal(parseApiHash(bad), undefined, bad);
});

function fakeCtx(confirm: boolean, inputs: (string | undefined)[]) {
  const notes: string[] = [];
  const prompts: string[] = [];
  const ctx = {
    ui: {
      confirm: async (_title: string, message: string) => (prompts.push(message), confirm),
      input: async (title: string) => (prompts.push(title), inputs.shift()),
      notify: (message: string) => notes.push(message),
    },
  };
  return { ctx: ctx as never, notes, prompts };
}

test("asks for both values and re-asks after a mistake", async () => {
  const { ctx, notes } = fakeCtx(true, ["my id", "12345", "not a hash", "0123456789abcdef0123456789abcdef"]);
  assert.deepEqual(await askCredentials(ctx), { api_id: 12345, api_hash: "0123456789abcdef0123456789abcdef" });
  assert.equal(notes.length, 2, "each mistake is explained");
  assert.match(notes[0], /number/);
  assert.match(notes[1], /32/);
});

test("stops when the user declines, cancels or keeps getting it wrong", async () => {
  assert.equal(await askCredentials(fakeCtx(false, ["12345"]).ctx), undefined);
  assert.equal(await askCredentials(fakeCtx(true, [undefined]).ctx), undefined);
  assert.equal(await askCredentials(fakeCtx(true, ["12345", undefined]).ctx), undefined);
  const wrong = fakeCtx(true, ["a", "b", "c", "12345"]);
  assert.equal(await askCredentials(wrong.ctx), undefined);
  assert.equal(wrong.notes.length, 3);
});
