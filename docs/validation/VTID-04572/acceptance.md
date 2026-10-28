# VTID-04572 — Vitana knows the member's name and birthday again

Same member test: the member asked for their own birthday and Vitana did not know it, although their
profile has a date of birth. Every staging brain build logs
`[VTID-01952] identity-guardrail: app_users select error: column app_users.first_name does not exist`.
The [USER IDENTITY] block selected first_name/last_name/date_of_birth/gender/pronouns/city/country from
`app_users`, which has none of them (they live on `profiles`), so the block was always empty. The same
wrong table made the profile-completion signal read every member as 0% complete.

The identity lock that refused the spoken birthday (`user_birthday` is profile-only by design,
VTID-01952) is unchanged; the model's instruction to send the member to their profile lives in the
block this fix restores.

AC-1: name, birth date, gender and location come from `profiles`; locale from `app_users`; either read
failing leaves the other.
TEST: services/gateway/test/services/vtid-04572-identity-guardrail-block.test.ts

AC-2: profile completion reads `profiles`.
TEST: services/gateway/test/services/guide/awareness-extensions-repository.test.ts

AC-3 (live, after the staging deploy): the gateway logs no `app_users select error` for identity, and a
voice session answers the member's own birthday from the profile.
TEST: services/gateway/test/services/vtid-04572-identity-guardrail-block.test.ts (live evidence in outputs/)
