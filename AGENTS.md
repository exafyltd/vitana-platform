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

# Kiro Web: load the Vitana steering

This section applies only to a Kiro Web session, meaning a Kiro session whose workspace root is the folder the
repositories are cloned into (for example `/projects/sandbox`). Codex, Claude Code and Kiro IDE sessions ignore it.

Before anything else in such a session: if `.kiro/steering/vitana-platform--vitana-load-project-rules.md` does not
exist at the workspace root, run `node vitana-platform/scripts/collab/kiro-web-steering.mjs` from the workspace root,
confirm it ends with `kiro-web-steering: ok`, and then follow the loaded Vitana rules. Details:
`docs/kiro/kiro-web-bootstrap.md`.
