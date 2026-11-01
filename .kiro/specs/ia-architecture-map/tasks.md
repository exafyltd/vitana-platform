# Tasks — ia-architecture-map
Authoritative plan: `plan.md`. VTID from CI PLAN-SPAR. Lane in `exafyltd/vitana-platform`. Branch
`kiro/ia-architecture-map/map-doc`; PR title `VTID-xxxxx (ia-architecture-map/map-doc): …`; trailers `Collab-Session` +
`Collab-Lane: ia-architecture-map/map-doc`; identity `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: map-doc -->
## Lane `map-doc`
- [ ] M1 Add the `docs/CONTEXT-MAP.md` row first and record `node scripts/dev/context.mjs check` red on the lane base
      (dead link to the not-yet-written README).
- [ ] M2 Write `docs/validation/<VTID>/check-refs.mjs`: for every backticked `path:line` in the published files,
      the path exists on the lane base and the line is within the file; print each failure. Run it over
      `.kiro/specs/ia-architecture-map/assessment/` and record the drift list.
- [ ] M3 Publish `docs/architecture/integrated-architecture/README.md` (the map, plan §3.2) and A–G from
      `assessment/`, with each drifted reference corrected and each section's pin stated. Authorization findings point
      to `mt-track-s-authz` only.
- [ ] M4 Re-run M2 over the published folder (zero failures) and `context.mjs check` (zero errors); `node --test
      scripts/dev/context.test.mjs` green. Record the outputs.
- [ ] M5 `docs/validation/<VTID>/staging-tests.json` with an `existing` reference to the M4 run.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: an engineer or agent opens one folder and finds how identity, tenant, role, working context and permissions
  flow through the ORB, memory, execution and autonomy code, with links that resolve on `main`, and the order in which
  the IA plans follow the multi-tenant plans.
- States: n/a: documents only.
- Surfaces: readers of `docs/`; `docs/CONTEXT-MAP.md` lookups; `context.mjs check` in `UNIT.yml`.
- Locales: n/a: internal engineering documents in English.
- Accessibility: n/a: no UI.
- Contract: `context.mjs check` reports zero errors; the reference check reports zero unresolved `path:line`.
- Staging proof: not verified on staging: documents deploy nothing; the checks above are referenced as `existing`.
- Only the lane `paths` change; no code, rule file or multi-tenant spec is edited; no description of an open
  authorization finding beyond a reference to `mt-track-s-authz`.
