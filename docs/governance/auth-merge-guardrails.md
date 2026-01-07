# Auth Merge Guardrails

> **Status**: ACTIVE - Enforcement Required
> **Author**: Claude (Preparation & Governance Engineer)
> **Date**: 2026-01-07
> **Purpose**: Define what is FORBIDDEN during the Lovable Auth/Supabase merger

---

## Executive Summary

This document defines the **non-negotiable guardrails** that MUST be enforced during the Lovable Auth/Supabase merger. Any violation requires immediate escalation and rollback.

---

## 1. Forbidden Actions (CRITICAL)

### 1.1 Schema Changes

| Action | Forbidden? | Reason |
|--------|------------|--------|
| DROP TABLE | **YES** | Data loss, breaking changes |
| DROP COLUMN | **YES** | Breaking existing queries |
| RENAME TABLE | **YES** | Breaking existing queries |
| RENAME COLUMN | **YES** | Breaking existing queries |
| ALTER COLUMN TYPE | **YES** | Potential data loss, query breakage |
| TRUNCATE | **YES** | Data loss |
| DELETE (bulk production) | **YES** | Data loss |

### 1.2 RLS Changes

| Action | Forbidden? | Reason |
|--------|------------|--------|
| DROP existing RLS POLICY | **YES** | Security weakening |
| ALTER POLICY to weaken | **YES** | Security weakening |
| DISABLE RLS on any table | **YES** | Complete security bypass |
| CREATE POLICY with `USING (true)` | **YES** | Bypasses tenant/user isolation |

### 1.3 Auth Changes

| Action | Forbidden? | Reason |
|--------|------------|--------|
| Modify JWT signing key | **YES** | Invalidates all sessions |
| Change JWT claim structure | **YES** | Breaks Platform identity resolution |
| Remove required JWT claims | **YES** | Breaks RLS policies |
| Create auth bypass endpoint | **YES** | Security vulnerability |
| Disable token expiration | **YES** | Security vulnerability |

### 1.4 Production Operations

| Action | Forbidden? | Reason |
|--------|------------|--------|
| Direct production DB writes | **YES** | No audit trail, no rollback |
| User migration without staging | **YES** | Irreversible if wrong |
| Auth cutover without rollback | **YES** | Users locked out |
| RLS testing in production | **YES** | Data exposure risk |

---

## 2. Mandatory Requirements

### 2.1 All Migrations Must Have

- [ ] VTID allocation before implementation
- [ ] Additive-only operations (see `additive-migration-rules.md`)
- [ ] Rollback script tested
- [ ] Staging deployment before production
- [ ] Security review for auth-related changes

### 2.2 All Auth Changes Must Have

- [ ] VTID allocation
- [ ] Security review
- [ ] Pen test for new endpoints
- [ ] Rollback strategy documented
- [ ] Downtime estimate (must be < 5 minutes)

### 2.3 All RLS Changes Must Have

- [ ] Before/after policy comparison
- [ ] Test cases proving isolation works
- [ ] No weakening of existing policies
- [ ] Documentation of new policies

---

## 3. Security Invariants (Never Violate)

### 3.1 Tenant Isolation

```
INVARIANT: User A in Tenant X MUST NEVER access data from Tenant Y

Enforcement:
- Every user-data table has tenant_id column
- Every RLS policy includes tenant_id = current_tenant_id()
- No policy uses USING (true) or USING (1=1)
```

### 3.2 User Isolation

```
INVARIANT: User A MUST NEVER access User B's personal data (unless explicitly granted)

Enforcement:
- Personal data tables include user_id column
- RLS policies include user_id = auth.uid()
- Access grants explicitly tracked in memory_access_grants
```

### 3.3 Authentication Required

```
INVARIANT: All protected endpoints MUST require valid JWT

Enforcement:
- Gateway extracts Bearer token from Authorization header
- Missing token = 401 UNAUTHENTICATED
- Invalid token = 401 UNAUTHENTICATED
- Supabase validates JWT signature and expiration
```

### 3.4 Identity Completeness

```
INVARIANT: All authenticated requests MUST have user_id AND tenant_id

Enforcement:
- me_context() RPC validates both fields present
- Missing user_id or tenant_id = 401 IDENTITY_INCOMPLETE
- RLS policies reference both fields
```

---

## 4. CSP and CORS Guardrails

### 4.1 CORS Policy

```typescript
// ALLOWED - Current origins
const ALLOWED_ORIGINS = [
  "https://vitana-dev-gateway-*.run.app",
  "https://gateway-*.run.app",
  "https://id-preview--vitana-v1.lovable.app",
];

// FORBIDDEN - Do not add without security review
// "*"                     // Allows any origin
// "http://*"              // Non-HTTPS origins
// null                    // Allows null origin (file://, etc.)
```

### 4.2 CSP Violations

```
FORBIDDEN CSP Patterns:
- script-src 'unsafe-inline'
- script-src 'unsafe-eval'
- default-src *
- frame-ancestors *
```

---

## 5. Audit Requirements

### 5.1 What Must Be Logged

| Event | Must Log? | Fields |
|-------|-----------|--------|
| Auth token issued | YES | user_id, tenant_id, role, timestamp |
| Auth token rejected | YES | reason, timestamp, IP (if available) |
| Role switch | YES | user_id, old_role, new_role, timestamp |
| RLS policy violation | YES | user_id, table, attempted_action |
| User migration | YES | lovable_user_id, platform_user_id, timestamp |

### 5.2 Audit Retention

- Auth events: 90 days minimum
- Security events: 1 year minimum
- Migration events: Permanent

---

## 6. Escalation Procedures

### 6.1 Severity Levels

| Severity | Definition | Response Time |
|----------|------------|---------------|
| **SEV-1** | Active security breach, data exposed | Immediate, all hands |
| **SEV-2** | RLS bypass discovered, no known exploitation | < 1 hour |
| **SEV-3** | Auth flow broken, users locked out | < 4 hours |
| **SEV-4** | Non-critical auth issue, workaround exists | < 24 hours |

### 6.2 Rollback Triggers

Immediate rollback required if:

- [ ] Users from different tenants can see each other's data
- [ ] Unauthenticated requests access protected data
- [ ] Production auth fails for > 5 minutes
- [ ] RLS policies disabled or weakened
- [ ] JWT validation bypassed

### 6.3 Rollback Procedure

1. **Revert migration** via rollback script
2. **Invalidate affected tokens** if auth compromised
3. **Notify users** if data exposure occurred
4. **Document incident** with root cause analysis
5. **Fix and re-deploy** with additional safeguards

---

## 7. Phase Gate Checklist

### Before Any Auth/Supabase Change

- [ ] VTID allocated and tracked in vtid_ledger
- [ ] Change reviewed against this guardrails document
- [ ] No forbidden operations in migration
- [ ] Rollback script written and tested
- [ ] Staging deployment successful
- [ ] Security review completed (for auth changes)

### Before User Migration

- [ ] Gemini analysis blueprint complete
- [ ] Lovable handover complete
- [ ] Tenant assignment strategy approved
- [ ] Role mapping approved
- [ ] Test migration on staging successful
- [ ] Rollback procedure tested
- [ ] User communication prepared

### Before Production Deployment

- [ ] All staging tests pass
- [ ] Performance impact assessed
- [ ] Rollback procedure verified
- [ ] Monitoring alerts configured
- [ ] On-call engineer assigned
- [ ] Deployment window approved

---

## 8. Forbidden Code Patterns

### 8.1 Gateway Code

```typescript
// FORBIDDEN: Bypassing auth check
router.get('/protected', async (req, res) => {
  // WRONG: No token check
  const data = await getProtectedData();
  res.json(data);
});

// CORRECT: Always check token
router.get('/protected', async (req, res) => {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  const supabase = createUserSupabaseClient(token);
  // ... RLS-enforced call
});
```

### 8.2 RLS Policies

```sql
-- FORBIDDEN: No isolation
CREATE POLICY bad_policy ON user_data
FOR SELECT TO authenticated
USING (true);  -- Allows any authenticated user!

-- FORBIDDEN: Tenant only (missing user)
CREATE POLICY incomplete_policy ON personal_data
FOR SELECT TO authenticated
USING (tenant_id = current_tenant_id());  -- Missing user_id check!

-- CORRECT: Full isolation
CREATE POLICY correct_policy ON personal_data
FOR SELECT TO authenticated
USING (
    tenant_id = current_tenant_id()
    AND user_id = auth.uid()
);
```

### 8.3 SQL Migrations

```sql
-- FORBIDDEN: Destructive operations
DROP TABLE memory_items;
ALTER TABLE memory_items DROP COLUMN content;
TRUNCATE user_active_roles;

-- FORBIDDEN: Weakening RLS
DROP POLICY memory_items_user_isolation ON memory_items;

-- CORRECT: Additive only
CREATE TABLE IF NOT EXISTS lovable_sessions (...);
ALTER TABLE community_groups ADD COLUMN IF NOT EXISTS lovable_source TEXT;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lovable_sessions_user ...;
```

---

## 9. Review Checklist (For All PRs)

### Every PR Must Confirm

- [ ] No DROP TABLE/COLUMN/POLICY statements
- [ ] No RENAME statements
- [ ] No ALTER COLUMN TYPE statements
- [ ] No TRUNCATE/DELETE without WHERE
- [ ] No RLS DISABLE
- [ ] No USING (true) policies
- [ ] All new tables have tenant_id
- [ ] All personal data tables have user_id
- [ ] All new tables have RLS enabled
- [ ] All new endpoints check Bearer token
- [ ] All new functions use SECURITY DEFINER appropriately
- [ ] Rollback script included

### Auth-Specific PRs Must Also Confirm

- [ ] JWT claims not modified
- [ ] Token validation not bypassed
- [ ] Session handling secure
- [ ] CORS not weakened
- [ ] No new origins without security review

---

## 10. Monitoring & Alerts

### Required Alerts

| Alert | Trigger | Severity |
|-------|---------|----------|
| RLS Bypass Detected | Error log contains "RLS" and "denied" | SEV-1 |
| Auth Failure Spike | > 100 401s in 5 minutes | SEV-2 |
| Token Validation Error | JWT validation fails unexpectedly | SEV-3 |
| Cross-Tenant Access | Query returns data from wrong tenant | SEV-1 |
| Migration Rollback | Rollback script executed | SEV-3 |

### Monitoring Dashboards

- [ ] Auth success/failure rates
- [ ] Token issuance rates
- [ ] Role switch frequency
- [ ] RLS policy evaluation counts
- [ ] Cross-tenant query attempts (should be 0)

---

## 11. Governance Approvals Required

| Change Type | Approver | VTID Required? |
|-------------|----------|----------------|
| New table (lovable_ prefix) | Tech Lead | YES |
| New column (existing table) | Tech Lead | YES |
| New RLS policy | Security Review | YES |
| New auth endpoint | Security Review | YES |
| User migration batch | Product + Security | YES |
| Auth cutover | All stakeholders | YES |

---

## 12. Violation Response

### If Guardrail Violated

1. **Stop deployment immediately**
2. **Assess impact** - What data/users affected?
3. **Rollback if possible** - Use rollback script
4. **Escalate per severity** - Follow escalation procedures
5. **Document incident** - What happened, why, how prevented
6. **Fix and re-review** - Additional safeguards added

### Post-Incident Requirements

- [ ] Root cause analysis documented
- [ ] Guardrail updated if gap found
- [ ] Review checklist updated
- [ ] Team notified of new learnings

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-07 | Initial guardrails document | Claude (Preparation Phase) |

---

*This document is ACTIVE. All Auth/Supabase merger activities MUST comply with these guardrails. Violations require immediate escalation.*
