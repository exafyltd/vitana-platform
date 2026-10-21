-- Account tab — structured personal data + per-field visibility
--
-- The profile card now has a third pill, "Account", that stores fixed and
-- editable personal data in one place. Each field has BOTH a value and a
-- visibility rule (private / connections / public), stored in
-- `account_visibility` as JSONB.
--
-- Existing columns reused: full_name, email, phone, date_of_birth, created_at
-- New columns added below.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name           TEXT,
  ADD COLUMN IF NOT EXISTS last_name            TEXT,
  ADD COLUMN IF NOT EXISTS gender               TEXT,
  ADD COLUMN IF NOT EXISTS marital_status       TEXT,
  ADD COLUMN IF NOT EXISTS address              TEXT,
  ADD COLUMN IF NOT EXISTS country              TEXT,
  ADD COLUMN IF NOT EXISTS city                 TEXT,
  ADD COLUMN IF NOT EXISTS account_type         TEXT,
  ADD COLUMN IF NOT EXISTS verification_status  TEXT
    CHECK (verification_status IN ('unverified', 'pending', 'verified')),
  ADD COLUMN IF NOT EXISTS account_visibility   JSONB
    NOT NULL DEFAULT '{
      "firstName": "private",
      "lastName": "private",
      "dateOfBirth": "private",
      "gender": "private",
      "maritalStatus": "private",
      "email": "private",
      "phone": "private",
      "address": "private",
      "country": "connections",
      "city": "connections",
      "memberSince": "public",
      "accountType": "public",
      "verificationStatus": "public"
    }'::jsonb;

COMMENT ON COLUMN public.profiles.account_visibility IS
  'Per-field visibility for the Account tab. Keys map to UserProfile.account.* fields. Values: "private" | "connections" | "public". Defaults are private-first for sensitive fields.';
