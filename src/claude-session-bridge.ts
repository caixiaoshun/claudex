import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as logger from "./logger.js";
import type {
  AnthropicContentBlock,
  AnthropicImageContent,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicToolResultContent,
  AnthropicToolUseContent,
} from "./converter.js";

const DEFAULT_SESSION_SCAN_WINDOW_MS = 2 * 60 * 60 * 1000;
const DEFAULT_HISTORY_SCAN_LINES = 500;
const DEFAULT_PROCESS_SCAN_TIMEOUT_MS = 1500;
const execFileAsync = promisify(execFile);

type HistorySource = "powershell" | "bash" | "zsh" | "fish";

interface SessionIntent {
  kind: "resume" | "continue";
  targetSessionId?: string;
  command: string;
  sourcePath: string;
}

export interface SessionFileInfo {
  filePath: string;
  projectDir: string;
  sessionId: string;
  cwd?: string;
  mtimeMs: number;
}

export interface ClaudeSessionBridgeOptions {
  claudeDir?: string;
  historyPaths?: string[];
  processCommands?: string[];
  nowMs?: number;
  sessionScanWindowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function extractPromptText(req: AnthropicRequest): string | null {
  if (req.messages.length !== 1) {
    return null;
  }

  const [message] = req.messages;
  if (message.role !== "user") {
    return null;
  }

  if (typeof message.content === "string") {
    const trimmed = message.content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  const textParts = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0);

  if (textParts.length === 0) {
    return null;
  }

  return textParts[textParts.length - 1] ?? null;
}

function getDefaultClaudeDir(): string {
  return path.join(os.homedir(), ".claude");
}

function getDefaultHistoryPaths(claudeDir: string): string[] {
  const appData = process.env.APPDATA;
  const historyPaths: string[] = [];

  if (appData) {
    historyPaths.push(
      path.join(
        appData,
        "Microsoft",
        "Windows",
        "PowerShell",
        "PSReadLine",
        "ConsoleHost_history.txt"
      )
    );
  }

  historyPaths.push(
    path.join(os.homedir(), ".bash_history"),
    path.join(os.homedir(), ".zsh_history"),
    path.join(os.homedir(), ".local", "share", "fish", "fish_history"),
    path.join(claudeDir, "history.jsonl")
  );

  return historyPaths;
}

function normalizeHistoryCommand(
  line: string,
  source: HistorySource | "jsonl"
): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (source === "zsh") {
    const separator = trimmed.indexOf(";");
    if (trimmed.startsWith(": ") && separator >= 0) {
      return trimmed.slice(separator + 1).trim();
    }
  }

  if (source === "fish") {
    const match = trimmed.match(/^- cmd:\s*(.+)$/);
    return match?.[1]?.trim() || null;
  }

  if (source === "jsonl") {
    const parsed = safeJsonParse(trimmed);
    if (!isRecord(parsed) || typeof parsed.display !== "string") {
      return null;
    }
    return parsed.display;
  }

  return trimmed;
}

async function readTailLines(
  filePath: string,
  maxLines: number
): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length <= maxLines) {
    return lines;
  }
  return lines.slice(-maxLines);
}

function detectHistorySource(filePath: string): HistorySource | "jsonl" {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".zsh_history")) return "zsh";
  if (normalized.endsWith("fish_history")) return "fish";
  if (normalized.endsWith("history.jsonl")) return "jsonl";
  if (normalized.endsWith(".bash_history")) return "bash";
  return "powershell";
}

export function parseShellCommandForSessionIntent(
  command: string,
  promptText: string
): SessionIntent | null {
  if (!command.includes("claude") || !command.includes(promptText)) {
    return null;
  }

  const resumeMatch = command.match(
    /(?:^|\s)(?:--resume|-r)\s+([0-9a-fA-F-]{36})\b/
  );
  if (resumeMatch?.[1]) {
    return {
      kind: "resume",
      targetSessionId: resumeMatch[1],
      command,
      sourcePath: "",
    };
  }

  if (/(?:^|\s)(?:--continue|-c)(?:\s|$)/.test(command)) {
    return {
      kind: "continue",
      command,
      sourcePath: "",
    };
  }

  return null;
}

export async function resolveSessionIntentFromHistory(
  promptText: string,
  options: ClaudeSessionBridgeOptions = {}
): Promise<SessionIntent | null> {
  const claudeDir = options.claudeDir ?? getDefaultClaudeDir();
  const historyPaths = options.historyPaths ?? getDefaultHistoryPaths(claudeDir);

  for (const historyPath of historyPaths) {
    try {
      const lines = await readTailLines(historyPath, DEFAULT_HISTORY_SCAN_LINES);
      const source = detectHistorySource(historyPath);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const command = normalizeHistoryCommand(lines[i] ?? "", source);
        if (!command) {
          continue;
        }
        const intent = parseShellCommandForSessionIntent(command, promptText);
        if (intent) {
          return {
            ...intent,
            sourcePath: historyPath,
          };
        }
      }
    } catch {
      // Ignore missing or unreadable history files.
    }
  }

  return null;
}

function parseWindowsProcessCommands(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = safeJsonParse(trimmed);
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === "string");
  }

  return typeof parsed === "string" ? [parsed] : [];
}

async function listWindowsClaudeProcessCommands(): Promise<string[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('claude.exe', 'claude') -and $_.CommandLine } | Select-Object -ExpandProperty CommandLine",
    "if ($null -eq $processes) { '[]' } else { $processes | ConvertTo-Json -Compress }",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    {
      windowsHide: true,
      timeout: DEFAULT_PROCESS_SCAN_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }
  );

  return parseWindowsProcessCommands(stdout);
}

async function listPosixClaudeProcessCommands(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-ax", "-o", "command="],
    {
      timeout: DEFAULT_PROCESS_SCAN_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        /(^|[\\/])claude(?:\.exe)?(?=\s|$)/i.test(line)
    );
}

async function listClaudeProcessCommands(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      return await listWindowsClaudeProcessCommands();
    }
    return await listPosixClaudeProcessCommands();
  } catch {
    return [];
  }
}

async function resolveSessionIntentFromProcesses(
  promptText: string,
  options: ClaudeSessionBridgeOptions = {}
): Promise<SessionIntent | null> {
  const processCommands =
    options.processCommands ?? (await listClaudeProcessCommands());

  for (const command of processCommands) {
    const intent = parseShellCommandForSessionIntent(command, promptText);
    if (intent) {
      return {
        ...intent,
        sourcePath: "process:claude",
      };
    }
  }

  return null;
}

async function resolveSessionIntent(
  promptText: string,
  options: ClaudeSessionBridgeOptions = {}
): Promise<SessionIntent | null> {
  const historyIntent = await resolveSessionIntentFromHistory(promptText, options);
  if (historyIntent) {
    return historyIntent;
  }

  return resolveSessionIntentFromProcesses(promptText, options);
}

async function listRecentSessionFiles(
  claudeDir: string,
  nowMs: number,
  scanWindowMs: number
): Promise<SessionFileInfo[]> {
  const projectsDir = path.join(claudeDir, "projects");
  const cutoffMs = nowMs - scanWindowMs;
  let projectEntries: Dirent[];

  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: SessionFileInfo[] = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const projectDir = path.join(projectsDir, projectEntry.name);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(projectDir, entry.name);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }

      if (stat.mtimeMs < cutoffMs) {
        continue;
      }

      files.push({
        filePath,
        projectDir,
        sessionId: path.basename(entry.name, ".jsonl"),
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

async function getSessionFileCwd(filePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const parsed = safeJsonParse(line);
      if (!isRecord(parsed) || !isRecord(parsed.message)) {
        continue;
      }
      if (
        parsed.type === "user" &&
        typeof parsed.cwd === "string" &&
        parsed.cwd.length > 0
      ) {
        return parsed.cwd;
      }
    }
  } catch {
    // Ignore unreadable files.
  }

  return undefined;
}

async function sessionFileMatchesPrompt(
  filePath: string,
  promptText: string
): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const parsed = safeJsonParse(line);
      if (!isRecord(parsed)) {
        continue;
      }

      if (
        parsed.type === "last-prompt" &&
        typeof parsed.lastPrompt === "string" &&
        parsed.lastPrompt === promptText
      ) {
        return true;
      }

      if (
        parsed.type === "queue-operation" &&
        parsed.operation === "enqueue" &&
        typeof parsed.content === "string" &&
        parsed.content === promptText
      ) {
        return true;
      }
    }
  } catch {
    // Ignore unreadable files.
  }

  return false;
}

export async function findCurrentSessionByPrompt(
  promptText: string,
  options: ClaudeSessionBridgeOptions = {}
): Promise<SessionFileInfo | null> {
  const claudeDir = options.claudeDir ?? getDefaultClaudeDir();
  const nowMs = options.nowMs ?? Date.now();
  const scanWindowMs =
    options.sessionScanWindowMs ?? DEFAULT_SESSION_SCAN_WINDOW_MS;
  const candidates = await listRecentSessionFiles(claudeDir, nowMs, scanWindowMs);

  for (const candidate of candidates) {
    if (await sessionFileMatchesPrompt(candidate.filePath, promptText)) {
      return {
        ...candidate,
        cwd: await getSessionFileCwd(candidate.filePath),
      };
    }
  }

  return null;
}

async function findSessionFileById(
  claudeDir: string,
  sessionId: string,
  preferredProjectDir?: string
): Promise<SessionFileInfo | null> {
  const maybePaths = preferredProjectDir
    ? [path.join(preferredProjectDir, `${sessionId}.jsonl`)]
    : [];

  maybePaths.push(path.join(claudeDir, "projects"));

  const preferredPath = preferredProjectDir
    ? path.join(preferredProjectDir, `${sessionId}.jsonl`)
    : null;

  if (preferredPath) {
    try {
      const stat = await fs.stat(preferredPath);
      return {
        filePath: preferredPath,
        projectDir: preferredProjectDir!,
        sessionId,
        cwd: await getSessionFileCwd(preferredPath),
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      // Fall through to a wider search.
    }
  }

  const recentFiles = await listRecentSessionFiles(
    claudeDir,
    Date.now(),
    30 * 24 * 60 * 60 * 1000
  );
  return recentFiles.find((file) => file.sessionId === sessionId) ?? null;
}

async function findPreviousProjectSession(
  currentSession: SessionFileInfo
): Promise<SessionFileInfo | null> {
  let entries: Dirent[];

  try {
    entries = await fs.readdir(currentSession.projectDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: SessionFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const sessionId = path.basename(entry.name, ".jsonl");
    if (sessionId === currentSession.sessionId) {
      continue;
    }

    const filePath = path.join(currentSession.projectDir, entry.name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }

    candidates.push({
      filePath,
      projectDir: currentSession.projectDir,
      sessionId,
      mtimeMs: stat.mtimeMs,
    });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const messages = await reconstructSessionMessages(candidate.filePath);
    if (!messages.some((message) => message.role === "assistant")) {
      continue;
    }

    return {
      ...candidate,
      cwd: await getSessionFileCwd(candidate.filePath),
    };
  }

  return null;
}

function convertTextBlocksToString(
  blocks: Array<{ type: "text"; text: string }>
): string | null {
  const text = blocks
    .map((block) => block.text)
    .filter((value) => value.length > 0)
    .join("\n");
  return text.length > 0 ? text : null;
}

function normalizeToolUseInput(
  input: unknown
): Record<string, unknown> {
  if (isRecord(input)) {
    return input;
  }

  if (typeof input === "string") {
    const parsed = safeJsonParse(input);
    if (isRecord(parsed)) {
      return parsed;
    }
  }

  return {};
}

function convertToolResultContent(
  content: unknown
): string | AnthropicContentBlock[] | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const rawBlock of content) {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") {
      continue;
    }

    if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
      blocks.push({ type: "text", text: rawBlock.text });
      continue;
    }

    if (
      rawBlock.type === "image" &&
      isRecord(rawBlock.source) &&
      typeof rawBlock.source.type === "string"
    ) {
      blocks.push({
        type: "image",
        source: {
          type:
            rawBlock.source.type === "url" ? "url" : "base64",
          media_type:
            typeof rawBlock.source.media_type === "string"
              ? rawBlock.source.media_type
              : undefined,
          data:
            typeof rawBlock.source.data === "string"
              ? rawBlock.source.data
              : undefined,
          url:
            typeof rawBlock.source.url === "string"
              ? rawBlock.source.url
              : undefined,
        },
      } satisfies AnthropicImageContent);
    }
  }

  return blocks.length > 0 ? blocks : null;
}

function convertStoredMessage(
  role: "user" | "assistant",
  rawMessage: unknown
): AnthropicMessage | null {
  if (!isRecord(rawMessage)) {
    return null;
  }

  const rawContent = rawMessage.content;
  if (typeof rawContent === "string") {
    const trimmed = rawContent.trim();
    return trimmed.length > 0 ? { role, content: trimmed } : null;
  }

  if (!Array.isArray(rawContent)) {
    return null;
  }

  const textBlocks: Array<{ type: "text"; text: string }> = [];
  const blocks: AnthropicContentBlock[] = [];

  for (const rawBlock of rawContent) {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") {
      continue;
    }

    switch (rawBlock.type) {
      case "text":
        if (typeof rawBlock.text === "string" && rawBlock.text.length > 0) {
          const block = { type: "text", text: rawBlock.text } as const;
          textBlocks.push(block);
          blocks.push(block);
        }
        break;

      case "tool_use":
        if (
          role === "assistant" &&
          typeof rawBlock.id === "string" &&
          typeof rawBlock.name === "string"
        ) {
          blocks.push({
            type: "tool_use",
            id: rawBlock.id,
            name: rawBlock.name,
            input: normalizeToolUseInput(rawBlock.input),
          } satisfies AnthropicToolUseContent);
        }
        break;

      case "tool_result":
        if (role === "user" && typeof rawBlock.tool_use_id === "string") {
          const content = convertToolResultContent(rawBlock.content);
          if (content !== null) {
            blocks.push({
              type: "tool_result",
              tool_use_id: rawBlock.tool_use_id,
              content,
            } satisfies AnthropicToolResultContent);
          }
        }
        break;

      default:
        break;
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  if (blocks.every((block) => block.type === "text")) {
    const text = convertTextBlocksToString(textBlocks);
    return text ? { role, content: text } : null;
  }

  return {
    role,
    content: blocks,
  };
}

export async function reconstructSessionMessages(
  sessionFilePath: string
): Promise<AnthropicMessage[]> {
  let content: string;
  try {
    content = await fs.readFile(sessionFilePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/);
  const messages: AnthropicMessage[] = [];
  let currentUser: AnthropicMessage | null = null;
  let latestAssistant: AnthropicMessage | null = null;

  const flushTurn = (): void => {
    if (!currentUser) {
      return;
    }

    messages.push(currentUser);
    if (latestAssistant) {
      messages.push(latestAssistant);
    }

    currentUser = null;
    latestAssistant = null;
  };

  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (!isRecord(parsed) || !isRecord(parsed.message)) {
      continue;
    }

    if (parsed.type === "user" && parsed.message.role === "user") {
      flushTurn();
      currentUser = convertStoredMessage("user", parsed.message);
      latestAssistant = null;
      continue;
    }

    if (parsed.type !== "assistant" || parsed.message.role !== "assistant") {
      continue;
    }

    if (parsed.isApiErrorMessage === true) {
      continue;
    }

    const assistantMessage = convertStoredMessage("assistant", parsed.message);
    if (assistantMessage) {
      latestAssistant = assistantMessage;
    }
  }

  flushTurn();
  return messages;
}

export async function applyClaudeSessionFallback(
  req: AnthropicRequest,
  options: ClaudeSessionBridgeOptions = {}
): Promise<AnthropicRequest> {
  const promptText = extractPromptText(req);
  if (!promptText) {
    logger.debug("Claude session fallback skipped: no eligible prompt text");
    return req;
  }

  const intent = await resolveSessionIntent(promptText, options);
  if (!intent) {
    logger.debug("Claude session fallback skipped: no resume/continue intent", {
      promptPreview:
        promptText.length > 200 ? `${promptText.slice(0, 200)}...` : promptText,
    });
    return req;
  }

  const claudeDir = options.claudeDir ?? getDefaultClaudeDir();
  const currentSession = await findCurrentSessionByPrompt(promptText, options);
  if (!currentSession) {
    logger.debug("Claude session fallback skipped: current session not found", {
      intent: intent.kind,
      promptPreview:
        promptText.length > 200 ? `${promptText.slice(0, 200)}...` : promptText,
    });
    return req;
  }

  let targetSession: SessionFileInfo | null = null;
  if (intent.kind === "resume" && intent.targetSessionId) {
    targetSession = await findSessionFileById(
      claudeDir,
      intent.targetSessionId,
      currentSession.projectDir
    );
  } else if (intent.kind === "continue") {
    targetSession = await findPreviousProjectSession(currentSession);
  }

  if (!targetSession || targetSession.sessionId === currentSession.sessionId) {
    logger.debug("Claude session fallback skipped: target session not resolved", {
      intent: intent.kind,
      requestedTargetSessionId: intent.targetSessionId ?? null,
      currentSessionId: currentSession.sessionId,
    });
    return req;
  }

  const historyMessages = await reconstructSessionMessages(targetSession.filePath);
  if (historyMessages.length === 0) {
    logger.debug("Claude session fallback skipped: target session had no usable messages", {
      intent: intent.kind,
      targetSessionId: targetSession.sessionId,
    });
    return req;
  }

  logger.debug("Applied local Claude session fallback", {
    intent: intent.kind,
    sourcePath: intent.sourcePath,
    currentSessionId: currentSession.sessionId,
    targetSessionId: targetSession.sessionId,
    historyMessageCount: historyMessages.length,
    promptPreview:
      promptText.length > 200 ? `${promptText.slice(0, 200)}...` : promptText,
  });

  return {
    ...req,
    messages: [...historyMessages, ...req.messages],
  };
}
