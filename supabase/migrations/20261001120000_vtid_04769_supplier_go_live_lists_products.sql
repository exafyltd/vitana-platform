-- VTID-04769 — a supplier that goes live appears on Discover.
--
-- Spec: docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md D1/D4 and §5.2 —
-- "Vitana lists products and services in Discover", no per-product admin
-- step. Until now every Commerce write path saved products with
-- is_active = false and nothing ever switched them on: a partner org reached
-- `live` and its catalogue stayed invisible, and an admin-activated product
-- kept showing after its org was paused or suspended.
--
-- One truth, products.is_active, so every reader (Discover feed, search,
-- product page, the ORB marketplace tools, checkout) follows the rule without
-- a code change of its own. Only SUPPLIER products are touched: a product
-- whose merchant belongs to a partner organization, or whose merchant owner is
-- a test/service account. Network products (Awin, Admitad, CJ ... — merchants
-- with no partner_organization_id and no owner) are never read or written here.
--
-- Eligible = org lifecycle_state is 'live' AND neither the org owner nor the
-- merchant owner is registered in service_bot_accounts or
-- notification_test_actors (platform CLAUDE.md NEVER rules 43-45: test and
-- service accounts never become visible to real members).
--
--   * becomes eligible  → products still waiting go on: never-listed drafts
--                         (first_listed_at IS NULL) and products the gate
--                         itself took off (listing_hold IS NOT NULL).
--                         A product an admin switched off stays off.
--   * stops eligible    → products that are on go off, with listing_hold
--                         recording why, so they come back on their own.
--   * product added while eligible → on at once.
--   * an admin switching a product on while its org is not live → stays off,
--                         held, and goes on with the org.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS first_listed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS listing_hold TEXT
    CONSTRAINT products_listing_hold_check CHECK (listing_hold IN ('org_not_live', 'excluded_account'));

COMMENT ON COLUMN public.products.first_listed_at IS
  'VTID-04769: when a supplier product was first switched on. NULL = never listed; such a draft goes on when its org goes live.';
COMMENT ON COLUMN public.products.listing_hold IS
  'VTID-04769: why the go-live gate is holding this supplier product off Discover (org_not_live | excluded_account). NULL = not held.';

-- ---------------------------------------------------------------------------
-- Eligibility of one merchant. NULL = not a supplier merchant (leave alone).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.supplier_listing_block(p_merchant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id     UUID;
  v_m_owner    UUID;
  v_lifecycle  TEXT;
  v_org_owner  UUID;
BEGIN
  SELECT partner_organization_id, owner_user_id
    INTO v_org_id, v_m_owner
    FROM merchants WHERE id = p_merchant_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_org_id IS NOT NULL THEN
    SELECT lifecycle_state, owner_user_id INTO v_lifecycle, v_org_owner
      FROM partner_organizations WHERE id = v_org_id;
  END IF;

  IF EXISTS (SELECT 1 FROM service_bot_accounts WHERE user_id IN (v_m_owner, v_org_owner))
     OR EXISTS (SELECT 1 FROM notification_test_actors WHERE user_id IN (v_m_owner, v_org_owner)) THEN
    RETURN 'excluded_account';
  END IF;

  IF v_org_id IS NULL THEN
    RETURN NULL;              -- network or legacy owner-keyed merchant: not gated here
  END IF;
  IF v_lifecycle IS DISTINCT FROM 'live' THEN
    RETURN 'org_not_live';
  END IF;
  RETURN 'eligible';
END;
$$;

COMMENT ON FUNCTION public.supplier_listing_block(UUID) IS
  'VTID-04769: NULL = not a gated supplier merchant; ''eligible''; or the hold reason (org_not_live | excluded_account).';

-- ---------------------------------------------------------------------------
-- Re-apply the gate to every product of one merchant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_supplier_listings(p_merchant_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_block TEXT := public.supplier_listing_block(p_merchant_id);
  v_n1 INTEGER := 0;
  v_n2 INTEGER := 0;
BEGIN
  IF v_block IS NULL THEN
    RETURN 0;
  END IF;

  IF v_block = 'eligible' THEN
    UPDATE products
       SET is_active = TRUE,
           listing_hold = NULL,
           first_listed_at = COALESCE(first_listed_at, now())
     WHERE merchant_id = p_merchant_id
       AND is_active = FALSE
       AND (listing_hold IS NOT NULL OR first_listed_at IS NULL);
    GET DIAGNOSTICS v_n1 = ROW_COUNT;
  ELSE
    UPDATE products
       SET is_active = FALSE,
           listing_hold = v_block
     WHERE merchant_id = p_merchant_id
       AND is_active = TRUE;
    GET DIAGNOSTICS v_n1 = ROW_COUNT;
    -- Already held for another reason: keep the reason current.
    UPDATE products
       SET listing_hold = v_block
     WHERE merchant_id = p_merchant_id
       AND listing_hold IS NOT NULL
       AND listing_hold <> v_block;
    GET DIAGNOSTICS v_n2 = ROW_COUNT;
  END IF;
  RETURN v_n1 + v_n2;
END;
$$;

-- ---------------------------------------------------------------------------
-- products: a new supplier product follows its org; an admin switch-on of a
-- product whose org is not eligible is held instead of shown.
-- Skipped inside the refresh above (pg_trigger_depth() > 1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_products_supplier_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_block TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  v_block := public.supplier_listing_block(NEW.merchant_id);
  IF v_block IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_block = 'eligible' THEN
      NEW.is_active := TRUE;
      NEW.listing_hold := NULL;
      NEW.first_listed_at := COALESCE(NEW.first_listed_at, now());
    ELSE
      -- A draft (first_listed_at NULL) waits for the org; it goes on at go-live.
      NEW.is_active := FALSE;
      NEW.listing_hold := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    IF NEW.is_active THEN
      IF v_block = 'eligible' THEN
        NEW.listing_hold := NULL;
        NEW.first_listed_at := COALESCE(NEW.first_listed_at, now());
      ELSE
        NEW.is_active := FALSE;
        NEW.listing_hold := v_block;      -- goes on with the org
      END IF;
    ELSE
      -- Someone switched it off on purpose: never bring it back automatically.
      NEW.listing_hold := NULL;
      NEW.first_listed_at := COALESCE(NEW.first_listed_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_supplier_gate ON public.products;
CREATE TRIGGER trg_products_supplier_gate
  BEFORE INSERT OR UPDATE OF is_active, merchant_id ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.trg_products_supplier_gate();

-- ---------------------------------------------------------------------------
-- partner_organizations: go-live, pause, suspend, owner change.
-- (POST /partner-orgs/:id/activate writes `status`; the VTID-04471 sync
-- trigger turns that into lifecycle_state before this AFTER trigger runs.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_partner_org_refresh_listings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_merchant UUID;
BEGIN
  IF NEW.lifecycle_state IS NOT DISTINCT FROM OLD.lifecycle_state
     AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id THEN
    RETURN NULL;
  END IF;
  FOR v_merchant IN SELECT id FROM merchants WHERE partner_organization_id = NEW.id LOOP
    PERFORM public.refresh_supplier_listings(v_merchant);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_org_refresh_listings ON public.partner_organizations;
CREATE TRIGGER trg_partner_org_refresh_listings
  AFTER UPDATE ON public.partner_organizations
  FOR EACH ROW EXECUTE FUNCTION public.trg_partner_org_refresh_listings();

-- ---------------------------------------------------------------------------
-- merchants: linked to (or moved between) orgs, or owner changed — e.g. the
-- catalogue route adopting a legacy owner-keyed merchant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_merchant_refresh_listings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.partner_organization_id IS DISTINCT FROM OLD.partner_organization_id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    PERFORM public.refresh_supplier_listings(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_merchant_refresh_listings ON public.merchants;
CREATE TRIGGER trg_merchant_refresh_listings
  AFTER UPDATE OF partner_organization_id, owner_user_id ON public.merchants
  FOR EACH ROW EXECUTE FUNCTION public.trg_merchant_refresh_listings();

-- ---------------------------------------------------------------------------
-- An account registered as test/service (or removed from the registry) after
-- its products already exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_excluded_account_refresh_listings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  v_merchant UUID;
BEGIN
  FOR v_merchant IN
    SELECT m.id FROM merchants m
      LEFT JOIN partner_organizations o ON o.id = m.partner_organization_id
     WHERE m.owner_user_id = v_user OR o.owner_user_id = v_user
  LOOP
    PERFORM public.refresh_supplier_listings(v_merchant);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_bot_refresh_listings ON public.service_bot_accounts;
CREATE TRIGGER trg_service_bot_refresh_listings
  AFTER INSERT OR DELETE ON public.service_bot_accounts
  FOR EACH ROW EXECUTE FUNCTION public.trg_excluded_account_refresh_listings();

DROP TRIGGER IF EXISTS trg_test_actor_refresh_listings ON public.notification_test_actors;
CREATE TRIGGER trg_test_actor_refresh_listings
  AFTER INSERT OR DELETE ON public.notification_test_actors
  FOR EACH ROW EXECUTE FUNCTION public.trg_excluded_account_refresh_listings();

-- Internal helpers: not callable through PostgREST by members.
REVOKE ALL ON FUNCTION public.supplier_listing_block(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_supplier_listings(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supplier_listing_block(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_supplier_listings(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- Backfill: bring every existing supplier merchant in line once.
-- Products an admin already switched on get first_listed_at so a later
-- switch-off by the org gate can be undone at the next go-live.
-- ---------------------------------------------------------------------------
UPDATE public.products p
   SET first_listed_at = COALESCE(p.updated_at, now())
  FROM public.merchants m
 WHERE p.merchant_id = m.id
   AND (m.partner_organization_id IS NOT NULL OR m.owner_user_id IS NOT NULL)
   AND p.is_active = TRUE
   AND p.first_listed_at IS NULL;

DO $$
DECLARE
  v_merchant UUID;
BEGIN
  FOR v_merchant IN
    SELECT id FROM public.merchants WHERE partner_organization_id IS NOT NULL OR owner_user_id IS NOT NULL
  LOOP
    PERFORM public.refresh_supplier_listings(v_merchant);
  END LOOP;
END $$;
