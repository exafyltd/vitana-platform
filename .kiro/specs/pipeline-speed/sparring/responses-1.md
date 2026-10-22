# Sparring round 1 — planner responses

Session: `64363084-889a-4b1b-a227-b0edc72ee6f4` · plan hash `5269b61a872d9c5d16d4f7e02de3b318ad2896a59bcac7e2eec40049b975a36e`
Planner: Kiro, seat `exafy`, plan author session `kiro-202610220829-5884` (continued; this round answered by the Kiro Web
automation run `kiro-exafy-202610221401-2121`, `.kiro/automations/exafy.md` item A — committed under the plan's author
session to keep `_plan` to one planner session per `collaboration.md` §3).

All four findings are accepted. They are improvement-only: none changes a quality gate, none expands scope, and each
sharpens a design decision the plan already made. The plan block in `plan.md` was updated for every one; the changes
are summarised per finding below.

## Dispositions

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed against PR-GATE.yml:72-107: the Verdict step composes exactly five checks (scope, kiro-steering, sparring, weakening, red-green). The plan's own goal is byte-for-byte CI parity, so omitting gate.mjs weakening and gate.mjs red-green broke that guarantee from day one and would silently miss two blocking failures once config.enforce flips to true. D5 now lists all five Verdict checks plus kiro-steering and the Collab tests; red-green exits early with no fix-kind VTID (PR-GATE.yml:98-100) so the added cost is negligible, and each preflight result is labelled required or 'report-only in CI (until config.enforce=true)' to track scripts/ci/pr-gate/config.json as the flag flips.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "The gated node ids are stable (lane-slot-1..6 at :82+, investigate :17, spec :42, plan-pr :48, spar-loop :55, merge-plan :70), so tying each -skip/-go watch to its node is implementable. D3 now names a required config key gatedNodeId on every skip-watch and documents the best-effort, version-sensitive field path steps[<gatedNodeId>].status inside workflow-state.json (pinned to the installed engine's real file), so the coder lane starts from a concrete recipe rather than a blank page. The watchdog-sequencing half of this finding is handled by the R1-F3 depends_on edge below.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Accepted with one correction recorded in the plan: D4 wraps the five steps in place and keeps their ids (investigate/spec/plan-pr/spar-loop/merge-plan), it does not rename or relocate them to new ids, so the finding's 'structurally relocates' overstates the change. The residual it names is real, though — a run paused mid-step (the seven in §2.8) resuming against a changed parent structure. Adopted both suggested safeguards: slot-sizing now carries depends_on: [restart-watchdog] so the watchdog that surfaces every paused/stale run is on main and in use before the workflow JSON changes shape (closing the D3->R2->watchdog gap), and the slot-sizing merge commit must record 'zero active pipeline runs at time of merge' confirmed with the watchdog tool. §5 and §6 record the ordering edge; §6 no longer claims all three lanes are fully parallel.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Node fs has no native glob, so the ~/.kiro/sessions/*/workflows/<wf id>/ pattern in §2.8/§4 cannot be read with a wildcard. D3 now states both run-gate.cjs and workflow-watchdog.mjs enumerate os.homedir()/.kiro/sessions/ with fs.readdirSync and check <dir>/workflows/<wf id>/workflow-state.json existence before reading (never a * glob), and a test fixture covers the missing-.kiro/sessions/ case so the tolerant-of-absence -> idle path is exercised rather than silently disabling D3.",
    "deferred_to": ""
  }
]
```

## Next
PLAN-SPAR runs round 2 against the updated plan block. No VTID is allocated until the session converges; CI allocates
the lanes' VTIDs on convergence.
