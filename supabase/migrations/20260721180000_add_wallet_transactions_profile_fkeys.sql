-- impact-allow-solo-migration: schema-only fix (adds missing FK constraints);
-- no gateway/worker route change needed — this only makes the existing
-- vitana-v1 PostgREST embed query (`profiles!wallet_transactions_from_user_id_fkey`
-- / `_to_user_id_fkey` in src/hooks/useWallet.ts fetchTransactions) actually work.
--
-- Found while verifying the VTNA/Credits merge deploy on AWS staging: the
-- Wallet's "Recent Activity" transaction list has never worked — every
-- fetchTransactions call 400s with a PostgREST "Could not find a
-- relationship" error, because wallet_transactions.from_user_id/to_user_id
-- have ZERO foreign key constraints at all (verified via pg_constraint).
-- Pre-existing bug, unrelated to the VTNA/Credits merge itself.
--
-- from_user_id/to_user_id reference auth.users.id, not profiles.id (a
-- separate surrogate PK) — the correct FK target is profiles.user_id, which
-- has a UNIQUE constraint (profiles_user_id_key) and matches auth.users.id
-- for all-but-a-handful of rows. Added NOT VALID: 7 of 85 existing rows have
-- a from_user_id with no matching profile, 4 have a to_user_id with no
-- matching profile (likely stale test/reset-era data) — NOT VALID lets
-- PostgREST recognize and embed the relationship immediately without
-- requiring those historical rows to be cleaned up first, while still fully
-- enforcing the constraint on every new INSERT/UPDATE going forward.

ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_from_user_id_fkey
  FOREIGN KEY (from_user_id) REFERENCES public.profiles(user_id)
  NOT VALID;

ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_to_user_id_fkey
  FOREIGN KEY (to_user_id) REFERENCES public.profiles(user_id)
  NOT VALID;

NOTIFY pgrst, 'reload schema';
