# Summary: Apple Compliance Documents

> A structured overview of the two Apple App Review compliance documents: the virtual currency architecture technical brief and the Guideline 3.1.5(iii) response letter.

## Content

### Virtual Currency Architecture (Technical Brief)

This document provides technical evidence for Apple's review team that MAXINA does not use blockchain or cryptocurrency technology.

**Platform**: MAXINA is a health, wellness, and longevity community platform built as a React/TypeScript web app served via Appilix WebView shell on iOS/Android.

**Internal Points System**: Three balance types (Credits, VTNA Points, USD Balance) stored as simple numeric values in a PostgreSQL `user_wallets` table. All are prototype/non-functional on iOS.

**Technology Absence**: No Web3.js, Ethers.js, Viem, WalletConnect, MetaMask, smart contracts, blockchain RPC endpoints, token addresses, DeFi/DEX/CEX integrations, or crypto price feeds.

**Conversion Architecture**: Fixed admin-controlled rates via standard SQL transactions (debit source, credit destination, record transaction). Not market-driven.

**Closed-Loop Properties**: Points cannot be withdrawn as real currency, transferred outside the platform, traded on exchanges, or converted to real-world value. Only Stripe handles real payments for event tickets and live room access.

### Apple Review 3.1.5(iii) Response

Filed by Exafy LTD (Abu Dhabi, UAE) in April 2026 for MAXINA - Longevity Community.

**Core Response**: The app does not provide cryptocurrency exchange services. The wallet and exchange screens were non-functional UI prototypes that have been removed from the iOS build.

**10 Questions Addressed**: Countries/regions (N/A), licensing (N/A), government license links (N/A), transaction handling (internal DB only), centralized/decentralized exchange (N/A), new tokens (VTNA is a database row, not crypto), AML/KYC (N/A for virtual points; Stripe handles real payments), MSB registration (not required), third-party exchange APIs (none), FCA crypto compliance (N/A).

**Changes for Resubmission**: Removed all prototype wallet UI elements from iOS build using `isIAPRestricted()` mechanism. Affected elements: Balance cards, Quick Actions (Send/Exchange/Withdraw), Exchange Currency dialog, Exchange Rate Display, Stake Tokens, Withdraw/Cash Out, Quick Exchange Widget. Features remain on web and Android for development.

## Related Pages

- [[apple-compliance]]
- [[multi-tenancy]]
- [[screen-registry]]

## Sources

- `raw/compliance/virtual-currency-architecture.md`
- `raw/compliance/apple-review-3.1.5-response.md`

## Last Updated

2026-04-12
