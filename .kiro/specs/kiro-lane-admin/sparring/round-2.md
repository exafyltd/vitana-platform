# Sparring round 2 — in_progress

Session: `7bf26903-b794-418f-9ddf-9567453ee4f7` · plan hash `e403d40266a1e9a55a412bbf964161b024736a6555f9819865ac722aae20a002`

## Summary

All four R1 findings were accepted and substantively addressed in the revised plan. Two new issues found: (1) a type mismatch in the `lane_admin` comparison that would make the entire mechanism dead on arrival, and (2) a missing `fetchPlanLane` parameter in `validateRange` that prevents the shared helper from resolving the full trusted-source chain the plan describes.

## Findings

### R2-F1 [blocker]

The plan specifies `trustedFm.lane_admin === true` (JavaScript boolean) as the gate condition. `parseFrontMatter` (lines 150-168) is a minimal YAML parser that returns ALL scalar values as strings — `lane_admin: true` in YAML front matter becomes `fm.lane_admin = 'true'` (the string). In JavaScript, `'true' === true` is `false` (strict equality, different types). The `selfTrustedLaneAdmin` condition, the `laneAdminCovers` helper, and the `validateLane` marker check would ALL silently evaluate to `false` for every lane file that carries `lane_admin: true`. The entire lane-admin mechanism would be dead on arrival — no admin lane would ever be recognized.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:149` — /** Minimal YAML front matter: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
export function parseFrontMatter(text) {
  ...
      else out[kv[1]] = clean(v);
  ...
}

function clean(s) {
  const t = String(s).trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

Suggestion: Use string comparison everywhere: `trustedFm.lane_admin === 'true'` (and similarly in `validateLane` and `laneAdminCovers`). Alternatively, add a `toBool` helper (`const toBool = v => v === true || v === 'true';`) and use that consistently. Add a test case that fails if the comparison is changed to boolean strict equality.

### R2-F2 [major]

The plan says `laneAdminCovers` (the shared helper in `validateRange`) resolves the admin lane's trusted front matter via 'merge-base / qualifying plan( PR / other-repo main'. But `validateRange` (line 528) accepts only `fetchLane`, not `fetchPlanLane`. Its CLI call site (line 967-968) passes only `fetchLane`. `scopeCheck` (line 628) accepts both `fetchLane` and `fetchPlanLane`, and its CLI call site (line 997) passes both. Without `fetchPlanLane`, the `laneAdminCovers` helper in `validateRange` cannot resolve the plan-PR trusted-source fallback, so a new admin lane whose file exists only in a qualifying `plan(` PR (not yet on main or in merge-base) would be unrecognised by Collab handoff, even though Lane scope would recognise it.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:528` — export function validateRange(repo, { base, head, branch = '', allowInitial = [], fetchLane = null }) {
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:628` — export function scopeCheck(repo, { base, head, branch = '', fetchLane = null, fetchPlanLane = null }) {
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:967` — const r = validateRange(repo, { base: args.base, head: args.head, branch: args.branch || '', allowInitial,
        fetchLane: args['lane-repo'] ? ghFetcher(args['lane-repo']) : null });
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:991` — if (cmd === 'scope-check') {
      ...
      const fetchPlanLane = planFetchers.length ? (slug, p) => { for (const f of planFetchers) { const x = f(slug, p); if (x) return x; } return null; } : null;
      const r = scopeCheck(repo, { base: args.base, head: args.head, branch: args.branch || '', fetchPlanLane,
        fetchLane: args['lane-repo'] ? ghFetcher(args['lane-repo']) : null });

Suggestion: Either (a) add `fetchPlanLane` to `validateRange`'s signature, thread it from the CLI `validate` command the same way `scope-check` does, and use it in `laneAdminCovers` — keeping the trusted-source chain symmetric between both checks; or (b) explicitly limit the `validateRange` helper to merge-base + `fetchLane` and document that an admin lane must be on main (or the other repo) before its first admin PR (the plan-PR fallback is not available in Collab handoff). Either way, update the plan text to match.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
