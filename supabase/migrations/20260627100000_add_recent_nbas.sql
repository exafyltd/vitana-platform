-- Per-user history of the next-best-actions Vitana has already suggested, so the
-- conversation opener ADVANCES instead of repeating the same suggestion every
-- open. The Next-Best-Action engine reads this to demote recently-suggested
-- actions and pick the next-best fresh one; the opener appends the chosen action
-- after speaking it.
--
-- Shape: a JSON array of { key, at } objects, most-recent last, capped in code
-- (~8 entries). Empty array = nothing suggested yet.
ALTER TABLE public.user_journey
  ADD COLUMN IF NOT EXISTS recent_nbas jsonb NOT NULL DEFAULT '[]'::jsonb;
