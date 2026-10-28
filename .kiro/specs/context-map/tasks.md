# Tasks — context-map
Authoritative plan: `plan.md` (between the plan markers). VTIDs: allocated by CI PLAN-SPAR, one per lane; never by
hand. Lane branch `kiro/context-map/<lane-id>`, PR title `VTID-xxxxx (context-map/<lane-id>): …`, trailers
`Collab-Session` + `Collab-Lane` on every commit, identity `kiro-agent[bot]`, no `Co-Authored-By: Claude`, evidence in
`docs/validation/<VTID>/` (`acceptance.md` with `AC-n` + `TEST:` lines, `commands.log`, `outputs/`,
`red-on-base.txt`, `scope.json`, `plan-sparring.md`), PR body with the VALIDATOR-CHECK declarations.

<!-- lane: context-cli -->
## Lane `context-cli` — `scripts/dev/context.mjs`, its tests, `docs/CONTEXT-MAP.md` (plan §3)
- [ ] C1 tests first in `scripts/dev/context.test.mjs` (plan §5), red on `origin/main` recorded.
- [ ] C2 `scripts/dev/context.mjs` with `route`, `screen`, `domain`, `uses`, `why`, `vtid`, `check` (plan §3.1).
- [ ] C3 `docs/CONTEXT-MAP.md` (plan §3.2), every link live (`check` exit 0).
- [ ] C4 Benchmark (plan §6) into `docs/validation/<VTID>/outputs/`; tests in a depth-1 clone without vitana-v1.

**Acceptance**
- Only `scripts/dev/context.mjs`, `scripts/dev/context.test.mjs`, `docs/CONTEXT-MAP.md`, `docs/validation/<VTID>/**`
  change. No rule, steering, hook, guard, preflight, workflow, `.claude/**`, gateway or vitana-v1 file.
- The tool is read-only: no write, no network except `gh api` behind `--prs`; zero dependencies.
- Every answer is a `file:line` or path into the source of truth; the map links, never restates rule text.
- `check`: context-map dead links and unknown commands are errors; atlas/rule/index findings are warnings; `vitana-v1/`
  links without that checkout are info.
- Every plan §5 case is a test: red on base, green on head, also in a shallow clone. Command tests use fixture
  repos; only the context-map link test reads this repo's files.
- The benchmark is reproducible from the committed script, and the numbers in the PR come from its output.
