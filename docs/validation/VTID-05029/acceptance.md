# VTID-05029 — acceptance

AC-1 Migration adds nullable `user_notifications.email_fallback_sent_at`, `user_notification_preferences.email_fallback_enabled boolean not null default true`, and two partial indexes; additive, idempotent, transactional.
TEST: supabase/migrations/20261010130000_vtid_05029_email_fallback.sql — gate migrations lint + libpg-query parse (outputs/local-checks.txt)

AC-2 The job is inert unless EMAIL_FALLBACK_ENABLED is exactly 'true' AND Resend is configured, and never runs on staging; the loop does not start otherwise.
TEST: services/gateway/test/vtid-05029-email-fallback.test.ts ("needs the flag, Resend config and a non-staging env", "loop does not start when unconfigured")

AC-3 Only allowlisted rows (new_chat_message, reminder_due, any p0/p1) with push_outcome no_device/fcm_error, unread, not yet emailed, 1-24 h old are selected; one digest per member.
TEST: services/gateway/test/vtid-05029-email-fallback.test.ts ("allowlist…", "groups by member…", "only no_device / fcm_error…", "one digest per member…")

AC-4 Skips test/service accounts, push_enabled=false, email_fallback_enabled=false, no confirmed email; at most one digest per member per 6 h (max over rows).
TEST: services/gateway/test/vtid-05029-email-fallback.test.ts ("skip rules…", "6 h cap…", "cap expired after 6 h…")

AC-5 Rows are stamped only after Resend accepted the email; a failed send stamps nothing.
TEST: services/gateway/test/vtid-05029-email-fallback.test.ts ("one digest per member, rows stamped after send", "a failed send stamps nothing")

AC-6 Copy via tt(): DE/EN plus es/sr/fr/pt/ru/pl/zh/tr translated; ar stays untranslated by repo rule and falls back to EN; titles only (HTML-escaped), at most 5 plus a "more" line, links to /inbox and /settings/notifications, no tracking pixels, RTL for ar.
TEST: services/gateway/test/vtid-05029-email-fallback.test.ts (buildFallbackDigestEmail), services/gateway/test/i18n/catalog-coverage.test.ts

OASIS_IMPACT: no new OASIS topics or event shapes.
