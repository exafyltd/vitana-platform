# VCAOP — BLOCKERS (external dependencies)

> External deps (creds/approvals/IAM/unverified tools), the mock path taken, and
> what a human must supply. Logged per runbook Sec. 11.1 / 11.3.

| ID | VTID | Blocker | Mock path taken | What a human must supply |
|----|------|---------|-----------------|--------------------------|
| BLK-001 | env / all deploys | No dev Supabase project/branch connection details or `*-dev` Cloud Run deploy permission present in this session's environment. | `env-boundary` built + unit-tested against synthetic targets; no live deploy attempted. | A reachable dev environment: dev Supabase project/branch URL + service role, and permission for `*-dev` Cloud Run deploys, with connection details in the agent's env. Until then, deploy steps are mocked. |

| BLK-002 | CONN-API-0002 | Vendor SDK/auth models (Amazon SP-API, eBay, Walmart, CJ) not independently verified against official docs in this environment (no confirmed outbound access to vendor docs); also gated behind real credentials. | Built `ApiConnector` against a swappable `ApiClient` interface with **mock** provider stubs; no live calls, none in CI. | A human verifies current SP-API/eBay/Walmart/CJ availability + auth model and supplies real credentials, then implements `ApiClient` for each behind the existing interface. |

| BLK-003 | UIC-WALLET/CART-0001/0002, UIA-CATALOG/OPS-0001/0002 | The Vitanaland community/admin **Next.js/React apps are not present in this repo** (frontend here is the static gateway command-hub; the React apps live in the separate Lovable repo). Actual UI components can't be built/verified here. | Built the framework-agnostic **view-model/presenter layer** (`src/ui/`) the components bind to — wallet, cart, admin catalog/policy editor, ops/approvals — with ownership + no-secrets/PII discipline, fully unit-tested. | A human points the build at the Vitanaland frontend app (or adds it to this session), then wires the presenters into React components and runs the visual-verification protocol. |

| BLK-004 | eBay (first integration) | eBay developer/EPN docs not independently verified here; needs real **sandbox** (then prod) OAuth creds + an EPN campaign id. | Built eBay Api/OAuth clients + EPN link decorator behind the connector interfaces, mock-only; `live` mode refuses without vault creds (no silent live calls). | (1) Create an eBay developer sandbox app → supply `EBAY_OAUTH_CLIENT_ID/SECRET` via Secret Manager; (2) apply to eBay Partner Network → supply campaign id; then I wire the live calls + flip `live`. |

_No fabricated credentials were used. No Tier-B action was taken to unblock (Sec. 11.3)._
