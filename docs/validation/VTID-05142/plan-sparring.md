# Plan sparring record - VTID-05142

Plan hash (sha256 of the text between the plan markers, trimmed): `ad9c823dbf7413c442936328c5c265231f0016694a0e394d2745f6db02e61171`. Partner: plan-sparring-partner (read-only, independent), 2 rounds, CONVERGED (light class). Owner approval: in session 2026-10-13, "yes, go ahead, let's set it up finally" in answer to the Gate 1 message (final plan, both rounds' findings, the files, the test plan). The gate is in log mode; the session is recorded here and in the ledger row.

Round 2 (partner, summary): F1-F6 and Q1/Q2 closed; no new findings; verdict CONVERGED.

# Plan: mark update_business and update_product as destructive tools (OpenAI plugin review finding)

Change class: light (one source file and two test files; no migration, route, auth, deploy or governance file)
Repo: exafyltd/vitana-platform
Scope (files): services/gateway/src/services/commerce-mcp.ts, services/gateway/test/vtid-04940-commerce-mcp-supplier-data.test.ts, services/gateway/test/vtid-04969-commerce-mcp-openai-metadata.test.ts, docs/validation/<VTID>/*

<!-- plan:begin -->
## Problem (verified 2026-10-13 in OpenAI's plugin portal)
After the package declared OAuth (VTID-05135/05140 diagnostics plus the v6 package), the portal's scan connected and listed all nine Commerce tools. It reported one finding on each of two tools, verbatim:
- `update_business`: "This tool is marked destructiveHint: false, but its behavior appears to cause material loss or a hard-to-reverse change."
- `update_product`: the same text.
These findings keep the plugin from being submitted cleanly. The cause is in our own tool catalogue: `services/gateway/src/services/commerce-mcp.ts:94-99`, `hints()` returns `destructiveHint: false` for every tool, with the comment (lines 86-93) that our writes "only create or overwrite DRAFT data that another call restores". The two flagged tools overwrite existing values in place: `update_business` replaces the legal name, country, website and VAT ID (and per its own description, changing website, country or VAT ID after verification passed makes verification run again, which is why it has a `confirmed` input); `update_product` replaces the product's title, description, price, currency, link, image, shipping and availability. Neither keeps the previous value, so "another call restores it" holds only if the caller still knows the old value.

## Change
1. `hints()` gains an optional `destructive?: boolean` (default false, so every other tool is byte-for-byte unchanged) and emits `destructiveHint: h.destructive === true`.
2. `update_business` and `update_product` are declared with `destructive: true`; `create_business`, `add_product`, `check_verification`, `connect_store`, `submit_for_verification`, `get_onboarding_status`, `list_products` keep `destructiveHint: false`.
3. The comment on `hints()` is corrected: the destructive hint is true for the two tools that overwrite existing values in place (an overwrite loses the previous value), false for tools that only create, read, run checks or submit.
4. No change to any tool's behavior, input schema, description, `confirmed` handling, security schemes or the other annotations.

## Tests (Jest, run by the gateway CI job)
- `vtid-04969-commerce-mcp-openai-metadata.test.ts`: the "nothing is destructive" assertion (line 40) becomes "exactly `update_business` and `update_product` are destructive", and the test's name (line 37) is updated to say so; the all-three-hints-are-booleans, read-only and open-world assertions stay as they are;
- `vtid-04940-commerce-mcp-supplier-data.test.ts`: in the `test.each` over all tools, only the assertion inside the `if (readOnlyHint === false)` branch (line 132, `destructiveHint` must be `false`) changes: it expects `true` for `update_business` and `update_product` and `false` for the other write tools; the `readOnlyHint` boolean check and the title/description checks stay;
- `vtid-04941-commerce-mcp-automation.test.ts` (`check_verification` and `connect_store` annotations) and `vtid-05133-community-mcp-tools.test.ts` (Community tools, a different catalogue) need no change and must stay green;
- no new snapshot assertion: the existing name-list assertion (`vtid-04940`, the exact tool names) already covers the names, and the diff touches no description or input schema (checked in review). `vtid-04941` asserts annotations only for `check_verification` and `connect_store`, whose values do not change.

## Staging evidence
`staging-tests.json`: an `existing` entry `npx jest test/vtid-04969-commerce-mcp-openai-metadata.test.ts test/vtid-04940-commerce-mcp-supplier-data.test.ts test/vtid-04941-commerce-mcp-automation.test.ts` (cwd services/gateway) plus two read-only GETs of the two ChatGPT discovery documents on staging (200), as a smoke check only: `tools/list` needs a signed-in caller, so the served hint values are proven by the Jest suites, not by an anonymous staging request. The real proof is after the production deploy: the owner presses Rescan in OpenAI's portal and the two findings must be gone.

## Rollout
PR -> CI -> merge -> staging deploy -> STAGING-VERIFY -> Gate 2 -> promote the verified commit pinned. Rollback: revert the PR.

## Risks and what it accepts
- A client that honors `destructiveHint` may ask the supplier to confirm each call of `update_business` and `update_product` (ChatGPT and Claude both treat destructive tools more cautiously). This is the intended trade: it matches what the tools do, and the supplier is the one being asked about their own data.
- The hints are metadata only. The services behind the tools, the access checks, the `confirmed` rules and the draft-only rule for products are unchanged.
- Claude's connector (`/mcp`) reads the same catalogue, so it gets the same two hints; there is no behavior change beyond the client's own confirmation prompt.
- The Community MCP (`services/gateway/src/services/community-mcp.ts`) has its own read-only catalogue and is not touched.

## Non-goals
No change to tool behavior, descriptions or schemas; no change to the plugin package; no change to OAuth, discovery or the diagnostic probes.
<!-- plan:end -->

## Planner responses (round 1)
- F1 [minor]: NOTED. Same optional-boolean pattern as `openWorld`; no change.
- F2 [minor]: ACCEPTED. The plan now names the exact assertion (line 132, inside the `readOnlyHint === false` branch of the `test.each` over all tools).
- F3 [minor]: ACCEPTED. The scope line now says "one source file and two test files", no count claim.
- F4 [minor]: ACCEPTED. The staging section says the two GETs are a smoke check and that the served hint values are proven by Jest and, after production, by the owner's Rescan; `tools/list` needs a signed-in caller.
- F5 [minor]: NOTED. Metadata-only, no type-level impact (`as const` unchanged).
- F6 [minor]: ACCEPTED. Confirmed in the code and written into the plan: `vtid-04941` asserts annotations only for `check_verification` and `connect_store`, whose values are unchanged.
- Q1: the test name at `vtid-04969` line 37 is updated with the assertion. Q2: dropped as redundant; no new assertion. The existing name-list test covers names, and no description or schema is touched by the diff.
