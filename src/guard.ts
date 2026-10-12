// Keeps the model away from the bridge's Telegram session, credentials, login and pairing.
// It inspects the paths and commands of Pi's file and shell tools. A determined
// process running as the user can still reach these files; this only stops the
// direct routes a prompt-injected model would try first.

export type GuardPaths = { dataDir: string; installDir: string; configFile: string };

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
// The bridge data directory as written with ~, $HOME or %LOCALAPPDATA%, on each OS.
const DATA_DIR_SUFFIXES = ["application support/telegram-mcp", ".local/share/telegram-mcp", "appdata/local/telegram-mcp", "localappdata/telegram-mcp"];
// Bridge commands that pair an approver, store credentials, log in or out, or delete data.
const PROTECTED_COMMAND = /(^|[\s/"'])pair-pi\b|telegram-mcp(\.exe)?["']?\s+(set-app|login|logout|uninstall|setup)\b/;

const normalize = (s: string) => s.replace(/\\ /g, " ").replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns why the call is blocked, or undefined when it may run. */
export function protectedToolCall(event: { toolName: string; input: Record<string, unknown> }, paths: GuardPaths): string | undefined {
  const field = PATH_TOOLS.has(event.toolName) ? "path" : COMMAND_TOOLS.has(event.toolName) ? "command" : undefined;
  const value = field && event.input[field];
  if (typeof value !== "string") return undefined;
  const dataRoots = [normalize(paths.dataDir), ...DATA_DIR_SUFFIXES].filter(Boolean);
  let text = normalize(value);
  // The outbox holds files staged for sending (each still reviewed by the user) and
  // downloads holds received attachments the user may ask the model to work with.
  for (const root of dataRoots) {
    text = text.replace(new RegExp(`${escapeRegExp(root)}/(?:outbox|downloads)(?:/[^\\s"'\`;|&]*)?`, "g"), (match) => (match.includes("..") ? match : ""));
  }
  // The install directory and config file also match by name, so ~ or $HOME spellings are caught.
  const protectedRoots = [...dataRoots, normalize(paths.installDir), normalize(paths.configFile), "pi-telegram-bridge", "pi-telegram.json"].filter(Boolean);
  if (protectedRoots.some((root) => text.includes(root)) || (field === "command" && PROTECTED_COMMAND.test(text))) {
    return "Blocked: the Telegram bridge's session, credentials, login and pairing are off limits to the model. Only the bridge's outbox and downloads folders may be used. Ask the user to do this themselves.";
  }
  return undefined;
}
