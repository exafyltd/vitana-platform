# AP-1000: Platform Operations

> Automations for VTID lifecycle, governance compliance, deployment, and infrastructure monitoring.

---

## AP-1001 — VTID Lifecycle Automation

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | OASIS event stream |
| **Skill** | N/A (existing autopilot-controller) |

**What it does:**
The existing Autopilot Controller (VTID-01178) and Event Loop (VTID-01179) automate the full VTID lifecycle: allocation → execution → PR → validation → merge → deploy → verify → complete.

**Notes:** This is the original autopilot system. OpenClaw bridge extends but does not replace it.

---

## AP-1002 — Governance Flag Monitoring

| Field | Value |
|-------|-------|
| **Status** | `IMPLEMENTED` |
| **Priority** | `P0` |
| **Trigger** | Every OpenClaw action |
| **Skill** | OASIS bridge |

**What it does:**
Checks EXECUTION_DISARMED and AUTOPILOT_LOOP_ENABLED before any autonomous action.

**Notes:** Already implemented in OpenClaw bridge `oasis-bridge.ts`.

---

## AP-1003 — Post-Deploy Health Check

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | After any Cloud Run deployment |
| **Skill** | `vitana-platform` (NEW) |

**What it does:**
Runs automated health checks after service deployment.

**Actions:**
1. Detect deploy event in OASIS
2. Run health endpoint check with retry
3. Verify CSP compliance for frontend changes
4. Run acceptance assertions from spec
5. Report results via notification

---

## AP-1004 — Service Error Rate Alert

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P1` |
| **Trigger** | Error rate > threshold |
| **Skill** | `vitana-platform` |

**What it does:**
Monitors service health and alerts on anomalies.

---

## AP-1005 — Database Migration Verification

| Field | Value |
|-------|-------|
| **Status** | `PLANNED` |
| **Priority** | `P2` |
| **Trigger** | After migration runs |
| **Skill** | `vitana-platform` |

**What it does:**
Verifies database migrations completed successfully and RLS policies are intact.
