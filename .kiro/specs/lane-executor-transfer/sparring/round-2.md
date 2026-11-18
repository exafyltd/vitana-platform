# Sparring round 2 — converged

Session: `9ded0bb1-7922-4036-a161-933a50fd5379` · plan hash `a652316bdcb1376b9968dc47dfd4ee2a91d33761fe0cccfe3850f8bfd1a16b24`

## Summary

All five R1 findings were accepted by the planner and the revised plan addresses each one:

- R1-F1 (scopeCheck carve-out): Plan §6b now describes the scopeCheck carve-out for `executor` and `next_actor` only, keyed on a transfer entry from the claim holder. Tests g, h, i added. Addressed.
- R1-F2 (multi-builder seat check): Plan §6c now describes the validateRange seat-check carve-out after a transfer entry. Test j added. Addressed.
- R1-F3 (lane_admin analogy): Plan now explicitly names the mechanism a "self-transfer carve-out" distinct from lane_admin, and the reseat analogy is removed from the reasoning. Addressed.
- R1-F4 (missing scopeCheck tests): Tests g, h, i, j now cover scopeCheck and multi-builder scenarios. Addressed.
- R1-F5 (wrong §/line reference): Corrected to §5 line 164. Addressed.

**Repository access blocked:** Every `read_file` and `list_dir` call against the pinned commit (817e1d3e) returned HTTP 403 throughout this round. I was therefore unable to verify new premises or produce new file-cited findings. The observations below are based on plan-text analysis only and could not be elevated to properly-cited findings. The plan should be re-sparred if access is restored before implementation.

Observations (uncitable, for the planner's consideration):
1. The plan's rollback section (§8) acknowledges that reverted code won't have the transfer carve-out but defers verification to "F7" which is not defined elsewhere in the plan. If a transferred lane needs re-validation after rollback, it would fail both scopeCheck and validateRange.
2. §6a says validate "accepts a claim by a session of the new executor only when ... its next_actor matches." But §2(ii) allows next_actor to be set to "owner" as an alternative. The plan should clarify whether next_actor=owner is a valid transfer target for the validate check.
3. The plan declares standard change class but does not state its own VTID.
4. No OASIS event is defined for the transfer action. If lane lifecycle events are expected to be tracked, this may be a gap.

## Findings

_none_