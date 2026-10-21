## 🌍 Environments
- **Live Version:** [vitanaland.com](https://vitanaland.com)
- **Preview Version:** [preview--vitana-v1.lovable.app](https://preview--vitana-v1.lovable.app/home)

## 🏗️ Pre-Verification Check
1. Ensure the **Gateway** is live: `https://gateway-q74ibpv6ia-uc.a.run.app/alive`
2. Ensure you are logged into the frontend as a user with the **Creator** role.

---

## 🧪 Test Case 1: Creator Onboarding Flow
1. **Navigate to:** Settings > Billing
2. **Action:** Click "Enable Payments" in the **Creator Payments** section.
3. **Expectation:** You should be redirected to a Stripe Connect onboarding page.
4. **Action (Success):** Complete the Stripe onboarding flow (use test data if available).
5. **Expectation:** You should be redirected back to the app (e.g., `vitanaland.com/creator/onboarded` or the preview URL equivalent) and see the "Payment Setup Complete!" success animation.

---

## 🧪 Test Case 2: Billing Management UI
1. **Navigate to:** Settings > Billing
2. **Expectation:** 
   - If not onboarded: "Enable Payments" (blue) is visible.
   - If partially onboarded: "Complete Setup" (yellow) is visible.
   - If fully onboarded: "Payments Enabled" (green checkmark) and "View Dashboard" are visible.
3. **Action:** Click "View Dashboard".
4. **Expectation:** A new tab opens to the Stripe Express dashboard.

---

## 🧪 Test Case 3: Paid Live Room Gating
1. **Navigate to:** Community > Live Rooms
2. **Action:** Click "Create Live Room".
3. **Action:** Toggle "Access Level" to **Paid (Group)**.
4. **Expectation (Non-onboarded):** 
   - A yellow warning box "Payment setup required" appears.
   - The "Create Room" button is disabled.
   - An "Enable Payments" button is visible inside the warning box.
5. **Expectation (Onboarded):** 
   - Price field appears.
   - Help text shows "You'll receive 90% of the price."
   - "Create Room" button is enabled after entering a price.

---

## 🧪 Test Case 4: Revenue Split Verification
1. **Navigate to:** Settings > Billing
2. **Expectation:** The **Revenue Examples** table correctly displays:
   - $9.99 Room → $8.99 You / $1.00 Fee
   - $19.99 Room → $17.99 You / $2.00 Fee
   - $49.99 Room → $44.99 You / $5.00 Fee

---

## ✅ Final Confirmation
Once all tests pass, the integration is officially ready for production deployment.
