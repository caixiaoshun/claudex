import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyClaudeSessionFallback,
  findCurrentSessionByPrompt,
  parseShellCommandForSessionIntent,
  reconstructSessionMessages,
  type SessionFileInfo,
} from "../src/claude-session-bridge.js";
import type { AnthropicRequest } from "../src/converter.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeTempClaudeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-session-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "projects"), { recursive: true });
  return dir;
}

async function writeJsonl(filePath: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
}

describe("parseShellCommandForSessionIntent", () => {
  it("should detect --resume with an explicit session id", () => {
    const prompt = "What token did I ask you to remember?";
    const intent = parseShellCommandForSessionIntent(
      `claude -p --resume 11111111-2222-3333-4444-555555555555 -- "${prompt}"`,
      prompt
    );

    assert.deepEqual(intent, {
      kind: "resume",
      targetSessionId: "11111111-2222-3333-4444-555555555555",
      command: `claude -p --resume 11111111-2222-3333-4444-555555555555 -- "${prompt}"`,
      sourcePath: "",
    });
  });

  it("should detect --continue for the current prompt", () => {
    const prompt = "Reply with CONTINUE";
    const intent = parseShellCommandForSessionIntent(
      `claude -p --continue -- "${prompt}"`,
      prompt
    );

    assert.deepEqual(intent, {
      kind: "continue",
      command: `claude -p --continue -- "${prompt}"`,
      sourcePath: "",
    });
  });
});

describe("findCurrentSessionByPrompt", () => {
  it("should locate the newest matching local Claude session file", async () => {
    const claudeDir = await makeTempClaudeDir();
    const prompt = "Reply only with CURRENT-PROMPT";
    const projectDir = path.join(claudeDir, "projects", "project-a");
    const olderPath = path.join(projectDir, "older.jsonl");
    const currentPath = path.join(projectDir, "current.jsonl");

    await writeJsonl(olderPath, [
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId: "older",
        content: "something else",
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeJsonl(currentPath, [
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId: "current",
        content: prompt,
      },
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: prompt },
      },
    ]);

    const session = await findCurrentSessionByPrompt(prompt, {
      claudeDir,
      nowMs: Date.now(),
    });

    assert.ok(session);
    assert.equal(session!.sessionId, "current");
    assert.equal(session!.filePath, currentPath);
    assert.equal(session!.cwd, "C:\\workspace\\demo");
  });
});

describe("reconstructSessionMessages", () => {
  it("should keep the final assistant snapshot for each user turn", async () => {
    const claudeDir = await makeTempClaudeDir();
    const filePath = path.join(claudeDir, "projects", "project-a", "turns.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        message: { role: "user", content: "Remember TOKEN-42 and say STORED." },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Thinking..." }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STORED." }],
        },
      },
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "API Error: ignored" }],
        },
      },
      {
        type: "user",
        message: { role: "user", content: "What token did I ask you to remember?" },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "TOKEN-42" }],
        },
      },
    ]);

    const messages = await reconstructSessionMessages(filePath);

    assert.deepEqual(messages, [
      { role: "user", content: "Remember TOKEN-42 and say STORED." },
      { role: "assistant", content: "STORED." },
      { role: "user", content: "What token did I ask you to remember?" },
      { role: "assistant", content: "TOKEN-42" },
    ]);
  });
});

describe("applyClaudeSessionFallback", () => {
  it("should prepend reconstructed resume history when shell history references --resume", async () => {
    const claudeDir = await makeTempClaudeDir();
    const projectDir = path.join(claudeDir, "projects", "project-a");
    const targetSessionPath = path.join(
      projectDir,
      "11111111-2222-3333-4444-555555555555.jsonl"
    );
    const currentSessionPath = path.join(
      projectDir,
      "99999999-8888-7777-6666-555555555555.jsonl"
    );
    const historyPath = path.join(claudeDir, "history.txt");
    const prompt = "What token did I ask you to remember? Reply only with the token.";

    await writeJsonl(targetSessionPath, [
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId: "11111111-2222-3333-4444-555555555555",
        content: "Remember TOKEN-42 and reply with STORED.",
      },
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: "Remember TOKEN-42 and reply with STORED." },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STORED." }],
        },
      },
      {
        type: "last-prompt",
        sessionId: "11111111-2222-3333-4444-555555555555",
        lastPrompt: "Remember TOKEN-42 and reply with STORED.",
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 15));

    await writeJsonl(currentSessionPath, [
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId: "99999999-8888-7777-6666-555555555555",
        content: prompt,
      },
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: prompt },
      },
    ]);

    await fs.writeFile(
      historyPath,
      `claude -p --resume 11111111-2222-3333-4444-555555555555 -- "${prompt}"\n`,
      "utf8"
    );

    const req: AnthropicRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>Context</system-reminder>",
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    };

    const result = await applyClaudeSessionFallback(req, {
      claudeDir,
      historyPaths: [historyPath],
      nowMs: Date.now(),
    });

    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages[0], {
      role: "user",
      content: "Remember TOKEN-42 and reply with STORED.",
    });
    assert.deepEqual(result.messages[1], {
      role: "assistant",
      content: "STORED.",
    });
    assert.deepEqual(result.messages[2], req.messages[0]);
  });

  it("should fall back to active Claude process commands when shell history is unavailable", async () => {
    const claudeDir = await makeTempClaudeDir();
    const projectDir = path.join(claudeDir, "projects", "project-a");
    const targetSessionPath = path.join(
      projectDir,
      "aaaaaaaa-2222-3333-4444-555555555555.jsonl"
    );
    const currentSessionPath = path.join(
      projectDir,
      "bbbbbbbb-8888-7777-6666-555555555555.jsonl"
    );
    const prompt = "What token did I ask you to remember? Reply only with the token.";

    await writeJsonl(targetSessionPath, [
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: "Remember TOKEN-42 and reply with STORED." },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STORED." }],
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 15));

    await writeJsonl(currentSessionPath, [
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId: "bbbbbbbb-8888-7777-6666-555555555555",
        content: prompt,
      },
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: prompt },
      },
    ]);

    const req: AnthropicRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    };

    const result = await applyClaudeSessionFallback(req, {
      claudeDir,
      historyPaths: [],
      processCommands: [
        `C:\\Users\\z1573\\.local\\bin\\claude.exe -p --resume aaaaaaaa-2222-3333-4444-555555555555 -- "${prompt}"`,
      ],
      nowMs: Date.now(),
    });

    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages[0], {
      role: "user",
      content: "Remember TOKEN-42 and reply with STORED.",
    });
    assert.deepEqual(result.messages[1], {
      role: "assistant",
      content: "STORED.",
    });
    assert.deepEqual(result.messages[2], req.messages[0]);
  });

  it("should skip failed previous sessions when resolving --continue", async () => {
    const claudeDir = await makeTempClaudeDir();
    const projectDir = path.join(claudeDir, "projects", "project-a");
    const successfulSessionPath = path.join(
      projectDir,
      "11111111-2222-3333-4444-555555555555.jsonl"
    );
    const failedSessionPath = path.join(
      projectDir,
      "66666666-2222-3333-4444-555555555555.jsonl"
    );
    const currentSessionPath = path.join(
      projectDir,
      "99999999-8888-7777-6666-555555555555.jsonl"
    );
    const historyPath = path.join(claudeDir, "history.txt");
    const prompt = "Reply only with FOLLOW-UP.";

    await writeJsonl(successfulSessionPath, [
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: "Remember FOLLOW-UP and reply STORED." },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STORED." }],
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 15));

    await writeJsonl(failedSessionPath, [
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: "This request failed." },
      },
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Authentication failed" }],
        },
      },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 15));

    await writeJsonl(currentSessionPath, [
      {
        type: "queue-operation",
        operation: "enqueue",
        sessionId: "99999999-8888-7777-6666-555555555555",
        content: prompt,
      },
      {
        type: "user",
        cwd: "C:\\workspace\\demo",
        message: { role: "user", content: prompt },
      },
    ]);

    await fs.writeFile(
      historyPath,
      `claude -p --continue -- "${prompt}"\n`,
      "utf8"
    );

    const req: AnthropicRequest = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: prompt }],
    };

    const result = await applyClaudeSessionFallback(req, {
      claudeDir,
      historyPaths: [historyPath],
      nowMs: Date.now(),
    });

    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages[0], {
      role: "user",
      content: "Remember FOLLOW-UP and reply STORED.",
    });
    assert.deepEqual(result.messages[1], {
      role: "assistant",
      content: "STORED.",
    });
    assert.deepEqual(result.messages[2], req.messages[0]);
  });
});
