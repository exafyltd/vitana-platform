---
slug: spotlight-compact-hero
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
spar_refs:
  - exafyltd/vitana-v1: main
updated: 2026-10-31T12:40Z
---

# Handoff — spotlight-compact-hero

Compact the oversized desktop Spotlight hero on the `dashboard` archetype into a short
horizontal band (~1/3 of today's height) and add a denser bento grid of medium `standard` cards
below it, as a design-contract change applied to every `dashboard` screen. Behind the existing
`desktop_spotlight` flag. Code change lives in `exafyltd/vitana-v1`; this plan PR is on
`exafyltd/vitana-platform` so CI PLAN-SPAR can spar it.

`spar_refs` pins `exafyltd/vitana-v1` at `main` so the PLAN-SPAR partner resolves it to the
current `origin/main` SHA (GitHub commits API) and reads the real Spotlight components the plan
cites (`plan-spar.mjs` `resolveRef` / `extra_refs`).

## Log

### 2026-10-28T13:27Z · kiro-202610152203-0347 · drafted
Authored the spec (requirements.md, design.md with vitana-v1 file:line, tasks.md, plan.md) and
claimed `spotlight-compact-hero/_plan`. One lane `compact-hero-grid` (the change is a single
file-coupled unit — shared `tier-b` components + the `dashboard` skeleton + the contract doc +
the four dashboard pages all touch the same surface, so splitting would make lanes edit the same
files, §8a). Decisions recorded in plan.md: D1 fold the "Up Next" rail into the bento grid (no
dashboard page has a rail today); D2 keep the compact hero as the single `spotlight` VCard in a
media-less compact presentation so SR-06/SR-07 and the vtid-05111 / staging checks stay
unchanged; D3 no new size token proposed (existing 4px scale, type scale and `TIER_B_GRID`
3-col cover it) — a new hero-band height token would be a flagged contract addition only if the
~1/3 height proves impossible without a fixed-height utility, which the design avoids.
Next: open the `plan(spotlight-compact-hero)` PR and drive CI PLAN-SPAR to convergence; CI
allocates the lane VTID on convergence (never by hand).

### 2026-10-31T12:40Z · kiro-202610152203-0347 · drafted (round 1 answered)
PR https://github.com/exafyltd/vitana-platform/pull/4517. Round 1 answered in
`sparring/responses-1.md`: R1-F1 accepted (D1 revised — My Journey's existing `JourneyRail` is
KEPT unchanged; no rail added elsewhere; "Up Next" folds into the grid on the rail-less
dashboards), R1-F2 rejected with evidence (the staging design-lint spec exists on vitana-v1
origin/main), R1-F3 accepted (composition test tightened, step 6), R1-F4 accepted (line refs
corrected against vitana-v1 847a9f68). Added D4 (grid uses only existing page data).
