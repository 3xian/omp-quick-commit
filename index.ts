import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PROGRESS_KEY = "omp-quick-commit";
const PROGRESS_TEXT = "Committing & pushing...";

function setProgress(ctx: ExtensionContext, message: string | undefined) {
  ctx.ui.setStatus(PROGRESS_KEY, message);
}

async function readHead(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<string | null> {
  const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function commitAndPush(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy; wait before committing", "warning");
    return;
  }

  try {
    setProgress(ctx, PROGRESS_TEXT);
    const previousHead = await readHead(pi, ctx);

    const commitResult = await pi.exec("omp", ["commit", "--push"], {
      cwd: ctx.cwd,
    });

    const currentHead = await readHead(pi, ctx);

    const failureMessage =
      commitResult.stderr.trim() ||
      commitResult.stdout.trim() ||
      "Commit failed";
    const headMoved = currentHead !== null && currentHead !== previousHead;

    if (headMoved) {
      const range = previousHead
        ? `${previousHead}..${currentHead}`
        : currentHead;
      const logResult = await pi.exec(
        "git",
        ["log", "--reverse", "--format=%h%x09%s", range],
        { cwd: ctx.cwd },
      );
      const commitSummary =
        logResult.code === 0 ? logResult.stdout.trim() : "";

      if (commitSummary) {
        pi.sendMessage(
          {
            customType: "omp-quick-commit.result",
            content: `Committed & pushed:\n\n${commitSummary}`,
            display: true,
            attribution: "agent",
          },
          { triggerTurn: false },
        );
      } else {
        ctx.ui.notify(`HEAD moved to ${currentHead.slice(0, 7)}`, "info");
      }
    }

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
    setProgress(ctx, undefined);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("qc", {
    description: "Commit all changes and push",
    handler: (_args, ctx) => commitAndPush(pi, ctx),
  });

  pi.registerShortcut("alt+c", {
    description: "Commit & push",
    handler: (ctx) => commitAndPush(pi, ctx),
  });
}
