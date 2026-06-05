# VCAOP — BLOCKERS (external dependencies)

> External deps (creds/approvals/IAM/unverified tools), the mock path taken, and
> what a human must supply. Logged per runbook Sec. 11.1 / 11.3.

| ID | VTID | Blocker | Mock path taken | What a human must supply |
|----|------|---------|-----------------|--------------------------|
| BLK-001 | env / all deploys | No dev Supabase project/branch connection details or `*-dev` Cloud Run deploy permission present in this session's environment. | `env-boundary` built + unit-tested against synthetic targets; no live deploy attempted. | A reachable dev environment: dev Supabase project/branch URL + service role, and permission for `*-dev` Cloud Run deploys, with connection details in the agent's env. Until then, deploy steps are mocked. |

| BLK-002 | CONN-API-0002 | Vendor SDK/auth models (Amazon SP-API, eBay, Walmart, CJ) not independently verified against official docs in this environment (no confirmed outbound access to vendor docs); also gated behind real credentials. | Built `ApiConnector` against a swappable `ApiClient` interface with **mock** provider stubs; no live calls, none in CI. | A human verifies current SP-API/eBay/Walmart/CJ availability + auth model and supplies real credentials, then implements `ApiClient` for each behind the existing interface. |

_No fabricated credentials were used. No Tier-B action was taken to unblock (Sec. 11.3)._
