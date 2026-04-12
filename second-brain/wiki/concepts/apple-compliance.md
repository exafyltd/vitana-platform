# Apple Compliance

> VITANA's Apple App Store compliance strategy addresses App Review Guideline 3.1.5(iii) by demonstrating the platform's virtual currency system (VTNA Points, Credits) is a closed-loop loyalty program, not cryptocurrency, and by gating prototype wallet features on iOS.

## Background

Apple's App Review team flagged VITANA (published as "MAXINA - Longevity Community") under Guideline 3.1.5(iii), which governs cryptocurrency exchange services. The review team questioned whether the wallet and exchange screens constituted crypto exchange functionality.

**Developer**: Exafy LTD, Abu Dhabi, UAE

## Core Argument: Not Cryptocurrency

The internal points system is a closed-loop virtual currency system comparable to loyalty rewards or in-game coins. Key facts:

### Technology Stack (No Crypto Libraries)

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| UI Framework | Tailwind CSS + shadcn/ui |
| Backend | Supabase (PostgreSQL + Auth) |
| Payments | Stripe (event tickets and live room access only) |
| Mobile Shell | Appilix (WebView) |

### What Is Completely Absent

- No Web3.js, Ethers.js, Viem, or any blockchain library
- No wallet connection libraries (WalletConnect, MetaMask)
- No smart contract code (Solidity, Vyper, Rust/Anchor)
- No blockchain RPC endpoints or node connections
- No token contract addresses
- No DeFi/DEX/CEX integrations
- No cryptocurrency price feed APIs

### Virtual Currency Architecture

Three internal balance types stored as simple numeric values in PostgreSQL:

| Balance Type | Purpose | iOS Status |
|---|---|---|
| Credits | Reward points for platform engagement | Prototype (non-functional on iOS) |
| VTNA Points | Long-term reward points for sustained participation | Prototype (non-functional on iOS) |
| USD Balance | Internal representation for future paid features | Prototype (non-functional on iOS) |

**Database structure:**
```
Table: user_wallets
  - user_id (UUID)
  - currency_type (TEXT: 'USD', 'VTN', 'CREDITS')
  - balance (NUMERIC, default 1000.00)
```

Conversions use fixed admin-controlled rates (e.g., 1 USD = 100 VTNA Points), not market-driven prices. Standard SQL transactions debit/credit balances.

### Closed-Loop System Properties

- Points cannot be withdrawn as real currency
- Points cannot be transferred outside the platform
- Points cannot be traded on any external exchange
- Points have no real-world monetary value
- No fiat on-ramps or off-ramps for the points system
- Only Stripe handles real payments (event tickets, live room access)

## Responses to Apple's Review Questions

1. **Countries/Regions**: Not applicable -- no crypto exchange services
2. **Licensing**: Not applicable -- internal loyalty points need no financial license
3. **Government License Links**: Not applicable
4. **Transaction Handling**: Internal database ledger only, no external exchange
5. **Centralized/Decentralized Exchange**: Not applicable
6. **New Tokens**: VTNA is not a cryptocurrency token -- it is a database row
7. **AML/KYC**: Not applicable to internal virtual currency; Stripe handles KYC for real payments
8. **MSB Registration (US)**: Not required -- closed-loop system
9. **Third-Party Exchange APIs**: None -- only Stripe for standard payments
10. **FCA Crypto Compliance (UK)**: Not applicable

## Changes Made for iOS Resubmission

Removed all prototype wallet UI elements from the iOS build using `isIAPRestricted()` mechanism:

- Balance cards (USD, Credits, VTNA)
- Quick Actions (Send, Exchange, Withdraw)
- Exchange Currency dialog
- Exchange Rate Display
- Stake Tokens functionality
- Withdraw / Cash Out functionality
- Quick Exchange Widget

These features remain available on web and Android for continued development.

## Comparable Approved Apps

The VTNA system is architecturally identical to:
- Gaming apps (Candy Crush gold bars, Roblox Robux)
- Loyalty apps (Starbucks Stars, airline miles)
- Health apps with wellness reward points
- Social platforms with virtual gifts/credits

## Related Pages

- [[multi-tenancy]] -- Tenant-specific feature gating
- [[screen-registry]] -- Wallet screens (WLLT-001 to WLLT-008)
- [[business-hub]] -- Business Hub earnings and wallet integration
- [[mobile-pwa-architecture]] -- Mobile wallet surface

## Sources

- `raw/compliance/virtual-currency-architecture.md`
- `raw/compliance/apple-review-3.1.5-response.md`

## Last Updated

2026-04-12
