# Tasks — plan-spar-vitana-v1-ref

<!-- lane: wire-extra-refs -->
## Lane: wire-extra-refs

Forward a per-plan companion `vitana-v1` ref into PLAN-SPAR so a cross-repo plan can be sparred
against both repos. Governance-path lane (`scripts/collab/**` + `.github/workflows/PLAN-SPAR.yml`) —
`executor: claude`-class paths; built in this Stage A lane.

- [ ] T1 — `scripts/collab/plan-spar.mjs`: add `const PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform',
  'exafyltd/vitana-v1'];` with a comment pinning it to `services/gateway/src/services/plan-sparring/github-tools.ts:21`
  as the source of truth (the gateway re-validates regardless, `plan-sparring-service.ts:112`).
  Acceptance (FR5): the const matches the gateway list; a drift fails loudly server-side.

- [ ] T2 — `scripts/collab/plan-spar.mjs`: add the pure exported `parseSparRefs(fm)` — returns
  `[[repo, ref], …]` from `fm.spar_refs`, each entry an anchored `^\s*([^:\s]+)\s*:\s*(\S+)\s*$`
  match (fail-loud `Usage` on a malformed / inline-commented / multi-token entry, per
  `parseFrontMatter`'s block-list behavior at `queue.mjs:111`/`:114`); `undefined`/`null` → `[]`.
  Acceptance (AC1, AC5): `{}`→`[]`; a well-formed entry parses; an inline-commented / multi-token
  entry throws `Usage`.

- [ ] T3 — `scripts/collab/plan-spar.mjs`: add the exported `resolveRef(repo, ref, { token, fetchImpl = fetch })`
  — a 40-hex ref returned verbatim with NO network call; anything else resolved via
  `GET https://api.github.com/repos/{repo}/commits/{ref}` with `Authorization: Bearer <token>`,
  re-validating `.sha` against the 40-hex regex and throwing on non-200 / missing sha.
  Acceptance (AC3, AC4): SHA in → no fetch; branch in → one fetch, resolved sha out; non-200 → throws.

- [ ] T4 — `scripts/collab/plan-spar.mjs`: thread `token`/`fetchImpl` through `step()`/`main()` and build
  `extra_refs` ONCE before the `if (!cur || retryInfra || replan)` branch (so create/retry/replan
  forward the same ref), rejecting a disallowed repo and the plan's own `--repo` with `Usage`; spread
  `...(extraRefs ? { extra_refs: extraRefs } : {})` into the single `client.create` (`:192–195`).
  `main()` passes `token: process.env.GITHUB_TOKEN` and NEVER an injected `fetchImpl`.
  Acceptance (AC2, FR4): declared SHA → `extra_refs = { 'exafyltd/vitana-v1': <sha> }`; nothing
  declared → `'extra_refs' in body === false` (byte-identical no-op).

- [ ] T5 — `.github/workflows/PLAN-SPAR.yml`: add `GITHUB_TOKEN: ${{ secrets.PLAN_SPAR_PUSH_TOKEN || github.token }}`
  to the Spar step `env:` (the value already used for the head checkout at `:60`). The `run:` command
  line is unchanged; no new CLI arg.
  Acceptance (AC7): a plan that declares no `spar_refs` runs the workflow identically to today; no new
  secret is introduced.

- [ ] T6 — `scripts/collab/plan-spar.test.mjs`: the nine unit tests in design "Test plan"
  (no-op/byte-identical, SHA forwarded, branch resolved, disallowed repo, own-repo rejected, resolve
  failure, round reuse, `resolveRef` unit, inline-commented entry rejected), all with an injected
  `client` and a test-only `fetchImpl`; `node --test scripts/collab/plan-spar.test.mjs` green and the
  existing tests unmodified.
  Acceptance (AC1–AC6): every acceptance criterion has at least one covering test (AC→test map in
  design "Test plan").

### Done criteria
- `node --test scripts/collab/plan-spar.test.mjs` green (new + existing tests); `node --check scripts/collab/plan-spar.mjs` clean.
- No gateway change, no migration, no `vitana-v1` `src/**` change.
- F3 note: a two-repo plan's design-ratchet done-criterion cites the real vitana-v1 PR-GATE step —
  **"Design ratchet"** (`id: design`), `node scripts/ci/pr-gate/gate.mjs ratchet-design …` — not an
  invented step. This lane changes no `vitana-v1` `src/**`, so that ratchet is not exercised by it.
