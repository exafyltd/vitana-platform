# Runbook — provisioning a new tenant (VTID-05150)

Creating a real tenant is **not** part of the VTID-05150 deploy. It is a separate,
owner-approved production action after Gate 2, once migrations B-M1/B-M2 and the
`tenant-assets` bucket are live.

## 0. Preconditions (read-only checks)

- `post-apply-checks.sql` passed for B-M1 and B-M2; the bucket row exists (public, 1 MB, png/jpeg/webp).
- Lane A M1 is applied: `SELECT slug FROM tenants WHERE is_default` → `maxina`.
- The gateway build serving production contains VTID-05150 (`/api/v1/admin/build-info`).

## 1. The pack file — owner approves it before anything runs

```json
{
  "provision": {
    "slug": "<3-32 chars, lowercase, single hyphens, not reserved>",
    "name": "<legal/display name, ≤80>",
    "admin_email": "<the first admin's confirmed email>",
    "all_members_group_name": "<the system group's name, in the community's language>",
    "display_name": "<optional>",
    "jev_monthly_budget_usd": 10,
    "default_locale": "de",
    "enabled_locales": ["de", "en"],
    "timezone": "Europe/Berlin",
    "currency": "EUR"
  },
  "brand_pack": {
    "brand": { "colors": { "accent": "#RRGGBB", "bg": "#RRGGBB", "fg": "#RRGGBB" } },
    "legal_entity_line": "<≤200 chars>",
    "support_email": "<address>",
    "sender_name": "<e.g. Community by VITANA>",
    "sender_email": "<address on a verified sending domain>",
    "landing": { "cta": "invite_only" },
    "persona_facts": {
      "community_name": "<name>",
      "community_pronunciation": "<optional>",
      "anchor_person": { "name": "<optional>", "pronunciation": "<optional>", "role": "<optional>" },
      "story_facts": ["<fact>"],
      "offer_facts": ["<fact>"],
      "tone": ["<adjective>"]
    }
  }
}
```

Review points for the owner:
- **persona_facts are facts, never sentences Vitana speaks** (CLAUDE.md rule 41). Each entry ≤200 chars,
  ≤8 per list. "Founded 2026 in Vienna" is a fact; "Welcome to our lovely community!" is a spoken line and is refused in review.
- **admin_email** must not be a test/service/automation account (rules 43–45); the function refuses
  `service_bot_accounts`, `notification_test_actors`, `e2e-*` and `@vitanatest.exafy.io` addresses anyway.
- **First admin = an existing account where possible.** A fresh signup is still enrolled as a primary Maxina
  member by the signup trigger until Lane A's signup routing is live (plan Risk 1), which fires Maxina's welcome fan-out.
- Jev budget: default $10/month (the Alkalma value); 0–500 allowed.
- Asset files: `logo.png|jpg|jpeg|webp`, `favicon.*`, `og_image.*` (optional), ≤1 MB each, no SVG/GIF.

## 2. Run (an exafy_admin, production gateway, in the approved window)

```bash
export VITANA_ADMIN_JWT=<exafy_admin access token>   # never paste it into logs or chat
node scripts/tenants/provision-tenant.mjs --gateway <production gateway origin> --pack pack.json --assets ./assets
```

Re-running is safe: provisioning is idempotent (`created:false`, same invitation reused), the PATCH and the
asset uploads overwrite with the same values. The script prints readiness at the end.

## 3. Readiness

`node scripts/tenants/provision-tenant.mjs --gateway <origin> --pack pack.json --readiness-only`

Every check except `first_admin` should be green right after the run. `open_signup` stays **false**
(invite-only). Opening signups is a separate PATCH (`{"open_signup": true}`), refused with 409
`TENANT_NOT_READY` unless every check is green; an override needs `override_reason` (≥10 chars, recorded in OASIS).

## 4. First admin

The script prints `accept path: /admin/invitations/accept/<token>` (valid 7 days). The operator sends it to the
admin over an approved channel (no invitation email exists yet). The admin, signed in with the invited and
confirmed email, accepts (API today: `POST /api/v1/admin/invitations/accept/<token>`; page in the Lane C slice),
then switches in with `switch_to_tenant_by_slug('<slug>')`. Readiness `first_admin` then turns green.

## 5. Report

Post the result with the OASIS event id of `tenant.provisioned` (payload: tenant_id, slug, created, invitation_id,
ensured counts — never the token or the email).

## Undo

No delete path ships in this slice. A mistaken tenant stays invite-only and empty; removing it is its own
owner-approved action (WS4 follow-up). The schema rollback is `rollback.sql` (+ `rollback-complete.sql`).
