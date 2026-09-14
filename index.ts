import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as Shimmer from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import { Loader, type LoaderMessageColorFn } from "@oh-my-pi/pi-tui";

const PROGRESS_KEY = "omp-quick-commit";
const PROGRESS_TEXT = "Committing & pushing...";
const QUICK_PROGRESS_TEXT = "Summarizing context & committing...";

/** Most recent session entries scanned for the quick-commit summary. */
const CONTEXT_ENTRIES = 12;
/** Character budget for the assembled context prompt. */
const CONTEXT_MAX_CHARS = 3000;
const CONTEXT_ENTRY_MAX_CHARS = 1200;
const CONTEXT_FILES_MAX = 30;

/** Tools whose top-level `path` argument names the file the agent changed. */
const MUTATING_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
};

const QUICK_SYSTEM_PROMPT = [
  "You write one git commit message from an agent work log.",
  "Reply with the commit message only: no code fences, quotes, labels, or commentary.",
  "First line: a conventional-commit subject `<type>(<scope>): <summary>` — type in English (feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert), scope optional, subject under 72 characters.",
  "Then optionally a blank line and 1-4 short `- ` body lines for the notable changes.",
  "Language: write the summary and body in the log's own language — a Chinese log gets a Chinese description, an English log gets English. The type prefix and scope stay English.",
  "Describe only changes the log supports; never invent work.",
].join("\n");

type ProgressColorFn = LoaderMessageColorFn & { animated?: true };

let shimmerModule: typeof Shimmer | null = null;
let commitInFlight = false;

// The host-internal shimmer is optional, so preload it without delaying startup.
void import("@oh-my-pi/pi-coding-agent/modes/theme/shimmer")
  .then(shimmer => {
    shimmerModule = shimmer;
  })
  .catch(() => undefined);

/** Loader variant without the leading gap already supplied by extension widgets. */
class WidgetLoader extends Loader {
  override render(width: number): readonly string[] {
    return super.render(width).slice(1);
  }
}

/** Show progress immediately, using shimmer when its preload has completed. */
function showProgress(ctx: ExtensionContext, message: string) {
  if (ctx.mode !== "tui") {
    ctx.ui.setStatus(PROGRESS_KEY, message);
    return;
  }

  const shimmer = shimmerModule;
  ctx.ui.setWidget(PROGRESS_KEY, (tui, theme) => {
    const colorize: ProgressColorFn = shimmer
      ? (text) => shimmer.shimmerText(text, theme)
      : (text) => theme.fg("muted", text);
    if (shimmer?.shimmerEnabled()) colorize.animated = true;
    return new WidgetLoader(
      tui,
      (frame) => theme.fg("accent", frame),
      colorize,
      message,
    );
  });
}

function clearProgress(ctx: ExtensionContext) {
  if (ctx.mode === "tui") ctx.ui.setWidget(PROGRESS_KEY, undefined);
  else ctx.ui.setStatus(PROGRESS_KEY, undefined);
}

async function runCommitOperation(
  ctx: ExtensionContext,
  progressMessage: string,
  fallbackError: string,
  operation: () => Promise<void>,
) {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy; wait before committing", "warning");
    return;
  }
  if (commitInFlight) {
    ctx.ui.notify("A commit is already in progress", "warning");
    return;
  }

  commitInFlight = true;
  try {
    showProgress(ctx, progressMessage);
    await operation();
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : fallbackError,
      "error",
    );
  } finally {
    commitInFlight = false;
    clearProgress(ctx);
  }
}

async function readHead(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | null> {
  const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

type StagingOutcome =
  | { kind: "ready" }
  | { kind: "empty" }
  | { kind: "failed"; message: string };

async function stageChanges(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<StagingOutcome> {
  const stageResult = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
  if (stageResult.code !== 0) {
    return {
      kind: "failed",
      message: stageResult.stderr.trim() || "git add failed",
    };
  }

  const stagedResult = await pi.exec("git", ["diff", "--cached", "--quiet"], {
    cwd: ctx.cwd,
  });
  if (stagedResult.code === 0) return { kind: "empty" };
  if (stagedResult.code === 1) return { kind: "ready" };
  return {
    kind: "failed",
    message: stagedResult.stderr.trim() || "Unable to inspect staged changes",
  };
}

type NewCommits = {
  currentHead: string;
  summary: string;
};

/** Read commits created since `previousHead` without waiting for a push. */
async function readNewCommits(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  previousHead: string | null,
): Promise<NewCommits | null> {
  const currentHead = await readHead(pi, ctx);
  if (currentHead === null || currentHead === previousHead) return null;

  const range = previousHead ? `${previousHead}..${currentHead}` : currentHead;
  const logResult = await pi.exec(
    "git",
    ["log", "--reverse", "--format=%h%x09%s", range],
    { cwd: ctx.cwd },
  );
  return {
    currentHead,
    summary: logResult.code === 0 ? logResult.stdout.trim() : "",
  };
}

/** Echo newly created commits into the session. */
function echoNewCommits(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commits: NewCommits | null,
  label: string,
): boolean {
  if (!commits) return false;

  if (commits.summary) {
    pi.sendMessage(
      {
        customType: "omp-quick-commit.result",
        content: `${label}:\n\n${commits.summary}`,
        display: true,
        attribution: "agent",
      },
      { triggerTurn: false },
    );
  } else {
    ctx.ui.notify(`HEAD moved to ${commits.currentHead.slice(0, 7)}`, "info");
  }
  return true;
}

function contextParts(
  content: unknown,
): { text: string; files: string[] } {
  if (typeof content === "string") return { text: content.trim(), files: [] };
  if (!Array.isArray(content)) return { text: "", files: [] };

  const texts: string[] = [];
  const files: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const part = block as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
    if (
      part.type === "toolCall" &&
      typeof part.name === "string" &&
      MUTATING_TOOLS[part.name] === true
    ) {
      const args = part.arguments as { path?: unknown } | undefined;
      if (typeof args?.path === "string" && args.path) files.push(args.path);
    }
  }
  return { text: texts.join("\n").trim(), files };
}

/**
 * Summarize the current branch's recent conversation into a prompt-sized
 * transcript. Tool calls contribute only the paths the agent edited, so the
 * model sees intent and outcome without the tool-result noise.
 */
function collectContext(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager
    .getBranch()
    .filter(entry => entry.type === "message")
    .slice(-CONTEXT_ENTRIES);

  const turns: Array<{ text: string; files: string[] }> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const { text: rawText, files } = contextParts(message.content);
    const clipped =
      rawText.length > CONTEXT_ENTRY_MAX_CHARS
        ? `${rawText.slice(0, CONTEXT_ENTRY_MAX_CHARS)}…`
        : rawText;
    turns.push({
      text: clipped
        ? `${message.role === "user" ? "User" : "Agent"}: ${clipped}`
        : "",
      files,
    });
  }

  // Keep whole turns, newest first, until the shared character budget is spent.
  const kept: typeof turns = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const separatorLength = turn.text && used > 0 ? 2 : 0;
    if (
      turn.text &&
      used + separatorLength + turn.text.length > CONTEXT_MAX_CHARS
    ) {
      break;
    }
    kept.unshift(turn);
    if (turn.text) {
      used += separatorLength + turn.text.length;
    }
  }

  let context = kept
    .map(turn => turn.text)
    .filter(Boolean)
    .join("\n\n");
  if (!context) return "";

  const files = new Set(kept.flatMap(turn => turn.files));
  let fileCount = 0;
  for (const path of files) {
    if (fileCount >= CONTEXT_FILES_MAX) break;
    const prefix =
      fileCount === 0 ? "\n\nFiles the agent edited recently:\n" : "\n";
    const addition = `${prefix}- ${path}`;
    if (context.length + addition.length > CONTEXT_MAX_CHARS) break;
    context += addition;
    fileCount++;
  }
  return context;
}

function sanitizeCommitMessage(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .replace(/^(?:commit message|message)\s*[:：]\s*/i, "")
    .trim()
    .replace(/^(["'`])([\s\S]*)\1$/, "$2")
    .trim();
}

async function generateCommitMessage(
  ctx: ExtensionContext,
  context: string,
): Promise<string | null> {
  const model =
    ctx.models.resolve("@commit") ?? ctx.models.resolve("@smol") ?? ctx.model;
  if (!model) {
    ctx.ui.notify("No model available for quick commit", "error");
    return null;
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    ctx.ui.notify(
      `No API key available for ${model.provider}/${model.id}`,
      "error",
    );
    return null;
  }

  const response = await completeSimple(
    model,
    {
      systemPrompt: [QUICK_SYSTEM_PROMPT],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Recent agent session context, oldest first (user requests and agent replies):",
                "",
                context,
                "",
                "Write exactly one commit message for the work described above.",
                "Match the log's language (中文日志用中文描述), keeping the type prefix in English.",
              ].join("\n"),
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      cwd: ctx.cwd,
      temperature: 0,
      maxTokens: 256,
      disableReasoning: true,
      acceptEmptyResponse: true,
    },
  );

  const raw = response.content
    .filter((block): block is { type: "text"; text: string } => {
      return block.type === "text";
    })
    .map(block => block.text)
    .join("\n");

  const message = sanitizeCommitMessage(raw);
  if (!message) {
    ctx.ui.notify("Model returned an empty commit message", "error");
    return null;
  }
  return message;
}

async function quickCommitAndPush(pi: ExtensionAPI, ctx: ExtensionContext) {
  const context = collectContext(ctx);
  if (!context) {
    ctx.ui.notify(
      "No agent context to summarize; use /commit instead",
      "warning",
    );
    return;
  }

  const statusResult = await pi.exec("git", ["status", "--porcelain"], {
    cwd: ctx.cwd,
  });
  if (statusResult.code !== 0) {
    ctx.ui.notify(
      statusResult.stderr.trim() || "git status failed",
      "error",
    );
    return;
  }
  if (!statusResult.stdout.trim()) {
    ctx.ui.notify("No changes to commit", "warning");
    return;
  }

  const [staging, message] = await Promise.all([
    stageChanges(pi, ctx),
    generateCommitMessage(ctx, context),
  ]);
  if (staging.kind === "failed") {
    ctx.ui.notify(staging.message, "error");
    return;
  }
  if (staging.kind === "empty") {
    ctx.ui.notify("No changes to commit", "warning");
    return;
  }
  if (!message) return;

  const previousHead = await readHead(pi, ctx);
  const commitResult = await pi.exec("git", ["commit", "-m", message], {
    cwd: ctx.cwd,
  });
  if (commitResult.code !== 0) {
    const failure =
      commitResult.stderr.trim() ||
      commitResult.stdout.trim() ||
      "Commit failed";
    ctx.ui.notify(failure, "error");
    return;
  }

  // A fresh branch needs an explicit origin upstream.
  const upstreamResult = await pi.exec(
    "git",
    ["rev-parse", "--abbrev-ref", "@{u}"],
    { cwd: ctx.cwd },
  );
  const [pushResult, commits] = await Promise.all([
    pi.exec(
      "git",
      upstreamResult.code === 0
        ? ["push"]
        : ["push", "--set-upstream", "origin", "HEAD"],
      { cwd: ctx.cwd },
    ),
    readNewCommits(pi, ctx, previousHead),
  ]);

  const pushed = pushResult.code === 0;
  echoNewCommits(
    pi,
    ctx,
    commits,
    pushed ? "Committed & pushed" : "Committed, push failed",
  );
  if (!pushed) {
    ctx.ui.notify(pushResult.stderr.trim() || "Push failed", "error");
  }
}

async function commitAndPush(pi: ExtensionAPI, ctx: ExtensionContext) {
  const previousHead = await readHead(pi, ctx);
  const commitResult = await pi.exec("omp", ["commit", "--push"], {
    cwd: ctx.cwd,
  });

  const commits = await readNewCommits(pi, ctx, previousHead);
  const headMoved = echoNewCommits(
    pi,
    ctx,
    commits,
    "Committed & pushed",
  );

  const failureMessage =
    commitResult.stderr.trim() ||
    commitResult.stdout.trim() ||
    "Commit failed";

  if (commitResult.killed) {
    ctx.ui.notify("Commit cancelled", "warning");
  } else if (commitResult.code !== 0) {
    ctx.ui.notify(failureMessage, headMoved ? "warning" : "error");
  } else if (!headMoved) {
    ctx.ui.notify("No new commit created", "warning");
  }
}

export default function (pi: ExtensionAPI) {
  const commitHandler = (ctx: ExtensionContext) =>
    runCommitOperation(ctx, PROGRESS_TEXT, "Commit failed", () =>
      commitAndPush(pi, ctx),
    );
  const quickCommitHandler = (ctx: ExtensionContext) =>
    runCommitOperation(ctx, QUICK_PROGRESS_TEXT, "Quick commit failed", () =>
      quickCommitAndPush(pi, ctx),
    );

  pi.registerCommand("commit", {
    description: "Commit all changes and push",
    handler: (_args, ctx) => commitHandler(ctx),
  });

  pi.registerCommand("quick-commit", {
    description: "Commit & push with a message summarized from agent context",
    handler: (_args, ctx) => quickCommitHandler(ctx),
  });

  pi.registerShortcut("alt+c", {
    description: "Commit & push",
    handler: commitHandler,
  });

  pi.registerShortcut("alt+q", {
    description: "Quick commit & push from agent context",
    handler: quickCommitHandler,
  });
}
