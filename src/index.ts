import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", timeout: 120000 }).trim();
}

function runSilent(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000 }).trim();
  } catch {
    return "";
  }
}

interface WorktreeInfo {
  path: string;
  branch: string | null;
}

function parseWorktrees(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of output.split("\n")) {
    if (line === "") {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = {};
    } else if (line.startsWith("worktree ")) {
      current.path = line.slice(9);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice(7);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo);
  return worktrees;
}

function getPrimaryWorktreePath(cwd: string): string {
  const commonDir = run("git rev-parse --git-common-dir", cwd);
  if (commonDir === ".git") {
    return run("git rev-parse --show-toplevel", cwd);
  }
  return commonDir.replace(/\/\.git$/, "");
}

function findDefaultBranchWorktree(
  cwd: string,
  branch: string,
): WorktreeInfo | undefined {
  return parseWorktrees(run("git worktree list --porcelain", cwd)).find(
    (wt) => wt.branch === branch,
  );
}

function getDefaultBranch(cwd: string): string {
  const ref = runSilent(
    "git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null",
    cwd,
  );
  if (ref) return ref.replace("refs/remotes/origin/", "");
  for (const b of ["main", "master"]) {
    if (runSilent(`git rev-parse --verify ${b} 2>/dev/null`, cwd)) return b;
  }
  return "master";
}

/** Check if gh CLI is installed and authenticated */
function hasGhCli(): boolean {
  if (!runSilent("gh --version 2>/dev/null")) return false;
  return runSilent("gh auth status 2>/dev/null").length > 0;
}

/** Check if git worktree at cwd has uncommitted changes */
function checkClean(cwd: string): { clean: boolean; files: string[] } {
  const status = runSilent("git status --porcelain", cwd);
  if (!status) return { clean: true, files: [] };
  const lines = status.split("\n").filter(Boolean);
  return { clean: lines.length === 0, files: lines };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cali-finish-work", {
    description:
      "Commit (LLM-assisted or manual), push, create PR (via gh CLI) or merge into default branch. Run from worktree.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;

      // ── 1. Validate ─────────────────────────────────────────────
      const gitDir = runSilent("git rev-parse --git-dir 2>/dev/null", cwd);
      if (!gitDir) {
        ctx.ui.notify("❌ Not a git repository", "error");
        return;
      }

      const branch = run("git rev-parse --abbrev-ref HEAD", cwd);
      if (branch === "HEAD") {
        ctx.ui.notify("❌ Detached HEAD. Checkout a branch first.", "error");
        return;
      }

      const root = run("git rev-parse --show-toplevel", cwd);
      const defaultBranch = getDefaultBranch(cwd);

      if (branch === defaultBranch) {
        ctx.ui.notify(
          `❌ Already on ${defaultBranch}. Nothing to finish.`,
          "error",
        );
        return;
      }

      // ── 2. Detect gh CLI ────────────────────────────────────────
      const hasGh = hasGhCli();
      if (!hasGh) {
        ctx.ui.notify(
          "⚠️  gh CLI not found or not authenticated. Falling back to direct merge. Install `gh` and run `gh auth login` for PR-based flow.",
        );
      }

      // ── 3. Find default branch worktree (needed for direct merge) ─
      let masterWT: WorktreeInfo | undefined;
      if (!hasGh) {
        masterWT = findDefaultBranchWorktree(cwd, defaultBranch);
        if (!masterWT) {
          const primaryPath = getPrimaryWorktreePath(cwd);
          ctx.ui.notify(
            `📥 Checking out ${defaultBranch} in primary worktree...`,
            "info",
          );
          run(`git checkout ${defaultBranch}`, primaryPath);
          masterWT = findDefaultBranchWorktree(cwd, defaultBranch);
          if (!masterWT) {
            ctx.ui.notify(`❌ Failed to checkout ${defaultBranch}`, "error");
            return;
          }
        }

        // ── 3a. Pre-check: master worktree must be clean ─────────
        const masterState = checkClean(masterWT.path);
        if (!masterState.clean) {
          const fileList = masterState.files
            .map((f) => `  ${f}`)
            .join("\n");
          ctx.ui.notify(
            `⚠️  Master worktree (${masterWT.path}) has uncommitted changes:\n${fileList}`,
            "warn",
          );
          const shouldStash = await ctx.ui.confirm(
            "Dirty master worktree",
            [
              "Merge would fail with uncommitted changes in master.",
              "",
              "Files:",
              ...masterState.files,
              "",
              'Choose "Yes" to stash and continue.',
              'Choose "No" to abort and handle manually.',
            ].join("\n"),
          );
          if (!shouldStash) {
            ctx.ui.notify(
              "❌ Aborted. Run `git stash` or commit in master worktree, then re-run.",
              "error",
            );
            return;
          }
          ctx.ui.notify("📦 Stashing master worktree changes...", "info");
          run("git stash --include-untracked", masterWT.path);
        }
      }

      // ── 4. Status ────────────────────────────────────────────────
      const status = run("git status --porcelain", cwd);
      const hasChanges = status.length > 0;
      const fileCount = hasChanges ? status.split("\n").length : 0;
      const manualMsg = args?.trim();

      if (!hasChanges) {
        // ── 4a. No changes → only push + PR/merge ──────────────
        const steps = hasGh
          ? "Push branch → Create PR → Delete local branch"
          : "Fetch → Merge → Push → Delete local branch";
        const ok = await ctx.ui.confirm(
          "Finish Work",
          [
            `📂 Repo:   ${root.split("/").pop()}`,
            `🌿 Branch: ${branch} → ${defaultBranch}`,
            `📦 No new changes to commit`,
            hasGh
              ? `🔗 Strategy: PR via gh CLI`
              : `📍 Merge @: ${masterWT!.path}`,
            "",
            `Steps: ${steps}`,
          ].join("\n"),
        );
        if (!ok) return;

        try {
          // Push is always needed before PR
          ctx.ui.notify("⬆️  Pushing branch...", "info");
          run(`git push origin "${branch}"`, cwd);

          if (hasGh) {
            await prFlow(ctx, cwd, branch, defaultBranch);
          } else {
            await mergeFlow(ctx, cwd, branch, defaultBranch, masterWT!);
          }
        } catch (err: any) {
          const msg = err.stderr?.trim() || err.message || "unknown error";
          ctx.ui.notify(`❌ ${msg}`, "error");
        }
        return;
      }

      // ── 5. Confirm ──────────────────────────────────────────────
      const mode = manualMsg ? "manual" : "LLM";
      const steps = hasGh
        ? [
            "  1. git add -A",
            manualMsg
              ? "  2. git commit (your message)"
              : "  2. LLM reviews diff + commits",
            "  3. git push origin <branch>",
            "  4. gh pr create --fill",
            "  5. gh pr merge --auto --squash",
            "  6. git branch -d <branch>",
          ]
        : [
            "  1. git add -A",
            manualMsg
              ? "  2. git commit (your message)"
              : "  2. LLM reviews diff + commits",
            "  3. git push origin <branch>",
            "  4. git fetch origin",
            `  5. git merge --no-ff ${branch}`,
            `  6. git push origin ${defaultBranch}`,
            "  7. git branch -d <branch>",
          ];

      const ok = await ctx.ui.confirm(
        "Finish Work",
        [
          `📂 Repo:    ${root.split("/").pop()}`,
          `🌿 Branch:  ${branch} → ${defaultBranch}`,
          `📦 Changes: ${fileCount} file(s)`,
          `✍️  Commit mode: ${mode}`,
          ...(manualMsg
            ? [`💬 Message: "${manualMsg}"`]
            : ["💬 LLM will review diff and write descriptive message"]),
          hasGh
            ? `🔗 Strategy: PR via gh CLI`
            : `📍 Merge @: ${masterWT!.path}`,
          "",
          "Steps:",
          ...steps,
          "",
          `Fallback: if LLM commit fails, auto-commits as "work in progress"`,
          "After: remove worktree in Muxy (⌘⇧O → right-click → Remove)",
        ].join("\n"),
      );
      if (!ok) return;

      try {
        // ── 6. Stage all ──────────────────────────────────────────
        ctx.ui.notify("📦 Staging files...", "info");
        run("git add -A", cwd);

        if (manualMsg) {
          run(`git commit -m "${manualMsg.replace(/"/g, '\\"')}"`, cwd);
        } else {
          // ── 6b. LLM-assisted commit ───────────────────────────
          ctx.ui.notify("🤖 Asking LLM to write commit message...", "info");
          pi.sendUserMessage(
            [
              "## Finish Work — Review & Commit",
              "",
              "I've staged changes in the current branch. Your tasks:",
              "",
              "1. Run `git diff --cached --stat` to see what changed",
              "2. Read the diff and write a descriptive commit message in English",
              "3. Use conventional commits format: `feat:` `fix:` `chore:` etc.",
              "4. Commit with: `git commit -m \"<message>\"`",
              "",
              "Do NOT merge, push, or delete any branches — only commit.",
            ].join("\n"),
          );
          await ctx.waitForIdle();

          // ── 6c. Fallback ──────────────────────────────────────
          const after = run("git status --porcelain", cwd);
          if (after.length > 0) {
            ctx.ui.notify(
              "⚠️  LLM commit failed. Auto-committing...",
              "warn",
            );
            run(`git commit -m "work in progress"`, cwd);
          }
        }

        // ── 7. Push branch ──────────────────────────────────────
        ctx.ui.notify("⬆️  Pushing branch...", "info");
        run(`git push origin "${branch}"`, cwd);

        // ── 8. PR or merge ──────────────────────────────────────
        if (hasGh) {
          await prFlow(ctx, cwd, branch, defaultBranch);
        } else {
          await mergeFlow(ctx, cwd, branch, defaultBranch, masterWT!);
        }

        ctx.ui.notify(
          `✅ Concluído. Remova worktree em Muxy (⌘⇧O → right-click → Remove).`,
          "success",
        );
      } catch (err: any) {
        const msg = err.stderr?.trim() || err.message || "unknown error";
        ctx.ui.notify(`❌ ${msg}`, "error");
      }
    },
  });
}

/** PR-based flow: create PR, enable auto-merge, delete local branch */
async function prFlow(
  ctx: any,
  cwd: string,
  branch: string,
  defaultBranch: string,
) {
  ctx.ui.notify("🔗 Creating PR via gh CLI...", "info");
  const prUrl = run(`gh pr create --fill --base "${defaultBranch}"`, cwd);
  ctx.ui.notify(`🔗 PR criado: ${prUrl}`, "success");

  const prNum = prUrl.trim().split("/").pop();

  // Try to enable auto-merge (squash strategy)
  const autoResult = runSilent(
    `gh pr merge --auto --squash "${prNum}" 2>/dev/null`,
    cwd,
  );
  if (autoResult) {
    ctx.ui.notify(
      `✅ Auto-merge (squash) ativado. CI vai mergear automaticamente.`,
      "success",
    );
  } else {
    ctx.ui.notify(
      `ℹ️  Auto-merge não ativado (sem CI ou branch protection configurado?). Merge manual pelo PR.`,
      "info",
    );
  }

  // Delete local branch (safe: skip if checked out in current worktree)
  const isWorktree = runSilent("git rev-parse --git-common-dir", cwd) !== ".git";
  if (isWorktree) {
    ctx.ui.notify(
      `ℹ️  Branch "${branch}" is checked out in this worktree. Remove worktree in Muxy (⌘⇧O → right-click → Remove).`,
      "info",
    );
  } else {
    ctx.ui.notify("🗑️  Deletando branch local...", "info");
    run(`git branch -d "${branch}"`, cwd);
  }

  ctx.ui.notify(
    `✅ ${branch} → PR #${prNum}.`,
    "success",
  );
}

/** Direct merge flow: fetch, merge, push default branch, restore stash */
async function mergeFlow(
  ctx: any,
  cwd: string,
  branch: string,
  defaultBranch: string,
  masterWT: WorktreeInfo,
) {
  // Fetch + merge
  ctx.ui.notify("📥 Fetching and merging...", "info");
  run("git fetch origin", masterWT.path);
  run(
    `git merge --no-ff "${branch}" -m "Merge ${branch} into ${defaultBranch}"`,
    masterWT.path,
  );

  // Push default branch
  ctx.ui.notify(`⬆️  Pushing ${defaultBranch}...`, "info");
  run(`git push origin ${defaultBranch}`, masterWT.path);

  // Delete local branch (safe: skip if checked out in current worktree)
  const isWorktree = runSilent("git rev-parse --git-common-dir", cwd) !== ".git";
  if (isWorktree) {
    ctx.ui.notify(
      `ℹ️  Branch "${branch}" is checked out in this worktree. Remove worktree in Muxy (⌘⇧O → right-click → Remove).`,
      "info",
    );
  } else {
    ctx.ui.notify("🗑️  Deletando branch local...", "info");
    run(`git branch -d "${branch}"`, cwd);
  }

  // Restore stashed changes if any
  const stashList = runSilent("git stash list", masterWT.path);
  if (stashList) {
    ctx.ui.notify("📦 Restaurando stash da master...", "info");
    const popResult = runSilent("git stash pop", masterWT.path);
    if (popResult) {
      ctx.ui.notify(
        "ℹ️  Stash restaurado. Verifique se há conflitos.",
        "info",
      );
    }
  }

  ctx.ui.notify(
    `✅ ${branch} → ${defaultBranch} merged + pushed.`,
    "success",
  );
}
