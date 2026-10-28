# VTID-05104 acceptance

AC-1 An invite is refused when the sender or the receiver is on service_bot_accounts or notification_test_actors (a group invite from such a sender too), using the strict lookup; an error on either allowlist refuses.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

AC-2 An invite to a receiver in another tenant, an unknown receiver, yourself, or the Vitana bot is refused.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

AC-3 A direct invite needs a relationship: a prior non-invite direct message in either direction, a shared chat group, or a follow in either direction; a prior invite alone, or a group the receiver is not in, does not count.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

AC-4 At most 30 invites per sender per rolling 24 hours and 5 per sender-recipient pair per rolling 7 days (the 31st and the 6th are refused); both are adjustable by env; the count reads chat_messages with tenant_id, sender_id and a bounded created_at window and needs no migration.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

AC-5 A group invite needs the sender to be a member of a group of at most 20 members (21 is refused) and counts against the daily quota.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

AC-6 Every refusal, whatever the rule, is the same 403 body (invite_not_allowed) and a database error in any lookup refuses (fail closed); the reason is only logged.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

AC-7 POST /chat/send and POST /chat/groups/:id/send with calendar_invite run the guard first; a refusal inserts nothing and sends no push; other message types are not guarded and keep their push.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts
TEST: services/gateway/test/vtid-04917-invite-routes.test.ts

AC-8 The voice tool stores a v2 card (ref_type, ref_id) that inviteMetadataOf accepts, refuses private, past, recurring and cancelled entries, applies the same guard, and keeps its per-user voice quota.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts

AC-9 The invite push (voice, direct and group) is the generic "{Name} invited you to an event" in the receiver's language, with no title, time or place; the key exists in DE, EN, ES, SR (and the other shipped locales) and the catalog coverage tests stay green.
TEST: services/gateway/test/vtid-05104-calendar-invite-guard.test.ts
TEST: services/gateway/test/i18n/catalog-coverage.test.ts

AC-10 The calendar coverage manifest lists the new source file with its test and the calendar suite stays green.
TEST: services/gateway/test/calendar/calendar-coverage.guard.test.ts
