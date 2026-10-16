### Git worktrees

Agent-created worktrees are spun off from the remote's default branch
(`origin/HEAD`), not from the branch checked out in the main repo. They don't
contain uncommitted or unpushed changes from the main checkout.

If you are running in a worktree, only read files from the worktree itself.
Never read the main checkout or sibling worktrees: their contents differ from
what you are working on and give a misleading picture of the code.
