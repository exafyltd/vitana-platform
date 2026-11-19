# Sparring round 1 — in_progress

Session: `7a80327a-1275-425e-806b-6303a634e352` · plan hash `424b0e0a8eb4843b52e1e477b3e14bc08ff3c529f0355fabf6558e5307f2cb54`

## Summary

The plan's analysis of the seven unauthenticated routes and the proposed gates is well-researched and mostly accurate against the pinned code. All premises I could verify in the gateway route files, middleware, and deploy script hold. The critical gap is that app.js exceeds 1MB and is unreadable by the review tooling, so the 8+ caller-specific premises (line numbers, headers sent, buildContextHeaders usage) cannot be independently verified. The proposed static tests partially mitigate this, but the plan should strengthen caller enumeration evidence. One scoping inconsistency around the triage stream GET route exists.

## Findings

### R1-F1 [major]

The plan makes 8+ specific line-number claims about callers in app.js (lines 1218, 10054-10057, 17974, 18009, 18512, 28673, 30433) including which headers each caller sends and whether they use buildContextHeaders. app.js exceeds 1MB and cannot be read by the review tooling, so none of these premises are verifiable. If an unlisted caller of any of the seven routes exists in app.js (or elsewhere), it will silently break when auth is added. The proposed static test only checks for header-name absence, not caller completeness.

- `exafyltd/vitana-platform:services/gateway/test/command-hub/vtid-05122-spec-approve-route.test.ts:14` — const HUB = path.resolve(__dirname, '../../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');

Suggestion: The lane should include in its evidence (e.g. in commands.log or the validation directory) the output of a grep for each of the seven route paths against the full app.js at the pin, demonstrating every caller is enumerated. The proposed gateway-write-route-auth-callers.test.ts should also assert, for each route path (e.g. '/api/v1/agents/triage/investigate'), the exact number of fetch/call sites found in app.js matches the expected count, not just check for header absence.

### R1-F2 [minor]

The plan states the triage stream route (GET /api/v1/agents/triage/:sessionId/stream, triage-agent.ts:351) is 'listed by the inventory', but the write-route-inventory lane scope is explicitly 'every POST/PUT/PATCH/DELETE route'. A GET route falls outside that scope. Once POST /investigate requires auth, the unauthenticated GET stream becomes the residual information-leak surface: anyone who obtains or guesses a session_id can read investigation results containing OASIS events without authentication.

- `exafyltd/vitana-platform:services/gateway/src/routes/triage-agent.ts:351` — triageAgentRouter.get('/:sessionId/stream', async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    // Set up SSE headers up front — same shape for both router and Anthropic paths.
    res.setHeader('Content-Type', 'text/event-stream');

Suggestion: Either (a) expand the inventory scope to include unauthenticated GET routes that serve data produced by a now-authed write route, or (b) add the triage stream route to the route-auth lane alongside the POST investigate gate (same requireAdminOnly), or (c) at minimum note it explicitly as a 'proposed follow-up' in the inventory with a severity rationale.

### R1-F3 [minor]

The proposed static caller test asserts that app.js contains no 'x-actor-role' and no 'x-actor-id' (following the VTID-05122 pattern of literal string matching against the entire file). In a 1MB+ file with comments, logging, and UI strings, these exact quoted strings could appear in non-header contexts (e.g. an audit log label or display string), causing a false positive test failure that blocks the lane.

- `exafyltd/vitana-platform:services/gateway/test/command-hub/vtid-05122-spec-approve-route.test.ts:39` — it('app.js sends no x-user-id / x-user-role headers', () => {
      expect(APP_JS).not.toContain("'x-user-id'");
      expect(APP_JS.toLowerCase()).not.toContain("'x-user-role'");
    });

Suggestion: If possible, scope the assertion more tightly: extract the fetch call sites for the two LLM routing-policy endpoints and assert the headers object within those call sites does not contain x-actor-role / x-actor-id, rather than asserting global absence across the entire file. Alternatively, first confirm via grep that the quoted strings appear only in the header-setting context being removed.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
