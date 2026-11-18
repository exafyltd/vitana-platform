-- Bootstrap-key (tenants.id) proof for 20261102140000 only: the FK resolves to tenants(id) and a host row inserts.
INSERT INTO public.tenants (id, slug, name) VALUES ('05507000-0000-4000-8000-0000000000a2', 't05507a', 'Tenant A');
INSERT INTO public.tenant_domains (tenant_id, host) VALUES ('05507000-0000-4000-8000-0000000000a2', 'id-schema.example.org');
SELECT pg_get_constraintdef(oid) AS fk FROM pg_constraint WHERE conname = 'tenant_domains_tenant_fkey';
SELECT count(*) AS rows FROM public.tenant_domains;
