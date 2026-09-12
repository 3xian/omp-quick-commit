import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+c", {
    description: "Commit & push",
    handler: async (ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy; wait before committing", "warning");
        return;
      }

      ctx.ui.setWorkingMessage("Committing & pushing...");
      try {
        const beforeRev = await pi.exec("git", ["rev-parse", "HEAD"], {
          cwd: ctx.cwd,
        });
        const before =
          beforeRev.code === 0 ? beforeRev.stdout.trim() : null;

        const result = await pi.exec("omp", ["commit", "--push"], {
          cwd: ctx.cwd,
        });

        const afterRev = await pi.exec("git", ["rev-parse", "HEAD"], {
          cwd: ctx.cwd,
        });
        const after =
          afterRev.code === 0 ? afterRev.stdout.trim() : null;

        const failText =
          result.stderr.trim() || result.stdout.trim() || "Commit failed";
        const moved = after !== null && after !== before;

        if (moved) {
          const range = before ? `${before}..${after}` : after;
          const log = await pi.exec(
            "git",
            ["log", "--reverse", "--format=%h%x09%s", range],
            { cwd: ctx.cwd },
          );
          const commits = log.code === 0 ? log.stdout.trim() : "";

          if (commits) {
            pi.sendMessage(
              {
                customType: "omp-quick-commit.result",
                content: `Committed & pushed:\n\n${commits}`,
                display: true,
                attribution: "agent",
              },
              { triggerTurn: false },
            );
          } else {
            ctx.ui.notify(`HEAD moved to ${after.slice(0, 7)}`, "info");
          }
        }

        if (result.killed) {
          ctx.ui.notify("Commit cancelled", "warning");
        } else if (result.code !== 0) {
          ctx.ui.notify(failText, moved ? "warning" : "error");
        } else if (!moved) {
          ctx.ui.notify("No new commit created", "warning");
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Commit failed",
          "error",
        );
      } finally {
        ctx.ui.setWorkingMessage(undefined);
      }
    },
  });
}
