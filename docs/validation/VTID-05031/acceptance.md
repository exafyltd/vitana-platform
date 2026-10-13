# VTID-05031 — acceptance criteria (Health Hub WP3 / D2)

AC-1 Terra webhooks verify `t=…,v1=…` over `${t}.${raw}` with ±300 s tolerance, accept any matching v1, and reject tampering, a wrong secret, a stale or future timestamp and a missing t/v1.
TEST: npx jest test/vtid-05031-webhook-verification.test.ts -t "verifyTerra"

AC-2 Vital (Junction) webhooks verify the Svix scheme and pass Svix's own published test vector.
TEST: npx jest test/vtid-05031-webhook-verification.test.ts -t "verifySvix"

AC-3 DoctorBox verifies a hex HMAC of the raw body.
TEST: npx jest test/vtid-05031-webhook-verification.test.ts -t "verifyHexHmac"

AC-4 Every connector rejects every delivery when its secret is unset; no dev-mode bypass remains.
TEST: npx jest test/vtid-05031-webhook-verification.test.ts test/connectors/doctorbox.test.ts -t "fail closed|secret is unset|dev-mode"

AC-5 The route verifies over the exact bytes sent (raw-body mount before express.json()), answers 401 with a logged row on an invalid delivery, and 500 without the exception text on a handler error.
TEST: npx jest test/vtid-05031-webhook-verification.test.ts -t "POST /api/v1/connectors/webhook|raw body parser"

AC-6 No regression in the connector, webhook and partner-health suites; the gateway type-checks.
TEST: npx jest test/connectors test/vtid-05031-webhook-verification.test.ts and the suites importing connector-webhooks/connectors/partner-health; npx tsc --noEmit -p .

ROUTE_MOUNT: no new route. `services/gateway/src/index.ts` adds only a body parser, `app.use('/api/v1/connectors/webhook', express.raw({ type: '*/*', limit: '2mb' }))`, before `express.json()`, in front of the existing route `POST /api/v1/connectors/webhook/:connectorId` (`routes/connector-webhooks.ts`, mounted at `/api/v1/connectors` by `mountRouterSync`).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/connectors/webhook/:connectorId (existing URL, unchanged)
CURL_PROOF: deliberately not curled against staging or production — every POST to this route writes an audit row to `connector_webhooks_log` in the database staging shares with production (CLAUDE.md rule 48). The equivalent proof runs in-process with supertest over the same parser order: "verifies over the exact bytes sent, even when they differ from JSON.stringify" (200), invalid signature (401 + audit row), unset secret (401), handler error (500 without the message).
TEST: npx jest test/vtid-05031-webhook-verification.test.ts -t "POST /api/v1/connectors/webhook"
