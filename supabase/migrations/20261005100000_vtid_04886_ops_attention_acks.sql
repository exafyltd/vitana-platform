-- VTID-04886: Command Hub Overview Phase 3 — Ack / Snooze for
-- GET /api/v1/ops/attention items (plan A, REVISION 2 F5).
--
-- One row per action an exafy_admin takes on an attention item, keyed by the
-- item's env-scoped fingerprint (`<env>:<source>:<entity key>`):
--   ack    — "someone is on it": the item stays in the queue, de-emphasised;
--   snooze — the item is hidden until expires_at; the response counts it.
-- A reason is required and every action expires within 24 h (CHECK). P1 is
-- ackable but never snoozable — enforced by the gateway route, which knows the
-- item's current severity (a table constraint cannot). The latest unexpired
-- row per (env, fingerprint) wins. Every action also emits an OASIS event
-- (ops.attention.acked / ops.attention.snoozed).
--
-- Written and read by the gateway's service role only; RLS on, no client
-- policies. Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.ops_attention_acks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    env TEXT NOT NULL CHECK (env IN ('production', 'staging')),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) BETWEEN 3 AND 300),
    action TEXT NOT NULL CHECK (action IN ('ack', 'snooze')),
    reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    severity TEXT CHECK (severity IN ('P1', 'P2', 'P3')),
    actor_user_id UUID,
    actor_email TEXT,
    vtid TEXT CHECK (vtid IS NULL OR vtid ~ '^VTID-[0-9]{4,5}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ops_attention_acks_expiry_window
        CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
    CONSTRAINT ops_attention_acks_p1_never_snoozed
        CHECK (NOT (action = 'snooze' AND severity = 'P1'))
);

CREATE INDEX IF NOT EXISTS ops_attention_acks_active_idx
    ON public.ops_attention_acks (env, expires_at DESC);
CREATE INDEX IF NOT EXISTS ops_attention_acks_fingerprint_idx
    ON public.ops_attention_acks (env, fingerprint, created_at DESC);

ALTER TABLE public.ops_attention_acks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_attention_acks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ops_attention_acks TO service_role;

COMMENT ON TABLE public.ops_attention_acks IS
  'VTID-04886: /ops/attention Ack/Snooze — one row per exafy_admin action on an attention fingerprint; reason required, expires within 24 h, P1 never snoozed. Gateway service role only.';
