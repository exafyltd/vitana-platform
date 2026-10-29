# Repository Scope

Strict rule: Codex may only work with these GitHub repositories:

- `exafyltd/vitana-v1`
- `exafyltd/vitana-platform`

Codex must ignore every other GitHub repository. Do not inspect, search, clone,
modify, reference, create branches in, open pull requests against, or perform any
action in any repository outside this allowlist unless the user explicitly
changes this rule.

If a task appears to require another repository, stop and ask the user to confirm
that the repository scope rule should be changed before taking any action.

# Kiro Web: bootstrap the session

This section applies only to a Kiro Web session, meaning a Kiro session whose workspace root is the folder the
repositories are cloned into (for example `/projects/sandbox`). Codex, Claude Code and Kiro IDE sessions ignore it.

First action of every such session, from the workspace root:
`node vitana-platform/scripts/collab/kiro-web-session.mjs setup` (give the tool call a timeout of at least 15 min). It
loads the rules (workspace steering), writes the Kiro hooks, installs the git `pre-commit` / `pre-push` hooks, copies
the reviewer agent and installs dependencies and code intelligence, all in the foreground (about 8 min on a fresh
sandbox, seconds afterwards; `--no-codeintel` skips only the code-intelligence indexes). Code intelligence runs last,
after every required item; if the tool call times out while it indexes, run `status` and, later, `setup` again to
resume the index build. Then state the first
`status` line it prints (`kiro-web-session status: ready` or `NOT ready`) and your session id in your first reply,
and follow the loaded Vitana rules. Details: `docs/kiro-web-parity/README.md`.

Fallback, when `setup` cannot run:
Before anything else in such a session: if `.kiro/steering/vitana-platform--vitana-load-project-rules.md` does not
exist at the workspace root, run `node vitana-platform/scripts/collab/kiro-web-steering.mjs` from the workspace root,
confirm it ends with `kiro-web-steering: ok`, and then follow the loaded Vitana rules. Details:
`docs/kiro/kiro-web-bootstrap.md`.
