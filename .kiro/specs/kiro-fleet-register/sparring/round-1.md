# Sparring round 1 — in_progress

Session: `b217b935-b8aa-4963-b856-90cc29fb0fb9` · plan hash `3a7a131530cddd7e2b6fd52b7dceb3659351c3f87270297e5f402c513df2ba81`

## Summary

The plan is well-constructed. All verified premises hold. The sequencing after VTID-05699, governance path classification, seat name constraints, and parser compatibility are all correctly analysed. One minor finding about format specification for new seat entries.

## Findings

### R1-F1 [minor]

The plan does not explicitly require that new seat entries use inline `{ key: value }` YAML format. The `loadAreas()` function in `automations.test.mjs:30` uses the regex `/^ {2}([a-z]{1,12}):\s*\{(.*)\}/` which requires curly-brace inline format. If an implementer writes new seats in multi-line YAML (e.g. `  vitanaland:\n    surface: pending`), `loadAreas` will not parse them. While no current test would fail (new seats lack `automation` so are skipped at line 63), this would create an inconsistency: `loadSeats` (queue.mjs:1194) sees the seat but `loadAreas` does not, which could break future tests that iterate all seats from `loadAreas`.

- `exafyltd/vitana-platform:scripts/collab/automations.test.mjs:29` —       const m = inSeats && /^ {2}([a-z]{1,12}):\s*\{(.*)\}/.exec(line);
      if (m) {
        seats[m[1]] = Object.fromEntries(m[2].split(',').map((kv) => kv.split(':').map((x) => x.trim())).filter((kv) => kv[0]));
      }
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1192` —     for (const line of text.split(/\r?\n/)) {
      if (/^\S/.test(line)) { inSeats = /^seats:\s*(#.*)?$/.test(line); continue; }
      const m = inSeats && /^ {2}([a-z]{1,12}):/.exec(line);
      if (m) seats.add(m[1]);
    }

Suggestion: State explicitly in section 4 that new seat lines must use the same inline `{ ... }` format as existing seats, e.g. `vitanaland: { surface: pending }`, so both `loadSeats` and `loadAreas` parse them consistently.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
