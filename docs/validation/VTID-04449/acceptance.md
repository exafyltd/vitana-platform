# VTID-04449: Outlook Contacts in Connected Apps

The Connected Apps plan (VTID-04403) promised Outlook contacts next to Outlook
Mail and Calendar, but the screen had no app for it. This adds a tenth app,
`outlook-contacts`.

## Acceptance criteria

AC-1 The catalogue lists ten apps, including `outlook-contacts`. It is a Microsoft OAuth app asking only for `Contacts.Read`, and a `Contacts.ReadWrite` grant also counts.
TEST: services/gateway/test/vtid-04449-outlook-contacts.test.ts
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts

AC-2 `fetchOutlookContacts` reads every page of Graph `/me/contacts`, and keeps only names, e-mail addresses and phone numbers (mobile, home and business). A 403 is reported as `permission_not_granted`.
TEST: services/gateway/test/vtid-04449-outlook-contacts.test.ts

AC-3 A sync imports into `contacts` with `source = 'microsoft'` through the same upsert as Google and iCloud, including the VTID-04439 collision handling.
TEST: services/gateway/test/vtid-04449-outlook-contacts.test.ts

AC-4 Turning the app off with "remove imported contacts" deletes only the rows where `source = 'microsoft'`.
TEST: services/gateway/test/vtid-04449-outlook-contacts.test.ts

AC-5 The background loop syncs it daily, like the other contacts apps.
TEST: services/gateway/test/vtid-04449-outlook-contacts.test.ts

AC-6 The assistant's `contacts.read` works on the Microsoft connector (list and filter). A missing scope names `outlook-contacts` as the app to turn on.
TEST: services/gateway/test/vtid-04449-outlook-contacts.test.ts

AC-7 Migration `20260924100000_vtid_04449_outlook_contacts_app.sql` widens the `connected_app_settings.app_id` CHECK. It was applied to the project on 2026-09-23 and verified with `pg_get_constraintdef`. `DATABASE_SCHEMA.md` is updated.
TEST: services/gateway/test/vtid-04449-outlook-contacts.test.ts

## Not verified

No real Microsoft account was read from, because the Microsoft OAuth client is
not registered yet. The Graph response shape comes from the Graph v1.0
reference for `contact`.
