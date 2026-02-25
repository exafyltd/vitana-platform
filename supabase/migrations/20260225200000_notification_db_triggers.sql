-- ============================================================================
-- Notification DB Triggers
--
-- Automatically INSERT into user_notifications when domain events occur.
-- These cover events that happen via direct DB writes (not through Gateway).
--
-- Triggers:
--   1. d44_predictive_signals → predictive_signal_detected / positive_momentum / social_withdrawal
--   2. contextual_opportunities → opportunity_surfaced
--   3. risk_mitigations → risk_mitigation_suggestion
--   4. memory_items → memory_garden_grew (high-importance only)
--   5. lab_reports → lab_report_processed
-- ============================================================================

-- ── 1. Predictive Signals ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notify_on_predictive_signal()
RETURNS TRIGGER AS $$
DECLARE
  v_type TEXT;
  v_title TEXT;
  v_body TEXT;
  v_priority TEXT;
BEGIN
  -- Only fire for high-confidence signals
  IF NEW.confidence < 70 THEN
    RETURN NEW;
  END IF;

  -- Route by signal_type
  CASE NEW.signal_type
    WHEN 'positive_momentum' THEN
      v_type := 'positive_momentum_detected';
      v_title := 'Positive Momentum';
      v_body := 'We detected positive trends in your wellbeing. Keep it up!';
      v_priority := 'p2';
    WHEN 'social_withdrawal' THEN
      v_type := 'social_withdrawal_signal';
      v_title := 'Social Check-in';
      v_body := 'We noticed a change in your social activity. Everything okay?';
      v_priority := 'p0';
    ELSE
      v_type := 'predictive_signal_detected';
      v_title := 'Predictive Signal';
      v_body := COALESCE(NEW.description, 'A new predictive signal was detected.');
      v_priority := 'p1';
  END CASE;

  INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
  VALUES (
    NEW.user_id,
    NEW.tenant_id,
    v_type,
    v_title,
    v_body,
    jsonb_build_object('entity_id', NEW.id::text, 'signal_type', NEW.signal_type, 'confidence', NEW.confidence),
    CASE WHEN v_priority = 'p0' THEN 'push_and_inapp' ELSE 'inapp' END,
    v_priority
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_predictive_signal error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'd44_predictive_signals') THEN
    DROP TRIGGER IF EXISTS trg_notify_predictive_signal ON d44_predictive_signals;
    CREATE TRIGGER trg_notify_predictive_signal
      AFTER INSERT ON d44_predictive_signals
      FOR EACH ROW
      WHEN (NEW.confidence >= 70)
      EXECUTE FUNCTION notify_on_predictive_signal();
  END IF;
END $$;

-- ── 2. Contextual Opportunities ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notify_on_opportunity_surfaced()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
  VALUES (
    NEW.user_id,
    NEW.tenant_id,
    'opportunity_surfaced',
    'Opportunity Found',
    COALESCE(NEW.title, 'A new opportunity has been identified for you.'),
    jsonb_build_object('entity_id', NEW.id::text, 'opportunity_type', COALESCE(NEW.opportunity_type, 'general')),
    'push_and_inapp',
    'p1'
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_opportunity_surfaced error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'contextual_opportunities') THEN
    DROP TRIGGER IF EXISTS trg_notify_opportunity ON contextual_opportunities;
    CREATE TRIGGER trg_notify_opportunity
      AFTER INSERT ON contextual_opportunities
      FOR EACH ROW
      WHEN (NEW.status = 'active' AND NEW.confidence >= 60)
      EXECUTE FUNCTION notify_on_opportunity_surfaced();
  END IF;
END $$;

-- ── 3. Risk Mitigations ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notify_on_risk_mitigation()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
  VALUES (
    NEW.user_id,
    NEW.tenant_id,
    'risk_mitigation_suggestion',
    'Risk Mitigation',
    COALESCE(NEW.suggested_adjustment, 'A risk mitigation has been suggested for you.'),
    jsonb_build_object('entity_id', NEW.id::text, 'domain', COALESCE(NEW.domain, 'general')),
    'push_and_inapp',
    'p1'
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_risk_mitigation error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'risk_mitigations') THEN
    DROP TRIGGER IF EXISTS trg_notify_risk_mitigation ON risk_mitigations;
    CREATE TRIGGER trg_notify_risk_mitigation
      AFTER INSERT ON risk_mitigations
      FOR EACH ROW
      WHEN (NEW.status = 'active' AND NEW.confidence >= 50)
      EXECUTE FUNCTION notify_on_risk_mitigation();
  END IF;
END $$;

-- ── 4. Memory Garden Grew (high-importance items only) ─────────────────────

CREATE OR REPLACE FUNCTION notify_on_memory_garden_grew()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
  VALUES (
    NEW.user_id,
    NEW.tenant_id,
    'memory_garden_grew',
    'Memory Garden Grew',
    'A significant new memory has been added to your garden.',
    jsonb_build_object('entity_id', NEW.id::text, 'category_key', COALESCE(NEW.category_key, 'uncategorized')),
    'silent',
    'p3'
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_memory_garden_grew error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memory_items') THEN
    DROP TRIGGER IF EXISTS trg_notify_memory_garden ON memory_items;
    CREATE TRIGGER trg_notify_memory_garden
      AFTER INSERT ON memory_items
      FOR EACH ROW
      WHEN (NEW.importance > 50)
      EXECUTE FUNCTION notify_on_memory_garden_grew();
  END IF;
END $$;

-- ── 5. Lab Reports ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notify_on_lab_report_processed()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
  VALUES (
    NEW.user_id,
    NEW.tenant_id,
    'lab_report_processed',
    'Lab Report Ready',
    'Your lab report has been processed and results are available.',
    jsonb_build_object('entity_id', NEW.id::text, 'source', COALESCE(NEW.source, 'manual')),
    'inapp',
    'p2'
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_on_lab_report_processed error: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'lab_reports') THEN
    DROP TRIGGER IF EXISTS trg_notify_lab_report ON lab_reports;
    CREATE TRIGGER trg_notify_lab_report
      AFTER INSERT ON lab_reports
      FOR EACH ROW
      EXECUTE FUNCTION notify_on_lab_report_processed();
  END IF;
END $$;
