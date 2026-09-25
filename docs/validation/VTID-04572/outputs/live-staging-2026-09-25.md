# VTID-04572 — staging evidence

## Before (staging build 1a80874, 2026-09-25)
CloudWatch /vitana/gateway: every brain build since at least 17:00Z logs
`[VTID-01952] identity-guardrail: app_users select error: column app_users.first_name does not exist`.
The member's profile has a date of birth; `app_users` has no date_of_birth column (information_schema).
In session live-03af48b7 the member asked for their own birthday and Vitana did not know it.

## After
Added once the fix is deployed to staging.
