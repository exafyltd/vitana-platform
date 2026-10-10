# Self-hosted Supabase Realtime against Aurora (VTID-05023, plan part 7a).
#
# The upstream image, pinned by index digest: supabase/realtime:v2.134.10 —
# the exact version Supabase's own self-host stack pins
# (supabase/supabase docker/docker-compose.yml, master, 2026-10-10), published
# 2026-09-07. Bump only together with a green `npm run test:realtime-local`.
#
# One change: priv/repo/seeds.exs is replaced by ./seeds.exs, so that the
# tenant's JWT secret (TENANT_JWT_SECRET = the Supabase JWT secret members'
# tokens are signed with) is separate from API_JWT_SECRET (the management
# API's /api/tenants credential) and the tenant's CDC connection uses TLS.
# Upstream seeds copy API_JWT_SECRET into the tenant, which would make every
# member token — and the public anon key — a valid management-API credential.
# See README.md "Two secrets, not one".
FROM supabase/realtime:v2.134.10@sha256:cbcc6a7986fc28b6dcffa798b077d5fb9c69cd25500371ab49147a86d7edbb03

COPY --chown=nobody:root seeds.exs /app/lib/realtime-2.134.10/priv/repo/seeds.exs

# IPv4 everywhere (the upstream image defaults to inet6 distribution; the
# Vitana VPC subnets and Aurora endpoints are IPv4).
ENV ERL_AFLAGS="-proto_dist inet_tcp" \
    ECTO_IPV6=false \
    DB_IP_VERSION=ipv4 \
    REALTIME_IP_VERSION=ipv4 \
    SEED_SELF_HOST=true \
    SELF_HOST_TENANT_NAME=realtime \
    APP_NAME=realtime \
    PORT=4000

EXPOSE 4000
