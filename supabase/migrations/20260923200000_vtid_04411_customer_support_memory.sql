-- VTID-04411 / VTID-04412 — Phase 4 of docs/MEMORY-SYSTEM-PLAN.md.
--
-- Two new episode kinds in memory_items, both additive:
--
-- 'customer'        one episode per executed BackOffice CRM/sales command that
--                   is about a customer, lead, contact or opportunity. Stored
--                   under the requesting staff member with active_role
--                   'backoffice' (never personal recall), keyed by
--                   content_json->>'customer_key' so the BackOffice assistant
--                   can recall everything the team recorded about one customer.
--                   One row per command (unique on command_id).
--
-- 'support_ticket'  when a member's support ticket is resolved: one episode for
--                   the member (personal memory, active_role NULL) and one with
--                   active_role 'support' for the support team. Unique per
--                   (ticket_id, role).
--
-- Importance stays <= 50 in every writer, so trg_notify_memory_garden (which
-- notifies above 50) never fires for these.

INSERT INTO public.memory_categories (key, label, is_active) VALUES
  ('customer', 'Customer notes', true),
  ('support_ticket', 'Support tickets', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.memory_category_mapping (source_category, garden_category)
SELECT 'customer', 'business_projects'
WHERE NOT EXISTS (SELECT 1 FROM public.memory_category_mapping WHERE source_category = 'customer');

INSERT INTO public.memory_category_mapping (source_category, garden_category)
SELECT 'support_ticket', 'uncategorized'
WHERE NOT EXISTS (SELECT 1 FROM public.memory_category_mapping WHERE source_category = 'support_ticket');

CREATE INDEX IF NOT EXISTS idx_memory_items_customer_key
  ON public.memory_items (tenant_id, (content_json->>'customer_key'), occurred_at DESC)
  WHERE category_key = 'customer';

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_items_customer_command
  ON public.memory_items ((content_json->>'command_id'))
  WHERE category_key = 'customer';

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_items_support_ticket
  ON public.memory_items ((content_json->>'ticket_id'), (coalesce(active_role, '')))
  WHERE category_key = 'support_ticket';
