# Responses to sparring round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The partner could not verify the vitana-v1 premises because that repo was unpinned in its session. I verified every cited premise against the current vitana-v1 checkout and they hold: brand CSS vars are set with the comment 'nothing consumes them yet — C2' (src/hooks/useTenant.tsx:122-133); adminFetch JSDoc claims it injects X-Vitana-Tenant/X-Vitana-Active-Role (src/lib/admin-api.ts:5-7) but the code sends only Content-Type + Authorization (src/lib/admin-api.ts:33-41); hardcoded maxina slug in src/pages/CommerceJoin.tsx:142,149,176 and the OAuth redirect fallback in src/components/AuthGuard.tsx:267,271; navigate('/maxina') in src/pages/RedeemVoucher.tsx:65,108,135,161 and src/components/voucher/RedemptionLanding.tsx:47,51 (plus the hardcoded '/images/maxina-logo.png' at :61); AppHooksInitializer defined at src/App.tsx:469 and mounted inside <BrowserRouter> at src/App.tsx:772; scripts/native/gen-tokens.mjs exists. Added a 'Premises re-verified against vitana-v1 (current checkout)' line to the plan so the record carries the verification; corrected the one line that had drifted (useTenant setProperty block is 122-133, not 124-133).",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Confirmed the gap. adminFetch is called from commerce/admin/community surfaces (vcaop portal, partner-onboarding, community/find-member, voice-lab, conversation, backoffice) — none of those gateway routes read X-Vitana-Tenant today. The only current readers are services/gateway/src/routes/autopilot-recommendations.ts:430,1799,2336 and calendar.ts:1054, which adminFetch does not call, and reminders.ts:58 documents that header-based tenant resolution was deliberately removed there. So injecting the headers now is preparatory plumbing with no immediate consumer. Reframed the adminfetch-header lane as explicitly preparatory: the Vitest proves only that the client SENDS the headers (present with a tenant/role, absent without), and the plan/lane/tasks now state the gateway-side reads are a named WS7 follow-on, not part of this lane. The JSDoc fix (make the doc match reality) is the real member-neutral value this lane ships now.",
    "deferred_to": "WS7 follow-on gateway tenant-scoping VTID (named in plan Out of scope / adminfetch-header lane body)"
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: services/gateway/src/middleware/cors.ts:67 is the allowedHeaders array containing X-Vitana-Active-Role and X-Vitana-Tenant; line 71 is inside the VTID-02036 credentials comment block. Corrected every citation from cors.ts:71 to cors.ts:67 in plan.md Problem #2, the cors-config references and the adminfetch-header lane body.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Confirmed: the gateway serves share-cards server-side via publicProfileOgRouter (services/gateway/src/index.ts:193-194 → routes/public-profile-og.ts) and the email-brand-code lane already owns the OG workers (og-share/og-event/og-campaign/og-short). Share-card crawlers do not run JS, so a client-side og:* mutation in the SPA is ineffective for its primary purpose. Scoped useTenantMeta() to document.title and favicon href ONLY (both legitimate client-side mutations); removed OG-tag mutation from its responsibility; per-tenant share-card branding relies entirely on the server-side OG worker lane (email-brand-code). Updated plan Fix (brand-surface), tasks and the brand-surface lane acceptance accordingly.",
    "deferred_to": null
  }
]
```
