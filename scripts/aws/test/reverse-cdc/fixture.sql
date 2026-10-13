-- Supabase-like public schema: user triggers (one notifies, one already disabled, one ALWAYS),
-- an FK (internal triggers must stay enabled) and a non-public table that must be untouched.
CREATE TABLE public.user_notifications (id serial PRIMARY KEY, body text);
CREATE TABLE public.chat_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid, receiver_id uuid, content text);
CREATE TABLE public.chat_reads (id serial PRIMARY KEY, message_id uuid REFERENCES public.chat_messages(id));
CREATE TABLE public.voucher_orders (id serial PRIMARY KEY, updated_at timestamptz);
CREATE FUNCTION public.notify_on_chat_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.user_notifications (body) VALUES ('msg ' || NEW.content); RETURN NEW; END $$;
CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_notify_chat_message AFTER INSERT ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION public.notify_on_chat_message();
CREATE TRIGGER voucher_orders_updated_at BEFORE UPDATE ON public.voucher_orders FOR EACH ROW EXECUTE FUNCTION public.touch();
CREATE TRIGGER was_disabled BEFORE UPDATE ON public.chat_reads FOR EACH ROW EXECUTE FUNCTION public.touch();
ALTER TABLE public.chat_reads DISABLE TRIGGER was_disabled;
CREATE TRIGGER always_on BEFORE INSERT ON public.voucher_orders FOR EACH ROW EXECUTE FUNCTION public.touch();
ALTER TABLE public.voucher_orders ENABLE ALWAYS TRIGGER always_on;
CREATE SCHEMA other;
CREATE TABLE other.t (id int);
CREATE TRIGGER other_trg BEFORE INSERT ON other.t FOR EACH ROW EXECUTE FUNCTION public.touch();
CREATE TABLE public.state_before AS SELECT c.relname, t.tgname, t.tgenabled::text AS e FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid ORDER BY 1, 2;
