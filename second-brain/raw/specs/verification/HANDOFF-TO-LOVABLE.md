# Handoff Instructions for Lovable: Stripe Connect Integration

**To Lovable Agent:** The Stripe Connect integration (VTID-01230 & VTID-01231) **IS ALREADY IMPLEMENTED** in the repository. You are likely looking at a stale version of the project or checking for Supabase Edge Functions which were bypassed in favor of a centralized **Gateway Service Architecture**.

Please sync your editor with the following files and follow the architectural notes below.

---

## 📂 1. Locate the Existing Files
All frontend code is located in the `temp_vitana_v1` directory (or your current work directory). Do NOT check for Edge Functions.

### New Components & Pages:
- `src/hooks/useCreator.ts` (API Hooks for Gateway)
- `src/components/creator/EnablePaymentsButton.tsx` (Smart Payment Button)
- `src/components/creator/CreatorPaymentsSection.tsx` (Billing UI)
- `src/pages/CreatorOnboarded.tsx` (Success Redirect Page)

### Modified Core Files (Verify these sections):
- `src/App.tsx` (Added `/creator/onboarded` route)
- `src/pages/settings/Billing.tsx` (Integrated `<CreatorPaymentsSection />`)
- `src/components/liverooms/CreateLiveRoomDialog.tsx` (Integrated payment gating)

---

## 🏗️ 2. Professional Architecture Note
We are NOT using Supabase Edge Functions for this integration.
- **Backend:** Already live at `https://gateway-q74ibpv6ia-uc.a.run.app`.
- **Logic:** The `useCreator.ts` hooks talk directly to the Gateway using the user's Supabase JWT.
- **Webhooks:** Managed by the Gateway at `/api/v1/stripe/webhook`.

---

## 🛠️ 3. How to Verify
1. **Search for "CreatorPaymentsSection"** in your global search. You will find it imported in `Billing.tsx`.
2. **Search for "/creator/onboarded"** in `App.tsx`.
3. **Open `src/hooks/useCreator.ts`** to see the `GATEWAY_BASE` and the `useQuery` hooks.

---

## ✅ Action for Lovable
Please use these files to verify the implementation. **Do not rebuild the logic.** If you don't see these files, please perform a "Refresh" or "Pull" from the repository where these changes were committed.
