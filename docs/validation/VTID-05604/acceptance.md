# VTID-05604 acceptance (staging-verify-manifest-repair / pm-mode-probes)

AC-1 The VTID-05277 and VTID-05281 mode probes expect enabled true and executor_mode kiro_fallback, the state the owner set on staging.
TEST: outputs/after-green.txt: both probes green against the live staging gateway (GET only).

AC-2 Before the change, the probes pinned claude_primary and failed against the live state.
TEST: outputs/baseline-red.txt: enabled true and kiro_fallback against the old expectation of enabled false and claude_primary.

AC-3 Only the mode probe's name, expected JSON and reason change in each of the two manifests.
TEST: commands.log: git diff of the two manifests (6 lines each).
