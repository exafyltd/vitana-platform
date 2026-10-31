# Requirements — mt-network (WS3 Network layer & community/network scopes)

EARS requirements. Links, not copies: program plan `docs/MULTI-TENANT-PLAN.md` §4.11 + §6 WS3 and the decision register (D1, D15, D23, D25, D27); migration order `docs/multitenancy/MIGRATION-QUEUE.md`; `isHealthTable()`/lineage guard owned by mt-identity/mt-guardrails (CROSS-SPEC O1).

## Program position
- **Predecessors:** M0 lanes S-M / A / B / C (VTID-05147/05149/05150/05151, done); mt-identity (`tenant_id_for_policies()`, `is_member()`, access-token claim) for community-scope predicates — where not yet live, community reads use the membership join (WS3).
- **This spec:** WS3 Network layer — the two-scope model (`community`/`network`) for messenger, Find-a-Match and ORB recipient resolution, network-presence opt-in, enforced message/connection sends, legacy-message migration, and (M3, flagged) Network groups (D27, owned here).
- **Successors:** mt-discover (Discover distribution `community|network` catalog gating builds on the scope control wired here); mt-m3 (references Network groups, does not re-plan them); events/live-room network scope (follow-up).

## Functional requirements
- R1 WHEN a member opens the messenger THEN the scope switch SHALL offer `community` ("Community") and `network` ("Netzwerk/Network") with correct values on mobile and desktop, defaulting to `community` and remembering the choice per surface.
- R2 WHEN a client attempts a direct INSERT into `chat_messages` or `global_messages` THEN the database SHALL reject it; all member sends SHALL go through `send_message()` (user JWT) or `send_message_as()` (service_role, gateway-on-behalf).
- R3 WHERE a send is `scope='community'` THE `send_message()` RPC SHALL require a shared active tenant; WHERE `scope='network'` it SHALL require both members `network_visible`, the recipient's messaging preference, no block, and the first-contact rate limit, deriving `sender_id` from `auth.uid()` and `tenant_id` server-side.
- R4 WHEN a connection request is created or answered THEN it SHALL go through `request_connection()`/`respond_connection()` with the caller bound to `auth.uid()`, only the recipient able to set `accepted`, and (network) both members `network_visible` + preference ≠ nobody + no block + rate limit; a client-written `accepted` SHALL be impossible.
- R5 THE system SHALL add `global_community_profiles.network_visible` (default false) + `network_visible_decided_at`; a rule-45 trigger SHALL force `network_visible=false` for test/service/platform-only accounts; existing members SHALL be backfilled false and shown a one-time in-app choice.
- R6 WHEN matching runs THEN `daily_matches` SHALL carry a `scope`, the intent matchers SHALL default to the caller's selected scope (`network` restricted to `network_visible` members), and `match_reasons` SHALL never expose a Vitana Index / health-derived code (D25).
- R7 WHEN ORB resolves a recipient THEN it SHALL default to `community`, use `network` only on an explicit member request, and only surface `network_visible` recipients whose messaging preference allows it.
- R8 THE legacy `messages`/`message_threads` and `global_message_threads`/`global_messages` SHALL be migrated per the D15 single rule (shared tenant → Community, else Network) and the legacy tables dropped, after a `bak_*` snapshot.
- R9 (M3, flagged) THE system SHALL add `scope` to `chat_groups`/`chat_group_members` with participant-only RLS and an `add_group_member()` DEFINER enforcing D27 (≤20, invite-only between connections, no system fan-out, creator tenant as context).

## Non-functional / standing
- N1 Never test against production (rules 31/31b/48); staging specs read-only; writes proven by Vitest/Jest/pgTAP.
- N2 Dark by default behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.network_enabled` / `mt.network_groups`.
- N3 i18n DE-first du-form, RTL via logical properties; Spotlight contract for any touched v1 screen; WCAG 2.2 AA.
- N4 Maxina golden suite byte-identical except the one recorded network-visibility prompt exception; `npm run test:support` (42c) green.
- N5 Migrations: expand/contract, `lock_timeout`, pre-approved rollback, read-only pre/post checks, MIGRATION-QUEUE row in the same PR; applied by Claude via RUN-MIGRATION.
- N6 Executor never writes to a live system (collaboration §7a); a DB change is a migration file in the lane's PR.
