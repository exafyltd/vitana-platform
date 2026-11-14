# Sparring round 1 — in_progress

Session: `fdcef6b1-8868-4258-bb5e-5d42c8c93dde` · plan hash `f010e5aa6d5bfebffd7f3d7305e45839e4b0f82e34ac909e4877aa6664cc655b`

## Summary

The plan is well-structured and the design decisions (vendor-neutral interface, flag-enforcing facade, no-op default, no external wiring) are sound for the stated goal. However, one cited premise is factually inaccurate (the `iap-decision-owner.md` `next_actor` field), and the core vitana-v1 premises (push provider pattern, remote config, iOS gate) are not verifiable in this session since only vitana-platform is pinned. I confirmed the plan's claims against the parent spec, the crash-port lane (which also references the push provider pattern), the tasks file, and the governance pipeline. No governance violations found.

## Findings

### R1-F1 [minor]

The plan states `vitana-platform:.kiro/specs/native-wave3-release-r2/lanes/iap-decision-owner.md (next_actor: owner)` but the frontmatter at line 4 says `next_actor: kiro`, not `owner`. The body text at line 26 says 'Next actor is the owner' which contradicts the metadata. The plan's parenthetical citation of the frontmatter field is inaccurate.

- `exafyltd/vitana-platform:.kiro/specs/native-wave3-release-r2/lanes/iap-decision-owner.md:1` — lane: iap-decision-owner
state: ready
next_actor: kiro
depends_on: [prereq-exit]
executor: kiro

Suggestion: Fix the citation to say `next_actor: kiro` (the current frontmatter value), or cite the body text at line 26 instead. Either way, the substance (the owner decides the payment classification) is supported by the body — just the metadata reference is wrong.

### R1-F2 [major]

The plan's core premises about vitana-v1 are unverifiable: the push provider seam pattern (`apps/mobile/src/push/provider.ts:19-31`), the remote config file (`apps/mobile/src/config/remote-config.ts:38`), the iOS IAP gate (`apps/mobile/src/screens/wallet-home/iap.ts:12-14`, `apps/mobile/src/shell/logic/drawer.ts:37-38`), and the absence of `apps/mobile/src/iap/`. Only vitana-platform is pinned in this session. Code search against vitana-v1 default branch returned zero hits for all key terms (push provider, remote-config, iapRestricted). The plan depends on copying the push provider pattern and on the remote-config flag mechanism, so if those files have different shapes or line numbers than claimed, the implementation may not match.

- `exafyltd/vitana-platform:.kiro/specs/native-wave3-release-r2/lanes/crash-port.md:25` — The pattern is that of `apps/mobile/src/push/provider.ts:53`. No SDK package is added; the vendor is owner-gated (`crash-sdk-owner`).

Suggestion: The crash-port lane in the parent spec independently references `push/provider.ts:53`, which is indirect corroboration that the file exists. However, since the interface shape (lines 19-31, 35-44, 46-55) and the remote-config layout (line 38, lines 69-71) drive the implementation decisions, the plan should either (a) be re-sparred when vitana-v1 is pinned, or (b) include the relevant code snippets inline so a reviewer without vitana-v1 access can assess the pattern claim.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
