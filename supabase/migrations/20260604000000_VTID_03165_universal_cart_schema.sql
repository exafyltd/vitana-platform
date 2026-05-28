-- VTID-03165 — Universal Cart Phase 1, Slice A: schema foundation.
--
-- Introduces three tables that back the persistent multi-item Universal Cart
-- sitting on top of the Discover marketplace (VTID-02000):
--
--   * public.carts        — one active cart per user (partial-unique index)
--   * public.cart_items   — items staged from web / mobile / voice / autopilot
--   * public.cart_events  — append-only audit ledger of cart mutations
--
-- Phase 1 scope (per Universal Cart PRD, Section 2):
--   - Single active cart per user, item types limited to 'supplement' /
--     'partner_product' (anything from the existing products catalog).
--   - No checkout, no quote, no validations, no wallet waterfall, no
--     autopilot auto-create. Those land in Phases 2-4 on top of this schema.
--   - Per-item exit uses the existing single-item product_orders flow with
--     a new cart_item_id callback param (handled in VTID-B, the gateway slice).
--
-- Decisions locked (PRD Section 14):
--   Q1 NO  — /discover/orders does not surface cart items.
--   Q2 YES — source_surface attributes by intent origin; community group threads
--            land as source_surface='community' regardless of HTTP transport.
--   Q3 YES — cart_items.metadata.autopilot_rec_id is populated day 1 (Phase 1)
--            so the decision-contract `commerce_cart` provider's
--            has_autopilot_link signal works before Phase 4 auto-create.
--   Q4 EXPLICIT — completion is signalled via an explicit `cart_item_id`
--            callback parameter, not webhook archaeology.
--   Q5 COMMUNITY-ONLY — cart endpoints will return 403 cart_unavailable_for_role
--            for non-community sessions (enforced in gateway VTID-B).
--
-- Schema-drift safeguard:
--   Per the VTID-03152 / VTID-03159 incident (user_journey table) memory rule,
--   any CREATE TABLE IF NOT EXISTS that could collide with a pre-existing
--   ad-hoc table must introspect information_schema first and fail loudly if
--   drift is present. This migration:
--     (1) Pre-condition guard at the top that RAISEs if any of the three target
--         tables exist with columns outside the expected set.
--     (2) Defensive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` per column,
--         ensuring required columns end up present even if a partial same-named
--         table predates this migration.
--     (3) Post-condition guard at the bottom that RAISEs if any expected
--         column is missing after DDL.

BEGIN;

-- ============================================================
-- Pre-condition: schema-drift guard
-- ============================================================
DO $vtid_03165_pre_guard$
DECLARE
  unexpected TEXT;
BEGIN
  -- Per-table column check: any column present in carts / cart_items / cart_events
  -- whose (table_name, column_name) pair is not in the expected set is treated as
  -- drift. The earlier UNION form (one column-name set across all three tables)
  -- would have falsely passed e.g. `cart_items.event_type` because `event_type`
  -- belongs on cart_events.
  SELECT string_agg(c.table_name || '.' || c.column_name, ', ' ORDER BY c.table_name, c.column_name)
    INTO unexpected
    FROM information_schema.columns c
    LEFT JOIN (VALUES
      ('carts','id'),
      ('carts','user_id'),
      ('carts','tenant_id'),
      ('carts','status'),
      ('carts','source_context'),
      ('carts','metadata'),
      ('carts','created_at'),
      ('carts','updated_at'),
      ('cart_items','id'),
      ('cart_items','cart_id'),
      ('cart_items','item_type'),
      ('cart_items','product_id'),
      ('cart_items','merchant_id'),
      ('cart_items','quantity'),
      ('cart_items','unit_price_cents_snapshot'),
      ('cart_items','currency_snapshot'),
      ('cart_items','source_surface'),
      ('cart_items','source_ref'),
      ('cart_items','status'),
      ('cart_items','metadata'),
      ('cart_items','created_at'),
      ('cart_items','updated_at'),
      ('cart_events','id'),
      ('cart_events','cart_id'),
      ('cart_events','user_id'),
      ('cart_events','event_type'),
      ('cart_events','event_payload'),
      ('cart_events','created_at')
    ) AS allowed(tbl, col)
      ON allowed.tbl = c.table_name AND allowed.col = c.column_name
   WHERE c.table_schema = 'public'
     AND c.table_name IN ('carts', 'cart_items', 'cart_events')
     AND allowed.tbl IS NULL;

  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      'VTID-03165 pre-condition: unexpected columns in public.carts / cart_items / cart_events: %. Investigate ad-hoc DB state and migrate intentionally (ALTER TABLE) before re-running.',
      unexpected;
  END IF;
END
$vtid_03165_pre_guard$;

-- ============================================================
-- carts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.carts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  tenant_id       UUID,
  status          TEXT NOT NULL DEFAULT 'active',
  source_context  TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defensive column additions (idempotent under drift)
ALTER TABLE public.carts ADD COLUMN IF NOT EXISTS user_id        UUID;
ALTER TABLE public.carts ADD COLUMN IF NOT EXISTS tenant_id      UUID;
ALTER TABLE public.carts ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.carts ADD COLUMN IF NOT EXISTS source_context TEXT;
ALTER TABLE public.carts ADD COLUMN IF NOT EXISTS metadata       JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.carts ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.carts ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.carts
  DROP CONSTRAINT IF EXISTS carts_status_check;
ALTER TABLE public.carts
  ADD  CONSTRAINT carts_status_check CHECK (status IN ('active','archived'));

COMMENT ON TABLE public.carts IS
  'VTID-03165: persistent Universal Cart. One active cart per user (partial-unique index). Phase 1 — staging area only; checkout lives in Phase 3.';
COMMENT ON COLUMN public.carts.tenant_id IS
  'Optional. Cart is user-scoped; tenant_id is read from user_tenants at query time but mirrored here when known for fast filtering.';
COMMENT ON COLUMN public.carts.source_context IS
  'Free-form hint about where the cart was first opened (e.g. discover_supplements, voice_session_id, autopilot_rec_id).';
COMMENT ON COLUMN public.carts.metadata IS
  'JSONB. Future fields (Phase 5+): cohort hints, group_buy linkage, named-stack label. No PII.';

CREATE UNIQUE INDEX IF NOT EXISTS carts_one_active_per_user
  ON public.carts (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS carts_user_status_idx
  ON public.carts (user_id, status);
CREATE INDEX IF NOT EXISTS carts_tenant_idx
  ON public.carts (tenant_id) WHERE tenant_id IS NOT NULL;

-- ============================================================
-- cart_items
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cart_items (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id                    UUID NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  item_type                  TEXT NOT NULL,
  product_id                 UUID NOT NULL REFERENCES public.products(id),
  merchant_id                UUID REFERENCES public.merchants(id),
  quantity                   NUMERIC NOT NULL DEFAULT 1,
  unit_price_cents_snapshot  INT,
  currency_snapshot          CHAR(3),
  source_surface             TEXT,
  source_ref                 TEXT,
  status                     TEXT NOT NULL DEFAULT 'active',
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS cart_id                   UUID;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS item_type                 TEXT;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS product_id                UUID;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS merchant_id               UUID;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS quantity                  NUMERIC NOT NULL DEFAULT 1;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS unit_price_cents_snapshot INT;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS currency_snapshot         CHAR(3);
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS source_surface            TEXT;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS source_ref                TEXT;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS status                    TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS created_at                TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.cart_items ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.cart_items
  DROP CONSTRAINT IF EXISTS cart_items_item_type_check;
ALTER TABLE public.cart_items
  ADD  CONSTRAINT cart_items_item_type_check
  CHECK (item_type IN ('supplement','partner_product'));

ALTER TABLE public.cart_items
  DROP CONSTRAINT IF EXISTS cart_items_status_check;
ALTER TABLE public.cart_items
  ADD  CONSTRAINT cart_items_status_check
  CHECK (status IN ('active','removed','completed','expired'));

ALTER TABLE public.cart_items
  DROP CONSTRAINT IF EXISTS cart_items_quantity_positive;
ALTER TABLE public.cart_items
  ADD  CONSTRAINT cart_items_quantity_positive CHECK (quantity > 0);

ALTER TABLE public.cart_items
  DROP CONSTRAINT IF EXISTS cart_items_source_surface_check;
ALTER TABLE public.cart_items
  ADD  CONSTRAINT cart_items_source_surface_check
  CHECK (source_surface IS NULL OR source_surface IN ('web','mobile','voice','autopilot','community'));

COMMENT ON TABLE public.cart_items IS
  'VTID-03165: items staged in a Universal Cart. Phase 1 — supplement / partner_product only; subscriptions, lab_tests, appointments, protocol_bundles arrive in later phases.';
COMMENT ON COLUMN public.cart_items.unit_price_cents_snapshot IS
  'Price (cents, matching products.price_cents) at add-time. Stored for future price-watch comparison (Phase 2+) and audit hygiene.';
COMMENT ON COLUMN public.cart_items.currency_snapshot IS
  'ISO 4217 currency at add-time (matching products.currency CHAR(3)).';
COMMENT ON COLUMN public.cart_items.source_surface IS
  'Origin of the add intent, not the HTTP transport. Adds from a community group chat thread land as ''community'' even if transport is web/mobile (PRD Q2).';
COMMENT ON COLUMN public.cart_items.source_ref IS
  'Free-form correlation handle (e.g. voice session_id, autopilot rec_id, group thread id).';
COMMENT ON COLUMN public.cart_items.metadata IS
  'JSONB. Phase 1 hint: metadata.autopilot_rec_id populated when add traces to an autopilot_recommendations row, even though auto-create is Phase 4 (PRD Q3). Never store PII or pricing strings here.';

CREATE INDEX IF NOT EXISTS cart_items_cart_active_idx
  ON public.cart_items (cart_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS cart_items_product_idx
  ON public.cart_items (product_id);
CREATE INDEX IF NOT EXISTS cart_items_status_idx
  ON public.cart_items (cart_id, status);
CREATE INDEX IF NOT EXISTS cart_items_autopilot_rec_idx
  ON public.cart_items ((metadata->>'autopilot_rec_id'))
  WHERE metadata ? 'autopilot_rec_id';

-- ============================================================
-- cart_events  (append-only audit ledger)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cart_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cart_id       UUID NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL,
  event_type    TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.cart_events ADD COLUMN IF NOT EXISTS cart_id       UUID;
ALTER TABLE public.cart_events ADD COLUMN IF NOT EXISTS user_id       UUID;
ALTER TABLE public.cart_events ADD COLUMN IF NOT EXISTS event_type    TEXT;
ALTER TABLE public.cart_events ADD COLUMN IF NOT EXISTS event_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cart_events ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON TABLE public.cart_events IS
  'VTID-03165: append-only ledger of cart mutations. Event types in Phase 1: cart.created, item.added, item.removed, item.quantity_changed, item.completed, cart.archived. PRIVACY RULE: event_payload MUST NOT contain unit_price_cents_snapshot, full product descriptions, or PII — only ids and minimal structural fields. Writes via service_role only.';
COMMENT ON COLUMN public.cart_events.event_payload IS
  'Minimal structural payload. Allowed keys: cart_item_id, product_id, quantity_before, quantity_after, source_surface, source_ref, removal_reason. Disallowed: prices, names, descriptions, user-identifying strings.';

CREATE INDEX IF NOT EXISTS cart_events_cart_recent_idx
  ON public.cart_events (cart_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cart_events_user_recent_idx
  ON public.cart_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cart_events_type_idx
  ON public.cart_events (event_type, created_at DESC);

-- ============================================================
-- Explicit table grants (defense-in-depth alongside RLS).
-- Supabase configures DEFAULT PRIVILEGES on `public` for these roles, but
-- declaring them explicitly keeps the migration self-contained and resilient
-- to schema-level privilege drift (e.g. a future REVOKE ALL on public).
-- cart_events stays SELECT-only for `authenticated` — gateway writes via
-- service_role, which bypasses RLS.
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carts        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cart_items   TO authenticated;
GRANT SELECT                          ON public.cart_events TO authenticated;
GRANT ALL                             ON public.carts        TO service_role;
GRANT ALL                             ON public.cart_items   TO service_role;
GRANT ALL                             ON public.cart_events  TO service_role;

-- ============================================================
-- updated_at trigger (shared function, two triggers)
-- ============================================================
CREATE OR REPLACE FUNCTION public.universal_cart_touch_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS carts_updated_at_trigger ON public.carts;
CREATE TRIGGER carts_updated_at_trigger
  BEFORE UPDATE ON public.carts
  FOR EACH ROW
  EXECUTE FUNCTION public.universal_cart_touch_updated_at();

DROP TRIGGER IF EXISTS cart_items_updated_at_trigger ON public.cart_items;
CREATE TRIGGER cart_items_updated_at_trigger
  BEFORE UPDATE ON public.cart_items
  FOR EACH ROW
  EXECUTE FUNCTION public.universal_cart_touch_updated_at();

-- ============================================================
-- RLS — owner-only read/write; service_role bypasses for gateway writes.
-- ============================================================
ALTER TABLE public.carts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_events  ENABLE ROW LEVEL SECURITY;

-- carts: owner full access
DROP POLICY IF EXISTS carts_select_own ON public.carts;
CREATE POLICY carts_select_own ON public.carts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS carts_insert_own ON public.carts;
CREATE POLICY carts_insert_own ON public.carts
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS carts_update_own ON public.carts;
CREATE POLICY carts_update_own ON public.carts
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS carts_delete_own ON public.carts;
CREATE POLICY carts_delete_own ON public.carts
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- cart_items: gated by parent cart ownership
DROP POLICY IF EXISTS cart_items_select_via_cart ON public.cart_items;
CREATE POLICY cart_items_select_via_cart ON public.cart_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.carts c
                  WHERE c.id = cart_items.cart_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS cart_items_insert_via_cart ON public.cart_items;
CREATE POLICY cart_items_insert_via_cart ON public.cart_items
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.carts c
                       WHERE c.id = cart_items.cart_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS cart_items_update_via_cart ON public.cart_items;
CREATE POLICY cart_items_update_via_cart ON public.cart_items
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.carts c
                  WHERE c.id = cart_items.cart_id AND c.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.carts c
                       WHERE c.id = cart_items.cart_id AND c.user_id = auth.uid()));

DROP POLICY IF EXISTS cart_items_delete_via_cart ON public.cart_items;
CREATE POLICY cart_items_delete_via_cart ON public.cart_items
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.carts c
                  WHERE c.id = cart_items.cart_id AND c.user_id = auth.uid()));

-- cart_events: SELECT is gated by parent-cart ownership — we do NOT trust
-- cart_events.user_id alone (defense-in-depth: if service_role ever wrote the
-- wrong user_id, the wrong user would be able to read it). The cart_id FK is
-- the source of truth for ownership, mirroring the cart_items policy pattern.
-- No INSERT / UPDATE / DELETE policy for `authenticated`; service_role bypasses
-- RLS and is the only writer.
-- Idempotent: drop both legacy and current names before recreating, so re-runs
-- after a partial apply or a name change land cleanly.
DROP POLICY IF EXISTS cart_events_select_via_cart ON public.cart_events;
DROP POLICY IF EXISTS cart_events_select_own      ON public.cart_events;
CREATE POLICY cart_events_select_via_cart ON public.cart_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.carts c
                  WHERE c.id = cart_events.cart_id AND c.user_id = auth.uid()));

-- ============================================================
-- Post-condition: required-column guard
-- ============================================================
DO $vtid_03165_post_guard$
DECLARE
  expected_columns CONSTANT TEXT[] := ARRAY[
    'carts.id','carts.user_id','carts.tenant_id','carts.status','carts.source_context',
    'carts.metadata','carts.created_at','carts.updated_at',
    'cart_items.id','cart_items.cart_id','cart_items.item_type','cart_items.product_id',
    'cart_items.merchant_id','cart_items.quantity','cart_items.unit_price_cents_snapshot',
    'cart_items.currency_snapshot','cart_items.source_surface','cart_items.source_ref',
    'cart_items.status','cart_items.metadata','cart_items.created_at','cart_items.updated_at',
    'cart_events.id','cart_events.cart_id','cart_events.user_id','cart_events.event_type',
    'cart_events.event_payload','cart_events.created_at'
  ];
  missing TEXT;
BEGIN
  SELECT string_agg(spec, ', ' ORDER BY spec)
    INTO missing
    FROM unnest(expected_columns) AS spec
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name || '.' || column_name) = spec
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'VTID-03165 post-condition: required columns missing after migration: %', missing;
  END IF;
END
$vtid_03165_post_guard$;

COMMIT;
