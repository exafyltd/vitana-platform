# Apple App Review Guideline 3.1.5(iii) - Response

**App Name:** MAXINA - Longevity Community
**Developer:** Exafy LTD, Abu Dhabi, UAE
**Date:** April 2026

---

## Summary

MAXINA is a health, wellness, and longevity community platform. **The app does not provide cryptocurrency exchange services.** The wallet and exchange screens visible in the reviewed build were non-functional UI prototypes that have been removed from the iOS build.

The internal "currency" system (VTNA Points, Credits) is a closed-loop virtual points system comparable to loyalty rewards or in-game coins. It has no connection to any blockchain, cryptocurrency, or financial exchange infrastructure.

---

## Responses to Apple's Questions

### 1. Countries/Regions for Cryptocurrency Exchange Services

**Not applicable.** The app does not provide cryptocurrency exchange services in any country or region. The "Exchange Currency" screen shown in the reviewed build was a non-functional UI prototype for a planned internal points conversion feature. This prototype has been removed from the iOS build.

### 2. Licensing and Permissions Documentation

**Not applicable.** No cryptocurrency exchange services are provided. VTNA is an internal platform points system (analogous to loyalty points, airline miles, or in-game coins) stored in a standard PostgreSQL database. No financial services licensing is required for internal virtual currency systems.

### 3. Links to Government License Websites

**Not applicable.** No financial services licenses are needed because no cryptocurrency or financial exchange services are offered.

### 4. Transaction Handling (Users vs. Developer)

No exchange transactions occur. The prototype UI was designed for a planned internal feature that would convert between platform reward types (Points, Credits) within our own database. All data is managed in a centralized PostgreSQL database (Supabase). No real currency, cryptocurrency, or external exchange is involved in any transaction.

### 5. Centralized, Decentralized, or Mixed Exchange Features

**Not applicable.** There is no cryptocurrency exchange feature. The planned internal points conversion would operate as a simple centralized database ledger (standard SQL transactions) - the same architecture used by loyalty programs and gaming platforms.

### 6. New or Exclusive Tokens/Cryptocurrency

VTNA is **not a cryptocurrency token**. It is an internal platform credit (like coins in a mobile game) stored as rows in a PostgreSQL database. Key facts:

- **No blockchain representation** - zero Web3, Ethereum, Solana, or any blockchain libraries in the project
- **No smart contracts** - no contract addresses, no on-chain transactions
- **Cannot be traded on any exchange** - exists only within the platform's database
- **Cannot be withdrawn as real currency** - closed-loop system with no fiat off-ramps
- **Not obtainable outside the platform** - earned solely through platform engagement (health milestones, community participation)
- **Fixed admin-controlled conversion rates** - not market-driven
- **Platform documentation explicitly states:** "VTN is not a cryptocurrency. It is not designed for speculation or day trading."

### 7. AML and KYC Compliance

AML and KYC requirements do not apply to internal virtual currency/points systems. VTNA Points and Credits are non-transferable outside the platform and have no real-world monetary value.

For real payment processing (event tickets, live room access), the app uses **Stripe**, which provides its own comprehensive KYC/AML compliance, identity verification, and regulatory compliance in all markets where it operates.

### 8. Money Services Business (MSB) Registration (United States)

**Not required.** The app does not transmit money, provide currency exchange services, or facilitate financial transactions between users and external parties. The internal virtual points system is exempt from MSB registration requirements under FinCEN guidance, as it operates as a closed-loop system with no real-world monetary value.

### 9. Third-Party Exchange Partnerships / APIs

**No third-party exchange partnerships or APIs exist.** The only third-party payment integration is **Stripe** (https://stripe.com), used exclusively for standard payment processing of event tickets and live room access - not for any currency exchange functionality.

### 10. FCA Crypto Asset Promotions Compliance (United Kingdom)

**Not applicable.** The app does not offer, promote, or facilitate cryptocurrency or crypto assets. VTNA is an internal platform points system with no connection to any blockchain or cryptocurrency.

---

## Changes Made for Resubmission

The following changes have been made to the iOS build to prevent future confusion:

1. **Removed all prototype wallet UI elements from the iOS build**, including:
   - Balance cards (USD Balance, Credits Balance, VTNA Tokens)
   - Quick Actions (Send, Exchange, Withdraw)
   - Exchange Currency dialog
   - Exchange Rate Display
   - Stake Tokens functionality
   - Withdraw / Cash Out functionality
   - Quick Exchange Widget

2. These features were gated using the existing `isIAPRestricted()` mechanism that already hides digital purchase features on iOS per App Store Guideline 3.1.1.

3. The prototype features remain available on non-iOS platforms (web, Android) for continued internal development and testing.

---

## Technical Evidence

For detailed technical documentation demonstrating that no blockchain or cryptocurrency technology is used, please see the accompanying document: `virtual-currency-architecture.md`
