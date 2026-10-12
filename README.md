# pi-tg

*Unofficial Telegram integration for Pi.*

Read and search your Telegram chats from [Pi](https://pi.dev), and send messages only after you approve each one inside Pi's terminal.

It uses your own Telegram account, like Telegram Desktop does: no bot, nothing added to your groups.

> This is an unofficial Telegram integration, not affiliated with Telegram.

## Before you use it: Telegram's API terms

You create your own Telegram API credentials during setup and, with them, accept [Telegram's API Terms of Service](https://core.telegram.org/api/terms). Read them, in particular **§1.5**: data from Telegram may not be used to train, fine-tune or otherwise develop, enhance or deploy artificial intelligence technologies. pi-tg never trains or improves any model, but the messages you ask Pi about are sent to your AI model provider. Whether that is acceptable under §1.5 is your judgment, and your responsibility as the owner of the credentials: Telegram can withdraw API access from credentials it considers in breach. `/telegram-setup` shows this notice and asks you to confirm before anything is set up.

As Telegram's terms require, reading the latest messages of a chat marks it read, like opening it in a Telegram app, and channel posts come with the channel's sponsored message, labeled as such.

## Platform support

| Platform | Status |
|---|---|
| macOS (Apple Silicon) | **Tested** with a real account: setup from Pi (API credentials, QR login), reading chats and history from before the login, paging, search, approved text, file and voice messages to Saved Messages, a declined send, voice message download, crash restart, stop, network loss and recovery, a session ended from another device and the new login, running next to whatsapp-mcp. Not yet checked: phone-number login, autostart after a reboot, uninstall. |
| Linux | Developed for it, not tested yet. |
| Windows | **Experimental.** Developed for it, not tested yet. |

It needs the [tg-mcp](https://github.com/Gybra/tg-mcp) bridge, which `/telegram-setup` can download for you.

## How it works

- The **tg-mcp bridge** (a separate Go program) logs in to your Telegram account and serves the Telegram tools to Pi over MCP. It refuses to send anything without a signed approval for that exact message.
- **This extension** walks you through the setup and shows you each outgoing message in full before it is sent. Choosing *Approve and send* signs that one message with a key that exists only in this Pi process.

Reading and searching need no approval. Every text, file or voice message does, one at a time:

1. Pi asks to send a message.
2. The bridge freezes the exact recipient, text and attachment bytes.
3. You review all of it in Pi: who receives it (name, @username, ID, and whether it is a private chat, a group or a channel), from which account, and the full content. Control and invisible characters are shown as `⟨U+…⟩`, and *Cancel* is selected by default.
4. Only after you approve does the bridge send. Each approval is single-use and expires after 120 seconds.

If you decline, Pi is told the message was not sent. Without Pi's interactive terminal (print, JSON or RPC mode), sending is refused.

## Setup, step by step

Everything happens inside Pi; no second terminal is needed. Plan about five minutes, with your phone at hand.

1. **Install the extension:**

   ```sh
   pi install npm:@gybra/pi-tg   # once published
   ```

2. **In Pi, run `/telegram-setup`.** It asks one thing at a time and skips what is already done.

3. **The bridge.** Choose *Download and install tg-mcp*: Pi downloads it and checks it against the checksum pinned in this package. If you built it yourself, run `/telegram-setup /path/to/tg-mcp` instead.

4. **Telegram's API terms and your API credentials.** Pi first shows the notice above and asks you to confirm. Telegram requires every program that logs in to an account to have its own credentials. Pi explains how to create yours:
   - open [my.telegram.org](https://my.telegram.org) in a browser and enter your phone number with the country code; the login code arrives in your Telegram app, not by SMS;
   - click **API development tools**;
   - fill in App title `tg-mcp`, Short name `tgmcp`, Platform `Desktop`, and click **Create application**;
   - paste **App api_id** (a number) and **App api_hash** (32 letters and digits) into Pi when it asks. If something does not look right, Pi says so and asks again.

5. **Log in.** Pi asks how:
   - **QR code (recommended):** on your phone, open Telegram › Settings › Devices › Link Desktop Device and scan the code shown in Pi;
   - **Phone number:** type your number, then the code Telegram sends you. It usually arrives in your Telegram app on another device, not by SMS.

   If your account has two-step verification, Pi asks for its password; it is not shown while you type and is passed only to the bridge. The new session appears in your Telegram apps under Settings › Devices as `tg-mcp`.

6. **Background.** Choose whether the bridge starts automatically when you log in to your computer, runs until you log out, or does not start yet. Nothing runs in the background without your choice.

7. **Done.** Ask Pi about your Telegram chats. Before the first message it sends, Pi asks once whether this Pi session may approve messages; after that, every message is still shown to you for approval.

Your `settings.json` and `mcp.json` are not changed. If `mcp.json` already defines a `telegram` server, it is left alone and takes precedence.

## Commands

- `/telegram-setup` sets up or repairs everything, step by step.
- `/telegram-status` shows whether the bridge runs, whether Telegram is logged in, and whether this session can approve messages.
- `/telegram-pair` lets this Pi session approve messages right away, instead of at the first message.
- `/telegram-uninstall` stops the bridge and removes its autostart. It then asks, separately, whether to log this computer out of Telegram and whether to delete the local data (with a second confirmation). By default your data is kept.

The approval key exists only in the running Pi process and is never written to disk. When Pi quits or reloads, the bridge stops trusting it, and the next session asks again.

To send a file, ask Pi to copy it into the bridge's `outbox` folder and send it; every file is reviewed before it is sent. Received files that Pi downloads, such as voice messages, are saved in the bridge's `downloads` folder, where Pi can open them for you. Both folders are in the bridge's data directory, shown by `/telegram-status` or `tg-mcp status`.

## Security notes

- The bridge enforces approval. Disabling this extension never lets a message through; it only removes the way to approve one.
- Telegram messages, names and usernames are untrusted input. They can contain instructions aimed at the model (prompt injection). The approval screen exists so that nothing is sent on the model's word alone. Read what you approve.
- Messages that Pi reads become part of the conversation sent to your model provider and saved in Pi's session files.
- Your phone number, login codes and two-step verification password are typed in Pi's interface and passed only to the bridge; the model never sees them.
- The extension blocks the model's file and shell tools from the bridge's session, credentials, and its login, logout, pairing and uninstall commands; only the `outbox` and `downloads` folders stay open to it. This stops the direct routes a manipulated model would try, but it is not a sandbox.
- This design protects against the model and against other local programs using the bridge's API. It does not protect against a program running as your user that can change the bridge, its data or Pi itself.

## Development

```sh
npm install --no-package-lock --ignore-scripts
npm run typecheck
npm test
```

## License

MIT
