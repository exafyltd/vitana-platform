# VTID-01231: Deployment Recovery Plan for Claude

**Situation:** Deployment has failed 20+ times. Local fixes for build errors exist but have not been pushed to the remote repository. The governed pipeline (`EXEC-DEPLOY.yml`) also requires VTID registration.

---

## 🔍 Root Cause Analysis

1. **Unpushed Fixes:** There are 3 critical commits on the local `main` branch that address build failures:
   - `21fddf0`: Invalid Stripe API version string (was causing build crashes).
   - `8930b89`: TypeScript type mismatch in `callRpc`.
   - `9e060db`: Missing `BUILD_INFO` file (was causing Docker `COPY` failures).
2. **Governor Gate:** The `EXEC-DEPLOY.yml` pipeline has a **Hard Gate (VTID-0542)** that checks if the VTID exists in the OASIS ledger before allowing deployment.

---

## 🛠️ Instructions for Claude

Please execute the following steps in order to recover the deployment:

### Step 1: Register VTID-01231 in OASIS
The deployment governor will block any deploy attempt if the VTID is not registered. Run this command to create the ledger entry:

```bash
# Register VTID-01231 correctly in the ledger
curl -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/vtid/create \
  -H "Content-Type: application/json" \
  -d '{
    "task_family": "DEV",
    "task_module": "BACKEND",
    "title": "Stripe Connect Express Backend",
    "target_roles": ["DEV"]
  }'
```
> [!NOTE]
> If the `create` endpoint is not reachable, you must manually ensure `VTID-01231` exists in the `vtid_ledger` table via the Supabase Dashboard.

### Step 2: Push Local Fixes to Main
The current local `main` branch contains the 3 fixes mentioned above. Push them to trigger the `AUTO-DEPLOY` workflow:

```bash
git push origin main
```

### Step 3: Monitor the Pipeline
1. Check GitHub Actions for the `Auto Deploy` workflow.
2. It will dispatch `Exec Deploy (VTID Bridge)`.
3. Verify the "VTID Existence Check" step passes.

---

## 📝 Technical Verification

Once deployed, verify the service is running correctly:

```bash
# Verify health
curl https://gateway-q74ibpv6ia-uc.a.run.app/alive

# Verify Stripe version fix (non-crash)
curl https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/creators/status -H "Authorization: Bearer $JWT"
```
