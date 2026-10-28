# Business Hub

> The Business Hub is VITANA's unified business performance dashboard where professionals and community members manage services, clients, earnings, inventory reselling, and promotions -- with AI-guided onboarding to help users start earning.

## Overview

The Business Hub (BIZ-001 through BIZ-005) provides a simplified mobile version of the full desktop business management experience. It sits in the sidebar navigation hierarchy between Health and Wallet.

**Route**: `/business`

## Screen Structure

| Screen ID | Name | Route | Tabs |
|-----------|------|-------|------|
| BIZ-001 | Overview | `/business` | Snapshot, History |
| BIZ-002 | Services | `/business/services` | My Services, My Events, Packages |
| BIZ-003 | Clients | `/business/clients` | Active, Prospects, History |
| BIZ-004 | Sell & Earn | `/business/sell-earn` | Inventory, Promotions |
| BIZ-005 | Analytics | `/business/analytics` | Performance, Earnings, Growth |

## Earning Paths

The AI guidance system presents four earning paths:

### Path A: Direct Sales (Events/Meetups)
Create and host events, sell tickets directly. Earnings = ticket revenue collected.
- Navigate: Business Hub -> Overview -> Create Event
- Complete event form (title, date, venue, ticket price, capacity) -> Publish

### Path B: Services (Bookable Sessions)
Offer bookable sessions (coaching, yoga, consulting).
- Navigate: Business Hub -> Services -> Create Service
- 4-step wizard: Basics, Pricing, Availability, Review -> Publish
- Clients book and pay; earnings move to Wallet after session completion

### Path C: Reselling (Inventory)
Earn commissions by selling other event hosts' events.
- Navigate: Business Hub -> Sell & Earn -> Inventory
- Browse available events, get unique reseller link, share via WhatsApp/Instagram
- Commission formula: `Earnings per ticket = Ticket price x Commission rate`
- Example: EUR 99 workshop at 20% commission = EUR 19.80 per ticket

### Promotions
Amplify reach for events, services, or reseller items.
- Navigate: Business Hub -> Sell & Earn -> Promotions
- Create campaign, select item to promote, choose channels, generate shareable link

## Earnings and Wallet Integration

| Term | Meaning |
|------|---------|
| **Earnings** | Total money generated from sales (all time or filtered) |
| **Pending Payout** | Earned but not yet available for withdrawal |
| **In Wallet** | Available balance for withdrawal or use |

**KPI Cards in Snapshot:** Total Earnings, Last 30 Days, Pending Payout, In Wallet -- each tappable to drill into History or Wallet views.

## Cross-Module Navigation

- BIZ-001 (Overview) links to Wallet (WLLT-001)
- BIZ-002 (Services) opens Create Package and Create Event dialogs
- BIZ-003 (Clients) links to Sharing Hub (SHAR-001)
- BIZ-004 (Sell & Earn) links to Campaigns (SHAR-002)
- BIZ-005 (Analytics) links to Wallet and Sharing Hub

## AI Guidance

The AI assistant guides users through business setup with an "always suggest one next best action" principle.

**Intent mapping:**
- "I want to earn" / "Help me set up my business" -> Universal Onboarding Flow
- "Create my first event" -> Path A: Direct Sales
- "Offer a service" / "Sell my coaching" -> Path B: Services
- "Resell events" -> Path C: Reselling
- "Promote my event" -> Promotions Flow
- "Where are my earnings?" -> Earnings & Wallet Section

**Default fallback:** "Ready to start earning? Let's set up your first event, service, or reseller link."

## Tenant Restrictions

| Tenant | BIZ Access |
|--------|------------|
| Maxina | Full (all 5 screens) |
| Alkalma | No Sell & Earn (BIZ-004 restricted) |
| Earthlinks | No Sell & Earn or Analytics (BIZ-004, BIZ-005 restricted) |
| Exafy | Full (all 5 screens) |

## Mobile Experience

On mobile, the Business Hub is accessible via the sidebar menu (not bottom nav by default). It presents simplified KPIs and quick actions optimized for the mobile form factor. The input bar is hidden on the Business surface since it is action-based, not conversational.

## Future: Products

Product selling is planned but not yet available. Will include listing physical/digital products, pricing, inventory management, and order fulfillment.

## Related Pages

- [[mobile-pwa-architecture]] -- Business Hub as mobile surface
- [[role-based-access]] -- Business Hub accessible to Community role and above
- [[multi-tenancy]] -- Tenant-specific Business Hub restrictions
- [[screen-registry]] -- BIZ-001 to BIZ-005 screen details
- [[apple-compliance]] -- Wallet/earnings and iOS compliance

## Sources

- `raw/guides/AI_GUIDANCE_BUSINESS_HUB.md`
- `raw/screen-registry/NAVIGATION_MAP.md`
- `raw/screen-registry/ROLE_SCREEN_MATRIX.md`
- `raw/screen-registry/TENANT_SCREEN_AVAILABILITY.md`

## Last Updated

2026-04-12
