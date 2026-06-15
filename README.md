# cali-finish-work

Pi extension to finish a feature branch from a git worktree.

Commits changes (LLM-assisted or manual message), pushes, then either creates a PR via `gh` CLI or merges directly into the default branch. Designed for the git worktree workflow used by [Muxy](https://muxy.ai).

## Strategy (2026)

1. **Push** branch to origin
2. **PR flow** (default, if `gh` CLI is installed + authenticated):
   - `gh pr create --fill`
   - `gh pr merge --auto --squash` (when CI/branch protection is configured)
   - Delete local branch
3. **Direct merge** (fallback, if `gh` is unavailable):
   - Pre-checks that the default branch worktree is clean
   - If dirty: warns and offers to stash before merging
   - Restores stash after merge

PR flow is safer: no local merge, bypasses dirty worktree issues, forces CI gates.

## Usage

```bash
# From your feature branch worktree:
cali-finish-work
# Or with a manual commit message:
cali-finish-work "feat: add user avatar upload"
```

The extension will:
1. Stage all changes (`git add -A`)
2. If no message provided, ask LLM to write a conventional commit
3. Push the branch
4. Create a PR (gh) or merge locally

## Install

```bash
# Clone into pi extensions directory
git clone https://github.com/renatocaliari/cali-finish-work.git \
  ~/.pi/agent/extensions/cali-finish-work

# Or add to settings.json:
# "extensions": ["/path/to/cali-finish-work/src/index.ts"]
```

Requires `gh` CLI for the PR flow. Install with `brew install gh` and authenticate with `gh auth login`.

## Requirements

- Git (worktree-based workflow)
- `gh` CLI (optional, for PR flow)
- Pi coding agent

## License

MIT
