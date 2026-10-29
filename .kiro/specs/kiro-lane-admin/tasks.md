# Tasks — kiro-lane-admin

Plan: `.kiro/specs/kiro-lane-admin/plan.md` (plan block authoritative). Design: `design.md`.

<!-- lane: enforcement -->
## Lane `enforcement`
- [ ] E1 `scripts/collab/queue.mjs` `validateLane`: recognise `lane_admin` (boolean); a `lane_admin: true` lane must be
      `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`, and declare a lane-file path
      (`.kiro/specs/*/lanes/*.md`); clear error otherwise. (design §1)
- [ ] E2 `scripts/collab/queue.mjs` `scopeCheck`: add the `laneAdmin` allowance for PERM changes, computed from the
      trusted revision; pin `lane_admin` to trusted so it cannot be self-granted; reword the PERM and governance-path
      refusals to name the Kiro lane-admin / reviewer-agent route; leave the protected-gate refusal and the
      seat-ownership check intact. (design §2, §3, §4)
- [ ] E3 `scripts/collab/protected-gate-files.json` `description` + `PROTECTED_GATE_BUILTIN` comment: replace "legacy
      claude review" with the owner-instruction + reviewer-agent-accept wording; globs unchanged; keep JSON ↔ builtin
      byte-identical content. (design §4)
- [ ] E4 `services/gateway/src/services/project-manager/governance.ts`: replace the legacy-claude protected-gate
      unlock with the reviewer-agent accept on the current head (owner instruction recorded out-of-band); remove the
      dead legacy-claude branch; update header prose; keep every other verdict unchanged. (design §5)
- [ ] E5 `scripts/collab/queue.test.mjs`: add T-A..T-F (design §7), each proven red on origin/main first; all 53
      existing cases stay green; JSON↔builtin parity stays green.
- [ ] E6 Gateway Jest: update `governance.ts` tests for the new protected-gate unlock; suite green.

**Acceptance:**
- Change types: Tooling/docs, Backend.
- Outcome — an authorized Kiro session (reviewer-agent-gated, trusted-source lane with `lane_admin: true`) can reassign
  a lane's `seat` and narrow its `paths`; an ordinary or self-granting lane still cannot; a protected gate file still
  cannot merge on a reviewer-agent accept alone. CI (Collab handoff / Lane scope) enforces this.
- States — n/a (pure enforcement logic + tests; no UI).
- Surfaces — callers of `queue.mjs scope-check`/`validate` (PR-GATE Collab handoff + Lane scope) and the PM
  `governance.ts` merge guard.
- Locales — n/a (developer-facing tooling, English by design).
- Accessibility — n/a (no UI).
- Contract — `scopeCheck`/`validateLane` return shapes unchanged; new refusal strings documented in design §4.
  `governanceMergeAllowed` still returns `{ok:true}` / `{ok:false, reason}` with the same union.
- Staging proof — not verified on staging: developer tooling, no deployed surface. Proven by `node --test
  scripts/collab/queue.test.mjs` (new cases red-on-base captured in the PR body) and the gateway Jest suite.
- Reviewer — the trusted-source read (never head), that `lane_admin` is pinned to trusted, that protected-gate and
  seat-ownership refusals are unchanged, and that every existing test still passes.

<!-- lane: rules -->
## Lane `rules`
- [ ] R1 `.claude/rules/collaboration.md` §3a + §7b: protected-gate authority → "the owner's instruction naming the
      plan plus a reviewer-agent accept on the current head"; §7/§7a: one sentence on the authorized `lane_admin`
      reviewer-agent lane-administration path (seat reassignment + path narrowing, preserving seat ownership, scope,
      independent review). (design §6)
- [ ] R2 `CLAUDE.md` (platform) protected-gate sentence → Claude-free wording.
- [ ] R3 `vitana-v1/CLAUDE.md` — byte-identical mirror of R2 (carried in a sibling vitana-v1 PR of this lane;
      sha256 in PR body).
- [ ] R4 `.kiro/pipeline/common-rules.md` rule 4 + `.kiro/steering/vitana-owner-autonomy.md` stop #3 → Claude-free
      wording.
- [ ] R5 Confirm `scripts/ci/kiro-steering/guard.cjs` green and `node scripts/collab/queue.mjs validate` green;
      `vitana-collaboration.md` stays a `#[[file:]]` link (no body edit).

**Acceptance:**
- Change types: Tooling/docs.
- Outcome — every rule, steering and doc file states the Claude-free protected-gate authority and the new lane-admin
  path consistently with the enforcement; no file still says "legacy claude review" is an option.
- States — n/a.
- Surfaces — the loaded rule files a session reads (`collaboration.md`, both `CLAUDE.md`, `common-rules.md`,
  `vitana-owner-autonomy.md`).
- Locales — n/a (developer-facing rules, English by design).
- Accessibility — n/a.
- Contract — text only; `collaboration.md` identical across both repos; the two `CLAUDE.md` protected-gate sentences
  byte-identical (sha256 in PR body).
- Staging proof — not verified on staging: documentation. Proven by the steering guard + `queue.mjs validate` green
  and the byte-identical sha256 check.
- Reviewer — wording matches the enforcement lane exactly; no behavioural claim the code does not make; the
  `#[[file:]]` twin untouched.
