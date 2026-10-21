-- VTID-04449: a tenth Connected Apps entry, 'outlook-contacts' (import the
-- member's Outlook / Microsoft 365 address book). Only the allowed app ids
-- change; the table, RLS and grants are untouched. Imported rows land in
-- `contacts` with source = 'microsoft' (a plain text column, no CHECK).

ALTER TABLE public.connected_app_settings
  DROP CONSTRAINT IF EXISTS connected_app_settings_app_id_check;

ALTER TABLE public.connected_app_settings
  ADD CONSTRAINT connected_app_settings_app_id_check CHECK (app_id IN (
    'gmail', 'google-calendar', 'google-contacts',
    'outlook-mail', 'outlook-calendar', 'outlook-contacts',
    'apple-mail', 'apple-calendar', 'iphone-contacts',
    'android-contacts'
  ));
