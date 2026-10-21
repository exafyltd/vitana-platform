---
chapter: 0.10
screen_id: null
title: Permissions, consent & data sharing
tenant: maxina
host_screens: [COM-MEMORY_PERMISSIONS, COM-DATA_CONSENT, COM-PRIVACY, COM-CONNECTED_APPS]
keywords: [permissions, consent, data sharing, privacy, gdpr, datenschutz, einwilligung, berechtigungen, data consent, what can vitana see, datenfreigabe]
related_concepts: ["0.9", "0.11"]
related_screens: [COM-MEMORY_PERMISSIONS, COM-DATA_CONSENT, COM-PRIVACY]
---

## What it is

Permissions are the controls that decide what Vitana can capture, what it can share with the AI brain, what it can show in your community, and what gets handed to third-party services (trackers, payment providers, marketplace sellers). The system has three permission surfaces:

1. **Memory Permissions** (`/memory/permissions`) — per-category toggles for what gets remembered
2. **Data & Consent** (`/sharing/data-consent`) — what flows into the community / sharing layer (groups, leaderboards)
3. **Privacy** (`/settings/privacy`) — the catch-all for retention, GDPR exports, account deletion

There is also **Connected Apps** (`/settings/connected-apps`) which manages OAuth integrations (Apple Health, Oura, Google Calendar, etc.) — each integration has its own consent grant and you can revoke it at any time.

## Why it matters

Vitana's promise to remember everything you tell it only works if you can also tell it to forget, to stop listening on a topic, or to keep a category private. Without granular permission, "infinite memory" feels invasive. With it, you stay in control: you can pause health capture during a difficult medical period, hide your finances from community-facing surfaces, or revoke a tracker connection without losing the memories it produced.

## Where to find it

- **Memory → Permissions** — the most-used surface; per-category memory toggles
- **Sharing → Data & Consent** — community-facing sharing controls
- **Settings → Privacy** — retention, exports, account deletion
- **Settings → Connected Apps & Integrations** — OAuth integrations and revocation

## How to use it

1. Start with Memory Permissions. You see the 13 memory categories with a toggle and a one-line "what this means" description for each.
2. Toggle off any category you don't want Vitana to capture (e.g. Finance & Assets if you don't want financial inferences in your timeline).
3. Open Data & Consent and review which surfaces show data publicly. Leaderboards, member rankings, and event RSVPs are opt-in per category.
4. If you want a full export: Settings → Privacy → "Export my data" produces a JSON download of every memory and event.
5. To revoke a tracker: Settings → Connected Apps → tap the integration → Revoke. The OAuth token is deleted; existing memories from that source remain unless you also delete them.
6. To delete the account entirely: Settings → Privacy → "Delete account". This is irreversible after the 14-day grace period.

## Related

- See concept 0.9 for memory itself, which permissions gate.
- See concept 0.11 for tenant context — your Maxina permissions don't bleed across tenants.
- Memory Permissions (chapter 10.5) and Data & Consent (chapter 9.5) are the screen-level documentation.
