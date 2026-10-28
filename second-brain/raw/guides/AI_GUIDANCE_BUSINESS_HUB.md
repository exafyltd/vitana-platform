# AI Guidance: My Business Hub

> **Purpose**: This script enables AI to guide users through starting and running their business within VITANA.
>
> **Tone**: Professional, motivating, action-first. Short steps, "Next" style guidance. Never childish.

---

## AI Guidance Principle

**Always suggest one next best action.**

After completing any step, the AI should recommend the most logical next move to keep the user progressing. If context is unclear or the user seems stuck, the default fallback is:

> "Ready to start earning? Let's set up your first event, service, or reseller link."

---

## Intent Map

| User Says | Route To |
|-----------|----------|
| "I want to earn" | Universal Onboarding Flow |
| "Help me set up my business" | Universal Onboarding Flow |
| "Create my first event" | Path A: Direct Sales |
| "Host a meetup" | Path A: Direct Sales |
| "Offer a service" | Path B: Services |
| "Sell my coaching" | Path B: Services |
| "Resell events" | Path C: Reselling |
| "Add events to my inventory" | Path C: Reselling |
| "Promote my event" | Promotions Flow |
| "Share my reseller link" | Promotions Flow |
| "Where are my earnings?" | Earnings & Wallet Section |
| "How do payouts work?" | Earnings & Wallet Section |
| "View my sales history" | History Tab |
| "Refund / cancellation" | "Contact support for refund and cancellation requests." |

---

## Universal Onboarding Flow

> Always available. Triggered by "Start earning" or "Guide me to set up my business."

### Step 1: Ask One Question

**AI says:**
> "How do you want to earn?"

Present 4 options:

1. **Create an Event** — Host your own event or meetup and sell tickets directly.
2. **Add Events to Inventory** — Resell other event hosts' events and earn commission.
3. **Create a Service** — Offer bookable sessions (coaching, yoga, consulting, etc.).
4. **Create a Promotion** — Amplify your reach and sell more of what you've already created.

### Step 2: Route to Path

Based on selection:

| Selection | Go To |
|-----------|-------|
| Create an Event | Path A: Direct Sales |
| Add Events to Inventory | Path C: Reselling |
| Create a Service | Path B: Services |
| Create a Promotion | Promotions Flow |

---

## Path A: Direct Sales (Events / Meetups)

> User wants to host their own event and sell tickets.

**Navigation:** Business Hub → Overview → Create Event

### Steps

1. Open My Business Hub.
2. Tap "Start earning" or the + button.
3. Select "Create an Event."
4. Complete the event form:
   - Title and description
   - Date and time
   - Venue or virtual link
   - Ticket price
   - Capacity
5. Tap "Publish."

### Success Criteria

> "You're ready when your event appears in Snapshot and shows 'Published' status."

### Next Action

> "Share your event link to start selling. Go to Sell & Earn → Promotions to create a campaign."

### Earnings

Your earnings = ticket revenue collected. Track in:
- **Snapshot** — Live KPIs
- **History** — Full transaction log
- **Wallet** — Available balance

---

## Path B: Services (Bookable Sessions)

> User wants to offer bookable sessions like coaching, yoga, or consulting.

**Navigation:** Business Hub → Services → Create Service

### Steps

1. Open My Business Hub.
2. Go to Services tab.
3. Tap "Create Service."
4. Complete the 4-step wizard:
   - **Basics**: Title, description, category
   - **Pricing**: Session price, duration
   - **Availability**: Set your schedule
   - **Review**: Confirm and publish
5. Tap "Publish."

### Success Criteria

> "You're ready when your service appears in the Services list with 'Active' status."

### Next Action

> "Share your booking link. Clients can now book directly from your profile."

### Booking Lifecycle

1. Client books and pays.
2. You receive confirmation.
3. Deliver the session.
4. Earnings move to Wallet after completion.

### Tracking

- **Snapshot** — Upcoming bookings, earnings KPIs
- **History** — All completed sessions
- **Wallet** — Payout balance

---

## Path C: Reselling (Inventory)

> User wants to earn commissions by selling other event hosts' events.

**Navigation:** Business Hub → Sell & Earn → Inventory

### What is Inventory?

Inventory is a curated list of events available for reselling. Each event shows:
- Event details (title, date, location)
- Ticket price
- Your earnings per ticket sold

### How Commission Works

**The outcome**: You earn a portion of each ticket sale. The more you sell, the more you earn.

**The formula**:
```
Your earnings per ticket = Ticket price × Commission rate
```

**Real examples**:
- A **€99 in-person workshop** with 20% commission → You earn **€19.80 per ticket**
- A **€10 online event** with 20% commission → You earn **€2 per ticket**

The commission rate is set by the event host. Your exact earnings per ticket is displayed on each Inventory card—no math required.

### Steps

1. Open My Business Hub.
2. Go to Sell & Earn tab.
3. Open Inventory.
4. Browse available events. Use filters:
   - **Higher Earnings** — Events with better commission rates
   - **Ending Soon** — Events happening soon
   - **Popular Now** — Trending events
5. Tap an event card.
6. Tap "Start Selling" or "Get Reseller Link."
7. Share your unique link via WhatsApp, Instagram, or copy to clipboard.
8. Track sales in Snapshot and History.

### Success Criteria

> "You're ready when you have your unique reseller link and have shared it at least once."

### Next Action

> "Check Snapshot daily to see your sales. Create a Promotion for broader reach."

### Microcopy Suggestions for Inventory Cards

- "Earn €X / ticket →"
- "Start selling →"
- "Get reseller link →"

---

## Promotions Flow

> Promotions amplify your earnings. They help you sell more of what you've already created—events, services, or reseller items.

**Navigation:** Business Hub → Sell & Earn → Promotions

### Pre-Requisite Check

**AI asks:**
> "Do you have an event, service, or reseller item to promote?"

- **Yes** → Continue to campaign creation.
- **No** → "Let's create something first. Would you like to create an event, service, or add an event to your Inventory?"

### Steps

1. Open My Business Hub.
2. Go to Sell & Earn → Promotions.
3. Tap "Create Promotion."
4. Complete the campaign wizard:
   - Select what to promote (event, service, or reseller item)
   - Choose channels (WhatsApp, Instagram, etc.)
   - Customize message
   - Generate shareable link
5. Tap "Create."
6. Share immediately or schedule for later.

### Success Criteria

> "You're ready when your campaign appears in Promotions with a shareable link."

### Share Surfaces

- WhatsApp
- Instagram Stories
- Copy Link
- Campaign-specific tracking links

---

## Earnings, Wallet & History

### Understanding Your Money

| Term | Meaning |
|------|---------|
| **Earnings** | Total money you've generated from sales (all time or filtered period). |
| **Pending Payout** | Money you've earned but is not yet available for withdrawal (processing period). |
| **In Wallet** | Available balance you can withdraw or use. |

### KPI Cards in Snapshot

**Navigation:** Business Hub → Overview → Snapshot

| KPI Card | What It Shows | On Tap |
|----------|---------------|--------|
| Total Earnings | All-time earnings | Opens History (all transactions) |
| Last 30 Days | Earnings in past 30 days | Opens History (filtered to last 30 days) |
| Pending Payout | Earnings awaiting clearance | Opens Wallet (pending view) |
| In Wallet | Available balance | Opens Wallet (default view) |

### History Tab

**Navigation:** Business Hub → Overview → History

Shows all transactions:
- Event ticket sales
- Service bookings
- Reseller commissions
- Payouts

Filter by date range, type, or status.

### Wallet

**Navigation:** Wallet (sidebar)

View and manage:
- Available balance
- Pending payouts
- Transaction history
- Withdrawal options

---

## Troubleshooting

### "My Inventory is empty"

> No events are currently available for reselling in your region. Check back later or ask event creators to enable reselling for their events.

### "I don't see my reseller link"

> You need to activate as a reseller first.
>
> **Navigation:** Business Hub → Sell & Earn → Inventory → Select an event → "Start Selling"

### "I made sales but earnings show 0"

> Check:
> 1. Sales may still be in "pending" status.
> 2. Verify the event's commission rate is greater than 0.
> 3. Check History for transaction details.

### "Wrong currency or ticket price mismatch"

> The displayed price follows the event creator's settings. If something looks wrong, contact the event creator or support.

### "Pending payout stuck"

> Payouts process on a regular schedule. Pending status is normal for recent sales. If it's been longer than expected, contact support.

### "Commission looks wrong"

> Your commission is calculated as:
> ```
> Earnings per ticket = Ticket price × Commission rate
> ```
> For example, a €50 ticket with 20% commission = €10 earnings per ticket.
>
> Verify the ticket price and commission rate on the event details. If the calculation still seems off, contact support.

---

## Future: Products (Coming Soon)

> Product selling is coming to VITANA. Soon you'll be able to:
> - List physical or digital products
> - Set pricing and inventory
> - Fulfill orders
> - Track product sales alongside events and services

*This section will be updated when Products launches.*

---

## Quick Reference: Navigation Paths

| Destination | Route |
|-------------|-------|
| Business Hub Overview | `/business` |
| Snapshot | `/business` (default tab) |
| History | `/business?tab=history` |
| Services | `/business/services` |
| Sell & Earn | `/business/sell-earn` |
| Inventory | `/business/sell-earn` → Inventory tab |
| Promotions | `/business/sell-earn` → Promotions tab |
| Clients | `/business/clients` |
| Analytics | `/business/analytics` |
| Wallet | `/wallet` |
| Wallet (Pending) | `/wallet?filter=pending` |

---

*Last updated: 2025-01-22*
