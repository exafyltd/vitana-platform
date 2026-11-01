# Sparring round 1 — in_progress

Session: `d8ea433f-3c3d-4904-a956-e8b8976b89ab` · plan hash `c88a6d1df6403edf00ef19e50d48f23408ef6120d76f54dd841b141e5a92ea61`

## Summary

The plan is thorough and well-structured. All major premises about the existing codebase that I could verify hold true: ScreenFrame rendering order, archetype widths, CSS tokens and `.sp-grid` rules, VCard/VCardSkeleton structure, ArchetypeSkeleton shapes, SpotlightLoading delegation, all four page structures (Health, Discover, Events, FindPartner), useSpotlightEnabled logic, and sidebar width. The opt-in approach via `layout="spotlight-grid"` prop and reuse of the existing `full` width token are sound. Lane isolation looks correct — no file appears in two lanes. I have one major finding about a staging-test selector premise I could not verify, and one minor internal wording inconsistency.

## Findings

### R1-F1 [major]

The plan states that `[data-header-density="compact"]` is an existing chrome selector (referencing `StandardHeader.tsx:55,64,80`) and multiple staging specs assert its presence. I could not locate `StandardHeader.tsx` inside `src/components/layout/spotlight/` (404), and the approximate search for `data-header-density` across the repo returned zero hits. If this data attribute does not exist on the rendered DOM today, every staging spec that queries it will fail. The plan must confirm the exact file path and that the attribute is actually emitted, or fall back to a different selector.

- `exafyltd/vitana-v1:src/components/layout/spotlight/ScreenFrame.tsx:101` — <StandardHeader
  density="compact"
  title={header.title}
  description={header.description}
  emoji={header.emoji}
  syncTimestamp={header.syncTimestamp}
  className="mb-3"
/>
- `exafyltd/vitana-v1:src/components/layout/spotlight/index.ts:1` — // StandardHeader is not exported from this barrel — it is imported by ScreenFrame but its source path is not visible here.

Suggestion: Verify the actual file path of StandardHeader (likely outside `layout/spotlight/`), confirm it renders `data-header-density={density}` on its root element, and correct the line references in the plan. If the attribute is absent today, either add it in the `layout-core` lane or choose a different staging selector.

### R1-F2 [minor]

Rule 2 in the Goal section states the spotlight card is 'never more than ~45% of the content area' without qualifying viewport width. However, D3 specifies that between lg (1024px) and xl (1280px) the spotlight is `col-span-2` of a 4-column grid, i.e. 50%. SR-26 correctly scopes the 45% cap to '≥1280 px'. The unqualified statement in rule 2 could mislead implementers or test authors into asserting ≤45% at all viewports, which would fail in the 1024-1279 band.

- `exafyltd/vitana-v1:src/index.css:424` — .sp-grid {
  display: grid;
  grid-template-columns: minmax(0, var(--sp-stage-max));
  justify-content: center;
  gap: var(--sp-gap);
}
...
.sp-layout[data-width="full"] .sp-grid {
  grid-template-columns: minmax(0, 1fr);
}

Suggestion: Qualify rule 2: 'never more than ~45 % of the content area at ≥ 1280 px (up to 50 % between 1024 and 1279 px)', matching the SR-26 wording.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
