import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// The beginner's path to Telegram API credentials, which every user creates for themselves.

export const TERMS_NOTICE = `This is an unofficial Telegram client. To use it you create your own Telegram API credentials, and with them you accept Telegram's API Terms of Service: https://core.telegram.org/api/terms

Please note in particular §1.5: data from Telegram may not be used to train, fine-tune or otherwise develop, enhance or deploy artificial intelligence technologies. This tool never trains or improves a model, but the messages you ask Pi about are sent to your AI model provider. Whether that is acceptable under §1.5 is your judgment and your responsibility as the owner of the credentials: Telegram can withdraw API access from credentials it considers in breach.

Continue?`;

export const CREDENTIALS_GUIDE = `Telegram asks every program that logs in to an account to have its own API credentials. You create them once, for free, in about two minutes:

1. Open https://my.telegram.org in your browser and enter your phone number with the country code. The login code arrives in your Telegram app, not by SMS.
2. Click "API development tools".
3. Fill in the form: App title "tg-mcp", Short name "tgmcp", Platform "Desktop". You can leave URL and Description empty. Click "Create application".
4. The page now shows "App api_id" (a number) and "App api_hash" (32 letters and digits). Keep that page open: Pi asks for both next.

Keep them private: Pi stores them in a private file on this computer and never shows them to the AI.

Ready to continue?`;

const MAX_ATTEMPTS = 3;

export function parseApiID(input: string): number | undefined {
  const value = input.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  const id = Number(value);
  return id <= 2_147_483_647 ? id : undefined;
}

export function parseApiHash(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

async function ask<T>(ctx: ExtensionContext, title: string, placeholder: string, parse: (input: string) => T | undefined, mistake: string): Promise<T | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const input = await ctx.ui.input(title, placeholder);
    if (input === undefined) return undefined;
    const value = parse(input);
    if (value !== undefined) return value;
    ctx.ui.notify(mistake, "error");
  }
  return undefined;
}

/** Explains how to create API credentials, then asks for them until they look right. */
export async function askCredentials(ctx: ExtensionContext): Promise<{ api_id: number; api_hash: string } | undefined> {
  if (!(await ctx.ui.confirm("Before you start: Telegram's API terms", TERMS_NOTICE))) return undefined;
  if (!(await ctx.ui.confirm("Create your Telegram API credentials", CREDENTIALS_GUIDE))) return undefined;
  const api_id = await ask(ctx, "Paste the App api_id (a number)", "12345678", parseApiID,
    "That is not an api_id: copy the number shown next to \"App api_id\" on my.telegram.org.");
  if (api_id === undefined) return undefined;
  const api_hash = await ask(ctx, "Paste the App api_hash (32 letters and digits)", "0123456789abcdef0123456789abcdef", parseApiHash,
    "That is not an api_hash: copy the 32 letters and digits shown next to \"App api_hash\" on my.telegram.org.");
  if (api_hash === undefined) return undefined;
  return { api_id, api_hash };
}
