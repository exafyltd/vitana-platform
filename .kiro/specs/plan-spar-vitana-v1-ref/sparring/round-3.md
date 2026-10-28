# Sparring round 3 — converged

Session: `b9c548f7-6f0e-4151-81f1-48a0b8a42d85` · plan hash `6a194d827ee90b578d546bc26d5c7cf36d9939a0d6d008a13f7ccf5bd0e02ae7`

## Summary

Both accepted findings (R2-F1, R2-F2) are properly addressed in the revised plan text. Two new minor findings are raised: (1) `parseFrontMatter` stores block-list items as plain strings, so the proposed `- exafyltd/vitana-v1: <sha>` format does not produce a map — `parseSparRefs` must split each string element on `: ` and the plan never says so; (2) the plan never states the implementing lane must declare `executor: claude`, which is required by the governance enforcement in `queue.mjs` for any path under `scripts/collab/**`.

## Findings

### R3-F1 [minor]

`parseFrontMatter` (queue.mjs:110-111) stores every block-list item as a plain string via `clean(item[1])`. The front-matter shape the plan proposes:

```yaml
spar_refs:
  - exafyltd/vitana-v1: <40-hex-sha>
```

will be parsed into `{ spar_refs: ['exafyltd/vitana-v1: <40-hex-sha>'] }` — a string array, not a `Record<string,string>` map. The plan says `parseSparRefs(handoffFrontMatter)` is a 'pure exported' function but never describes what it must do with this string array. An implementer familiar with standard YAML would expect a list of single-key objects from the `- key: value` syntax; `parseFrontMatter`'s minimal parser does not implement that. If the implementer writes `parseSparRefs` expecting the parsed field to already be a map (e.g. using `Object.entries(fm.spar_refs)`), or spreads the array directly into `extra_refs`, the gateway's repo-key allow-list check at `validateCreateInput:112` will 400 loudly — but only at runtime, not at parse time. The test suite would catch it only if the integration test drives the full path from a real handoff.md through `parseFrontMatter` into `parseSparRefs`.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:110` — const item = /^\s+-\s+(.*)$/.exec(raw);
if (item && listKey) { out[listKey].push(clean(item[1])); continue; }
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:112` — const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:28` — import { parseFrontMatter } from './queue.mjs';
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:112` — if (!(PLAN_SPARRING_REPOS as readonly string[]).includes(k) || typeof v !== 'string' || !SHA_RE.test(v)) {
  throw new SparringError(400, 'extra_refs_invalid');
}

Suggestion: Add one sentence to the Scope section: '`parseSparRefs` receives the object returned by `parseFrontMatter`; it reads `fm.spar_refs` as a string array (each element of the form `"repo: sha"`), splits each element on the first `": "` occurrence to extract the repo key from the SHA value, and returns `Record<string,string>`.' Alternatively, adopt a `repo@sha` delimiter (e.g. `- exafyltd/vitana-v1@<sha>`) which avoids confusion with YAML key-value syntax and requires a simpler split on `@`. Also ensure the integration test constructs a real `handoff.md` string and passes it through `parseFrontMatter` → `parseSparRefs` end-to-end, rather than injecting a pre-built map.

### R3-F2 [minor]

The plan changes `scripts/collab/plan-spar.mjs` and `scripts/collab/plan-spar.test.mjs`. `scripts/collab/**` is listed as a `GOVERNANCE_PATH` in `queue.mjs:69`, and `validateLane` (queue.mjs:180) rejects any lane with `executor: kiro` that declares a path touching governance. The plan never states that the implementing lane must carry `executor: claude`. If the implementer creates the lane without that declaration, scope-check will fail at PR merge time and block the implementation.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:69` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:180` — if (fm.executor === 'kiro') for (const g of paths) if (globTouchesGovernance(g)) e.push(`paths "${g}" reaches a governance path; such a lane needs executor: claude`);

Suggestion: Add one sentence to the Scope section or Out-of-scope/lane declaration: 'The implementing lane must declare `executor: claude` because `scripts/collab/**` is a GOVERNANCE_PATH (queue.mjs:69); a lane with `executor: kiro` that declares any path under that prefix is rejected by scope-check.'

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The revised plan now unambiguously places the handoff.md read, parseSparRefs call, merge, resolveRef call and fail-loud throw inside step()'s `if (!cur || retryInfra || replan)` create branch, and explicitly notes that doing this in main() would re-introduce the R1-F3 bug. main() is stated to remain unchanged (passes CLI-arg map or null as extraRefs). The fix is complete and correctly described.
- R2-F2: acknowledged — The revised Scope section now explicitly states that if handoff.md does not exist when step() enters the create branch, parseSparRefs returns {} and no error is thrown, with the existsSync guard matching the pattern used in the converged/escalated write-back paths at lines 258 and 274 (confirmed by code). The fix is complete.
