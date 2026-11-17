-- VTID-05023 part 6, section B of docs/validation/VTID-05023/side-effects.md — the two
-- Supabase triggers that call pg_net, rebuilt on Aurora as an OUTBOX.
--
-- Aurora has no pg_net. If notify_welcome_discount() reached Aurora unchanged, every
-- INSERT into user_discount_codes (new-member provisioning included) would hit
-- "schema net does not exist". Here both trigger functions INSERT one row into
-- public.outbound_http_requests instead, and the gateway worker
-- services/gateway/src/services/outbound-http-worker.ts (OUTBOUND_HTTP_WORKER_ENABLED)
-- claims, sends, retries (backoff, 5 attempts) and marks the row sent/failed.
--
-- Same URL, method, header NAMES and body as the Supabase versions:
--   notify_test_user_confirmation  supabase/migrations 20260518010000_test_user_confirmation_vault.sql (vitana-v1)
--   notify_welcome_discount        supabase/migrations 20260210141933_0d5c2768-....sql (vitana-v1)
-- Secrets are never stored in a row. A secret header value is a REFERENCE,
-- {"secret_ref": "<name>"}, that only the worker resolves from its own environment:
--   email_trigger_secret          -> EMAIL_TRIGGER_SECRET            (was vault 'email_trigger_secret')
--   supabase_service_role_bearer  -> "Bearer " + SUPABASE_SERVICE_ROLE_KEY (was vault 'service_role_key')
--
-- The triggers themselves (trg_send_test_user_confirmation, on_discount_code_created_send_email)
-- already exist on Aurora (services/postgrest-aurora-proxy/aurora-restore-04-triggers.sql);
-- only the functions they call are replaced.
--
-- RLS on, no policies: anon/authenticated get nothing. The trigger functions and the
-- worker RPCs are SECURITY DEFINER (owner bypasses RLS) and the RPCs are EXECUTE-able by
-- service_role only.
--
-- One statement per line for scripts/aws/aurora-run-sql.sh. Idempotent. Apply on the
-- clone first, then on Aurora before the auth bridge goes live.
CREATE TABLE IF NOT EXISTS public.outbound_http_requests (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), url text NOT NULL, method text NOT NULL DEFAULT 'POST', headers jsonb NOT NULL DEFAULT '{}'::jsonb, body jsonb, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, last_error text, sent_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz, source text, CONSTRAINT outbound_http_requests_status_chk CHECK (status IN ('pending', 'sending', 'sent', 'failed')), CONSTRAINT outbound_http_requests_method_chk CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')));
COMMENT ON TABLE public.outbound_http_requests IS 'VTID-05023: outbox for HTTP calls Supabase made with pg_net. Sent by the gateway outbound-http-worker. Header values that are secrets are stored as {"secret_ref": name}, never the secret.';
CREATE INDEX IF NOT EXISTS outbound_http_requests_due_idx ON public.outbound_http_requests (next_attempt_at, id) WHERE status IN ('pending', 'sending');
ALTER TABLE public.outbound_http_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.outbound_http_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.outbound_http_requests_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.outbound_http_requests TO service_role;
-- Worker RPC 1: claim up to p_limit due rows (pending and due, or 'sending' whose lease expired), FOR UPDATE SKIP LOCKED so two gateway tasks never take the same row. attempts is incremented here; a row whose lease expired after its final attempt is marked failed, never re-sent.
CREATE OR REPLACE FUNCTION public.outbound_http_claim(p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 120, p_max_attempts integer DEFAULT 5) RETURNS SETOF public.outbound_http_requests LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$ BEGIN UPDATE public.outbound_http_requests SET status = 'failed', locked_until = NULL, last_error = left(coalesce(last_error || ' | ', '') || 'lease expired after the final attempt', 2000) WHERE status = 'sending' AND locked_until < now() AND attempts >= p_max_attempts; RETURN QUERY UPDATE public.outbound_http_requests r SET status = 'sending', attempts = r.attempts + 1, locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)) WHERE r.id IN (SELECT q.id FROM public.outbound_http_requests q WHERE ((q.status = 'pending' AND q.next_attempt_at <= now()) OR (q.status = 'sending' AND q.locked_until < now())) AND q.attempts < p_max_attempts ORDER BY q.id LIMIT greatest(1, least(p_limit, 100)) FOR UPDATE SKIP LOCKED) RETURNING r.*; END $fn$;
-- Worker RPC 2: mark sent. Only the holder of the current attempt can complete (id + attempts), so a late worker whose lease expired cannot flip a row another worker re-claimed. Returns false when nothing matched.
CREATE OR REPLACE FUNCTION public.outbound_http_complete(p_id bigint, p_attempt integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$ BEGIN UPDATE public.outbound_http_requests SET status = 'sent', sent_at = now(), locked_until = NULL, last_error = NULL WHERE id = p_id AND status = 'sending' AND attempts = p_attempt; RETURN FOUND; END $fn$;
-- Worker RPC 3: record a failed attempt. p_retry_in_seconds NULL = final (status failed); otherwise back to pending, due after the backoff. Returns the new status, or NULL when the attempt no longer holds the row.
CREATE OR REPLACE FUNCTION public.outbound_http_fail(p_id bigint, p_attempt integer, p_error text, p_retry_in_seconds integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$ DECLARE v_status text; BEGIN UPDATE public.outbound_http_requests SET status = CASE WHEN p_retry_in_seconds IS NULL THEN 'failed' ELSE 'pending' END, next_attempt_at = CASE WHEN p_retry_in_seconds IS NULL THEN next_attempt_at ELSE now() + make_interval(secs => greatest(p_retry_in_seconds, 0)) END, locked_until = NULL, last_error = left(p_error, 2000) WHERE id = p_id AND status = 'sending' AND attempts = p_attempt RETURNING status INTO v_status; RETURN v_status; END $fn$;
REVOKE ALL ON FUNCTION public.outbound_http_claim(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbound_http_complete(bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbound_http_fail(bigint, integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_http_claim(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbound_http_complete(bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.outbound_http_fail(bigint, integer, text, integer) TO service_role;
-- Aurora notify_test_user_confirmation(): same URL (hard-coded in the Supabase version), same headers (Content-Type + X-Trigger-Secret, now a reference) and body {application_id}. The Supabase version skipped with a WARNING when the vault secret was missing; here the secret is resolved by the worker, so the row is always queued and a missing EMAIL_TRIGGER_SECRET shows up as the row's last_error.
