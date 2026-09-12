import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("alt+c", {
    description: "Commit & push",
    handler: async (ctx) => {
      ctx.ui.setWorkingMessage("Committing & pushing...");

      // 记住执行前的 HEAD
      const before = await pi.exec(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: ctx.cwd },
      );

      const beforeHead = before.code === 0
        ? before.stdout.trim()
        : null;

      // 使用 OMP 配置好的 commit role
      const result = await pi.exec(
        "omp",
        ["commit", "--push"],
        { cwd: ctx.cwd },
      );

      ctx.ui.setWorkingMessage(undefined);

      if (result.code !== 0) {
        ctx.ui.notify(
          result.stderr.trim() || "Commit failed",
          "error",
        );
        return;
      }

      // 找出这次新创建的 commit
      const args = [
        "log",
        "--reverse",
        "--format=%h%x09%s",
      ];

      if (beforeHead) {
        args.push(`${beforeHead}..HEAD`);
      }

      const log = await pi.exec("git", args, {
        cwd: ctx.cwd,
      });

      const commits = log.stdout.trim();

      if (!commits) {
        ctx.ui.notify("No new commit created", "warning");
        return;
      }

      pi.sendMessage(
        {
          customType: "quick-commit-result",
          content: `Committed & pushed:\n\n${commits}`,
          display: true,
          attribution: "agent",
        },
        { triggerTurn: false },
      );
    },
  });
}
