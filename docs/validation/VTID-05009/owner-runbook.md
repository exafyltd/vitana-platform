# VTID-05009 — the developer morning pack token (owner runbook)

The code in this VTID is inert until the secret exists: with the secret absent, neither deploy wires the token, and the hook prints "skipping".

**What a session cannot do:** create secrets, set repository variables, or set Claude Code environment secrets.

1. **Create the secret** (account `472838866351`, region `eu-central-1`). Use one random value of at least the route's minimum length. A 48-byte base64 value is fine:
   ```bash
   TOKEN=$(openssl rand -base64 48 | tr -d '\n')
   aws secretsmanager create-secret --region eu-central-1 \
     --name vitana/gateway/staging/dev-memory-pack-token --secret-string "$TOKEN"
   ```
   Production is optional: the hook defaults to the staging gateway, where developer memory lives. If you want it on production too, run the same command with `vitana/gateway/prod/dev-memory-pack-token`, then set the repository variable `DEV_MEMORY_PACK_TOKEN_PROD_ARN` (Settings → Secrets and variables → Actions → Variables) to the full ARN it prints.
2. **Next staging deploy** (any merge to `main` under `services/gateway/**`). The "Resolve dev-memory pack token" step logs `resolved … -> DEV_MEMORY_PACK_TOKEN`.
3. **Add the token to the Claude Code environment.** Set `DEV_MEMORY_PACK_TOKEN` to the same value in the environment's secrets.
4. **Check (read-only):**
   - `curl -s -o /dev/null -w '%{http_code}' https://preview-aws-gateway.vitanaland.com/api/v1/dev-memory/morning-pack` returns 401.
   - The same request with `-H "X-Dev-Memory-Token: $TOKEN"` returns 200.
   - A new session prints the morning pack at start.

The SessionStart hook is registered in `.claude/settings.json` by this VTID. It times out after 8 s and always exits 0, so it can never block or fail a session.
