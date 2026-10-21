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
--
-- Owner-keyed merchants (the manual "Add products yourself" path) are linked
-- to their owner's organization when the owner owns exactly one and that org
-- has no merchant yet — the same adoption the catalogue route already does.
--
-- impact-allow-solo-migration: every reader already filters on
-- products.is_active; no gateway code needs to change for this to apply.

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

  -- Mark these writes as the gate's own, so trg_products_supplier_gate does
  -- not read them as an admin decision. Transaction-local, reset below.
  PERFORM set_config('vitana.supplier_gate_refresh', 'on', true);

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

  PERFORM set_config('vitana.supplier_gate_refresh', 'off', true);
  RETURN v_n1 + v_n2;
END;
$$;

-- ---------------------------------------------------------------------------
-- products: a new supplier product follows its org; an admin switch-on of a
-- product whose org is not eligible is held instead of shown.
-- Skipped for the refresh's own writes (vitana.supplier_gate_refresh).
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
  IF current_setting('vitana.supplier_gate_refresh', true) = 'on' THEN
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

  -- UPDATE. The trigger only fires when is_active or merchant_id is in the
  -- SET list, so a write that keeps is_active unchanged is still a decision
  -- (an admin keeping a held product off), except for a pure merchant move.
  IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
    -- Moved to another merchant: re-apply the gate, no decision implied.
    IF NEW.is_active AND v_block <> 'eligible' THEN
      NEW.is_active := FALSE;
      NEW.listing_hold := v_block;
    ELSIF NOT NEW.is_active AND v_block = 'eligible'
          AND (OLD.listing_hold IS NOT NULL OR NEW.first_listed_at IS NULL) THEN
      NEW.is_active := TRUE;
      NEW.listing_hold := NULL;
      NEW.first_listed_at := COALESCE(NEW.first_listed_at, now());
    ELSIF v_block <> 'eligible' AND NEW.listing_hold IS NOT NULL THEN
      NEW.listing_hold := v_block;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_active THEN
    IF v_block = 'eligible' THEN
      NEW.listing_hold := NULL;
      NEW.first_listed_at := COALESCE(NEW.first_listed_at, now());
    ELSE
      NEW.is_active := FALSE;
      NEW.listing_hold := v_block;      -- goes on with the org
    END IF;
  ELSE
    -- Switched off on purpose: never bring it back automatically.
    NEW.listing_hold := NULL;
    NEW.first_listed_at := COALESCE(NEW.first_listed_at, now());
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
-- Owner-keyed merchants follow their owner's organization.
-- The manual "Add products yourself" path (POST /vcaop/portal/my/merchants)
-- keys a merchant by owner_user_id only; the catalogue route already adopts
-- such a merchant into the org (PUT .../catalogue/merchant). Without the same
-- link here, products added by hand would never list when the org goes live.
-- Linked only when the owner owns exactly one organization and that org has
-- no merchant yet (the catalogue route reads one merchant per org) — never
-- guessed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sole_owned_partner_org(p_user_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id
    FROM (
      SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END AS id
        FROM partner_organizations
       WHERE owner_user_id = p_user_id
         AND lifecycle_state <> 'rejected'
    ) o
   WHERE o.id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM merchants m WHERE m.partner_organization_id = o.id);
$$;

CREATE OR REPLACE FUNCTION public.trg_merchant_link_owner_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.partner_organization_id IS NULL AND NEW.owner_user_id IS NOT NULL THEN
    NEW.partner_organization_id := public.sole_owned_partner_org(NEW.owner_user_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_merchant_link_owner_org ON public.merchants;
CREATE TRIGGER trg_merchant_link_owner_org
  BEFORE INSERT ON public.merchants
  FOR EACH ROW EXECUTE FUNCTION public.trg_merchant_link_owner_org();

-- An org registered after its owner already added products by hand.
CREATE OR REPLACE FUNCTION public.trg_partner_org_adopt_owner_merchants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_user_id IS NOT NULL
     AND public.sole_owned_partner_org(NEW.owner_user_id) = NEW.id
     AND (SELECT count(*) FROM merchants
           WHERE owner_user_id = NEW.owner_user_id AND partner_organization_id IS NULL) = 1 THEN
    UPDATE merchants
       SET partner_organization_id = NEW.id
     WHERE owner_user_id = NEW.owner_user_id
       AND partner_organization_id IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_partner_org_adopt_owner_merchants ON public.partner_organizations;
CREATE TRIGGER trg_partner_org_adopt_owner_merchants
  AFTER INSERT ON public.partner_organizations
  FOR EACH ROW EXECUTE FUNCTION public.trg_partner_org_adopt_owner_merchants();

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
REVOKE ALL ON FUNCTION public.sole_owned_partner_org(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supplier_listing_block(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_supplier_listings(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.sole_owned_partner_org(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- Backfill 1: products an admin already switched on get first_listed_at, so
-- a later switch-off by the org gate can be undone at the next go-live.
-- ---------------------------------------------------------------------------
UPDATE public.products p
   SET first_listed_at = COALESCE(p.updated_at, now())
  FROM public.merchants m
 WHERE p.merchant_id = m.id
   AND (m.partner_organization_id IS NOT NULL OR m.owner_user_id IS NOT NULL)
   AND p.is_active = TRUE
   AND p.first_listed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Backfill 2: link existing owner-keyed merchants to their owner's single
-- organization (fires trg_merchant_refresh_listings for each). Only an owner
-- with exactly one such merchant, so no org ends up with two.
-- ---------------------------------------------------------------------------
UPDATE public.merchants m
   SET partner_organization_id = public.sole_owned_partner_org(m.owner_user_id)
 WHERE m.partner_organization_id IS NULL
   AND m.owner_user_id IS NOT NULL
   AND public.sole_owned_partner_org(m.owner_user_id) IS NOT NULL
   AND (SELECT count(*) FROM public.merchants x
         WHERE x.owner_user_id = m.owner_user_id AND x.partner_organization_id IS NULL) = 1;

-- ---------------------------------------------------------------------------
-- Backfill 3: bring every existing supplier merchant in line once.
-- ---------------------------------------------------------------------------

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
