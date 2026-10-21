-- VTID-01232: Enforce valid state transitions on vtid_ledger
--
-- Valid transitions:
--   pending  -> active, cancelled
--   active   -> complete, blocked, cancelled
--   blocked  -> active, cancelled
--   complete -> (terminal, no transitions)
--   cancelled -> (terminal, no transitions)
--
-- This prevents:
--   - complete -> active (reopening finished work)
--   - cancelled -> active (resurrecting cancelled work)
--   - pending -> complete (skipping execution)
--   - any invalid state value

CREATE OR REPLACE FUNCTION enforce_vtid_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  valid_transitions JSONB := '{
    "pending":   ["active", "cancelled"],
    "active":    ["complete", "blocked", "cancelled"],
    "blocked":   ["active", "cancelled"],
    "complete":  [],
    "cancelled": []
  }'::JSONB;
  allowed_statuses JSONB;
BEGIN
  -- Skip if status hasn't changed
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Validate new status is a known value
  IF NEW.status NOT IN ('pending', 'active', 'complete', 'blocked', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid VTID status: %. Valid values: pending, active, complete, blocked, cancelled', NEW.status;
  END IF;

  -- Check if transition is allowed
  allowed_statuses := valid_transitions -> OLD.status;

  IF allowed_statuses IS NULL THEN
    RAISE EXCEPTION 'Unknown current status: %', OLD.status;
  END IF;

  IF NOT (allowed_statuses ? NEW.status) THEN
    RAISE EXCEPTION 'Invalid VTID state transition: % -> % for VTID %. Allowed transitions from %: %',
      OLD.status, NEW.status, NEW.vtid, OLD.status, allowed_statuses;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to vtid_ledger
DROP TRIGGER IF EXISTS trg_vtid_status_transition ON vtid_ledger;
CREATE TRIGGER trg_vtid_status_transition
  BEFORE UPDATE ON vtid_ledger
  FOR EACH ROW
  EXECUTE FUNCTION enforce_vtid_status_transition();

-- Add comment for documentation
COMMENT ON FUNCTION enforce_vtid_status_transition() IS
  'VTID-01232: Enforces valid state transitions on vtid_ledger. Terminal states (complete, cancelled) cannot be reversed.';
