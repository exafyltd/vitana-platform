# Reverse proxy sidecar: routes /auth/v1/* to real Supabase (GoTrue stays
# the identity source per standing rule), /rest/v1/* to the PostgREST
# container running alongside it in the same ECS task, on Aurora.
FROM nginx:1.27-alpine

RUN rm /etc/nginx/conf.d/default.conf 2>/dev/null || true
# Deliberately NOT under /etc/nginx/templates/ — that path triggers the base
# image's own docker-entrypoint.d envsubst-on-templates script, which writes
# into conf.d/ and would double-process (and nest) this file since it's a
# full nginx.conf, not a conf.d fragment. Substituting and writing it
# ourselves below sidesteps that entirely.
COPY nginx.conf.template /etc/nginx/nginx.conf.template

# SUPABASE_AUTH_HOST is injected at container start (e.g. inmkhvwdcuyhnxkgfvsb.supabase.co).
ENV SUPABASE_AUTH_HOST=""

EXPOSE 8080

CMD ["/bin/sh", "-c", "envsubst '$${SUPABASE_AUTH_HOST}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf && exec nginx -g 'daemon off;'"]
