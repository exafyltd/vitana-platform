# Sparring round 1 — in_progress

Session: `4080da37-7961-4236-9245-12a480b7edf4` · plan hash `a1764f5478eb0825f6627f2179a94a9fbfa82f6db92c3074cc54b286fd692d30`

## Summary

The plan is well-structured and the diagnosis is accurate. All major premises about the existing code check out. One significant gap: the plan describes the new community-app checkout step for the live-stamp lookup but omits the cross-repo token it requires, which would cause a failure for community-app manual dispatches without an explicit SHA.

## Findings

### R1-F1 [major]

The plan describes two new checkout steps ('Checkout target main for live-served commit lookup (gateway)' and '(community-app)') but does not mention that the community-app variant must use `secrets.VITANA_V1_READ_TOKEN` to check out the cross-repo `exafyltd/vitana-v1`. Both the NIGHTLY workflow (line 46) and the existing community-app checkout in STAGING-VERIFY.yml (line 171) supply this token. Without it, the `actions/checkout` for `exafyltd/vitana-v1` will fail with a 403/404, making the live-stamp lookup broken for community-app service dispatches with an omitted commit_sha.

- `exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY-NIGHTLY.yml:42` —         - name: Checkout ${{ matrix.service }} history
          uses: actions/checkout@v4
          with:
            repository: ${{ matrix.repo }}
            token: ${{ matrix.service == 'community-app' && secrets.VITANA_V1_READ_TOKEN || secrets.GITHUB_TOKEN }}
            ref: main
            path: target
            fetch-depth: 0
- `exafyltd/vitana-platform:.github/workflows/STAGING-VERIFY.yml:166` —         - name: Checkout commit under test (community-app)
          if: env.SERVICE == 'community-app'
          uses: actions/checkout@v4
          with:
            repository: exafyltd/vitana-v1
            token: ${{ secrets.VITANA_V1_READ_TOKEN || secrets.GITHUB_TOKEN }}
            ref: ${{ env.SHA }}
            path: target
            fetch-depth: 0

Suggestion: Explicitly state in the plan that the new 'Checkout target main for live-served commit lookup (community-app)' step must specify `token: ${{ secrets.VITANA_V1_READ_TOKEN || secrets.GITHUB_TOKEN }}` (matching the pattern of STAGING-VERIFY-NIGHTLY.yml line 46 and the existing community-app checkout at STAGING-VERIFY.yml line 171). The test in `workflow.test.cjs` should also assert this token is present on the new community-app checkout step.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
