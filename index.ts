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
const CONTEXT_MAX_CHARS = 6000;
const CONTEXT_ENTRY_MAX_CHARS = 2000;
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

let shimmerPromise: Promise<typeof Shimmer | null> | undefined;

/** Load the host shimmer when available without making it an extension requirement. */
function loadShimmer(): Promise<typeof Shimmer | null> {
  shimmerPromise ??= import(
    "@oh-my-pi/pi-coding-agent/modes/theme/shimmer"
  ).catch(() => null);
  return shimmerPromise;
}

/** Loader variant without the leading gap already supplied by extension widgets. */
class WidgetLoader extends Loader {
  override render(width: number): readonly string[] {
    return super.render(width).slice(1);
  }
}

/** Show progress in the richest form supported by the current host mode. */
async function showProgress(ctx: ExtensionContext, message: string) {
  if (ctx.mode !== "tui") {
    ctx.ui.setStatus(PROGRESS_KEY, message);
    return;
  }

  const shimmer = await loadShimmer();
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

async function readHead(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | null> {
  const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Echo the commits created since `previousHead` into the session, falling back
 * to a notification when git reports no subject lines.
 */
async function echoNewCommits(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  previousHead: string | null,
  label: string,
): Promise<boolean> {
  const currentHead = await readHead(pi, ctx);
  if (currentHead === null || currentHead === previousHead) return false;

  const range = previousHead ? `${previousHead}..${currentHead}` : currentHead;
  const logResult = await pi.exec(
    "git",
    ["log", "--reverse", "--format=%h%x09%s", range],
    { cwd: ctx.cwd },
  );
  const commitSummary = logResult.code === 0 ? logResult.stdout.trim() : "";

  if (commitSummary) {
    pi.sendMessage(
      {
        customType: "omp-quick-commit.result",
        content: `${label}:\n\n${commitSummary}`,
        display: true,
        attribution: "agent",
      },
      { triggerTurn: false },
    );
  } else {
    ctx.ui.notify(`HEAD moved to ${currentHead.slice(0, 7)}`, "info");
  }
  return true;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  return parts;
}

function changedPaths(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const paths: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const call = block as {
      type?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (call.type !== "toolCall" || typeof call.name !== "string") continue;
    if (MUTATING_TOOLS[call.name] !== true) continue;
    const args = call.arguments as { path?: unknown } | undefined;
    const path = args?.path;
    if (typeof path === "string" && path) paths.push(path);
  }
  return paths;
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

  const turns: string[] = [];
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textParts(message.content).join("\n").trim();
    if (text) {
      const clipped =
        text.length > CONTEXT_ENTRY_MAX_CHARS
          ? `${text.slice(0, CONTEXT_ENTRY_MAX_CHARS)}…`
          : text;
      turns.push(`${message.role === "user" ? "User" : "Agent"}: ${clipped}`);
    }
    for (const path of changedPaths(message.content)) files.add(path);
  }

  // Keep whole turns, newest first, until the character budget is spent.
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (kept.length > 0 && used + turn.length > CONTEXT_MAX_CHARS) break;
    kept.unshift(turn);
    used += turn.length + 2;
  }
  if (kept.length === 0) return "";

  const body = kept.join("\n\n");
  const fileList = [...files].slice(0, CONTEXT_FILES_MAX);
  if (fileList.length === 0) return body;
  const list = fileList.map(path => `- ${path}`).join("\n");
  return `${body}\n\nFiles the agent edited recently:\n${list}`;
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
      maxTokens: 1024,
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
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy; wait before committing", "warning");
    return;
  }

  try {
    await showProgress(ctx, QUICK_PROGRESS_TEXT);

    const context = collectContext(ctx);
    if (!context) {
      ctx.ui.notify(
        "No agent context to summarize; use /commit instead",
        "warning",
      );
      return;
    }

    const stageResult = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
    if (stageResult.code !== 0) {
      ctx.ui.notify(stageResult.stderr.trim() || "git add failed", "error");
      return;
    }

    // Bail before the model call: a clean tree needs no message.
    const stagedResult = await pi.exec("git", ["diff", "--cached", "--quiet"], {
      cwd: ctx.cwd,
    });
    if (stagedResult.code === 0) {
      ctx.ui.notify("No changes to commit", "warning");
      return;
    }

    const message = await generateCommitMessage(ctx, context);
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

    // `omp commit --push` never sets an upstream; a fresh branch would strand
    // the commit locally, so track `origin/<branch>` when the branch has none.
    const upstreamResult = await pi.exec(
      "git",
      ["rev-parse", "--abbrev-ref", "@{u}"],
      { cwd: ctx.cwd },
    );
    const pushResult = await pi.exec(
      "git",
      upstreamResult.code === 0
        ? ["push"]
        : ["push", "--set-upstream", "origin", "HEAD"],
      { cwd: ctx.cwd },
    );

    const pushed = pushResult.code === 0;
    await echoNewCommits(
      pi,
      ctx,
      previousHead,
      pushed ? "Committed & pushed" : "Committed, push failed",
    );
    if (!pushed) {
      ctx.ui.notify(pushResult.stderr.trim() || "Push failed", "error");
    }
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Quick commit failed",
      "error",
    );
  } finally {
    clearProgress(ctx);
  }
}

async function commitAndPush(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy; wait before committing", "warning");
    return;
  }

  try {
    await showProgress(ctx, PROGRESS_TEXT);
    const previousHead = await readHead(pi, ctx);

    const commitResult = await pi.exec("omp", ["commit", "--push"], {
      cwd: ctx.cwd,
    });

    const headMoved = await echoNewCommits(
      pi,
      ctx,
      previousHead,
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
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : "Commit failed",
      "error",
    );
  } finally {
    clearProgress(ctx);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("commit", {
    description: "Commit all changes and push",
    handler: (_args, ctx) => commitAndPush(pi, ctx),
  });

  pi.registerCommand("quick-commit", {
    description: "Commit & push with a message summarized from agent context",
    handler: (_args, ctx) => quickCommitAndPush(pi, ctx),
  });

  pi.registerShortcut("alt+c", {
    description: "Commit & push",
    handler: (ctx) => commitAndPush(pi, ctx),
  });

  pi.registerShortcut("alt+q", {
    description: "Quick commit & push from agent context",
    handler: (ctx) => quickCommitAndPush(pi, ctx),
  });
}
