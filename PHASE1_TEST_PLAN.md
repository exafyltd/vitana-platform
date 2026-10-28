# VTID-02403 — AI Subscription Connect Phase 1 Test Plan

**Shipped:** 2026-04-19
**Scope:** API-key paste + live verify for ChatGPT (OpenAI) and Claude (Anthropic), Maxina tenant only.

---

## Prerequisites (one-time, operator/infra)

1. **Supabase migration** — apply `supabase/migrations/20260419000000_vtid_02403_ai_assistants_phase1.sql` in production. If Supabase CLI auto-applies on merge, confirm via:
   ```sql
   SELECT id, category FROM public.connector_registry
     WHERE category = 'ai_assistant';
   -- Expect rows: chatgpt, claude
   SELECT tenant_id, provider, allowed FROM public.ai_provider_policies
     WHERE provider IN ('chatgpt','claude');
   -- Expect 2 rows for the Maxina tenant, allowed=true.
   ```
2. **Cloud Run env var** — encryption key for credential vault. Run **once**:
   ```bash
   gcloud run services update gateway \
     --update-env-vars="AI_CREDENTIALS_ENC_KEY=$(openssl rand -hex 32)" \
     --region=us-central1 --project=lovable-vitana-vers1
   ```
   Without this env var, `POST /apikey/:provider` returns 503 `ENCRYPTION_UNAVAILABLE`.
3. **Deploy** — confirm Auto Deploy dispatched `EXEC-DEPLOY.yml` for `gateway` (commit messages contain `VTID-02403`). If it didn't, dispatch manually with inputs `{vtid: "VTID-02403", service: "gateway", environment: "dev", health_path: "/alive", initiator: "auto"}`. vitana-v1 deploy follows its own `DEPLOY.yml`.

---

## End-user test (Maxina community)

Exact URL the user opens: **`https://vitanaland.com/settings/connected-apps`** (or whichever Maxina frontend origin — same path under `/settings/connected-apps`).

Login: any active Maxina user (e.g., test user UUID `a27552a3-0257-4305-8ed0-351a80fd3701`).

### Step-by-step

1. **Open Settings → Connected Apps.**
   Navigate to `/settings/connected-apps`.
2. **Find AI Assistants section.**
   At the top of the Connected Apps tab, a new section titled **"AI Assistants"** appears with two cards: **ChatGPT** and **Claude**.
3. **Click ChatGPT → Connect.**
   The **AI Assistant Connect Modal** opens with a `Get your API key at platform.openai.com/api-keys` link, a password-masked text field (placeholder `sk-…`) and a **Connect** button.
4. **Paste an OpenAI key and click Connect.**
   The button shows **Saving…** then **Verifying…**. Under the hood:
   - `POST /api/v1/integrations/ai-assistants/apikey/chatgpt` encrypts the key (AES-256-GCM) and upserts `user_connections`.
   - `POST /api/v1/integrations/ai-assistants/verify/chatgpt` calls `GET https://api.openai.com/v1/models` with the decrypted key.
5. **Confirm verified.**
   Modal shows **ChatGPT connected and verified** with the key redacted as `sk-•••XXXX` and a latency in ms. Click **Done**.
   Back on the card, badge flips to **Active**. Expanded content shows `Status: ok` and last-verified timestamp.
6. **Open Command Hub → Integrations & Tools → LLM Providers.**
   Navigate to the Command Hub. The `OpenAI` provider card now shows a **1 connection** badge next to the `N models` badge, and a **Manage** button.
7. **Click Manage on the OpenAI card.**
   A right-side slide-in drawer opens with four sections:
   - **Catalog** — display_name, enabled toggle.
   - **Tenant Policy (Maxina)** — allowed toggle, allowed_models text input, cost_cap_usd_month input.
   - **Active Connections** — table with 1 row (your connection, key prefix/last4, last verified timestamp, status `ok`).
   - **Recent Consent Log** — shows `connect` and `verify_ok` entries from step 4.

Repeat for **Claude** (`sk-ant-…` key).

Also check `Admin → Tenants → Maxina` detail panel — the new **AI Policy** section lists both providers with "Allowed" badges; clicking **Edit** opens the same drawer.

---

## Post-deploy curl verification

```bash
# Gateway /alive
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://gateway-q74ibpv6ia-uc.a.run.app/alive
# Expect: 200 application/json

# Unauthenticated providers call — must be JSON 401, not HTML 404
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/integrations/ai-assistants/providers
# Expect: 401 application/json

# Fake bearer
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  -H "Authorization: Bearer fake.jwt.here" \
  https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/integrations/ai-assistants/providers
# Expect: 401 application/json

# LLM models augmented with connection counts
curl -s https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/llm/models | jq '.data[] | select(.provider=="openai" or .provider=="anthropic") | {provider, model_id, connector_id, user_connections_count}'
# Expect: openai + anthropic rows with connector_id ("chatgpt"/"claude") and user_connections_count field
```

If any endpoint returns `text/html` 404, the deploy did not ship the new routes — check `EXEC-DEPLOY.yml` runs and Cloud Run revision.

---

## Failure modes to recognise

| Symptom | Cause | Fix |
|---|---|---|
| Modal stuck on Saving, 503 `ENCRYPTION_UNAVAILABLE` | `AI_CREDENTIALS_ENC_KEY` not set on Cloud Run | Run the `gcloud run services update gateway …` command above |
| Modal error `PROVIDER_NOT_ALLOWED_FOR_TENANT` | Tenant has no row in `ai_provider_policies` or `allowed=false` | Apply the migration, or add row via admin `PUT /api/v1/admin/ai-assistants/policies/maxina` |
| Verify returns `unauthorized` | User pasted wrong or revoked key | Click Replace key in the card and paste a fresh one |
| After 3 failed verifies, card greys out | Safety: connection auto-deactivated | Re-connect — we set `is_active=false` after 3 failures |

---

## Files of record

- `supabase/migrations/20260419000000_vtid_02403_ai_assistants_phase1.sql`
- `services/gateway/src/routes/ai-assistants.ts`
- `services/gateway/src/routes/admin/ai-integrations.ts`
- `services/gateway/src/routes/llm.ts` (added `/models` endpoint)
- `services/gateway/src/frontend/command-hub/app.js` (Manage drawer + Tenant AI Policy section)
- `services/gateway/src/frontend/command-hub/styles.css` (`.ai-drawer` block)
- `exafyltd/vitana-v1`:
  - `src/hooks/useAIAssistants.ts`
  - `src/components/AIAssistantConnectModal.tsx`
  - `src/pages/settings/ConnectedApps.tsx`
  - `src/components/settings/MobileConnectedAppsView.tsx`
  - `src/components/settings/integrationData.ts`
