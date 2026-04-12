# MAXINA Virtual Currency Architecture - Technical Summary

**Purpose:** Technical documentation for Apple App Review demonstrating that the MAXINA app does not use blockchain or cryptocurrency technology.

---

## Platform Overview

MAXINA is a health, wellness, and longevity community platform. The app provides health tracking, community discussions, live events, and AI-powered wellness coaching. It is built as a React/TypeScript web application served via a native WebView shell (Appilix) on iOS and Android.

## Internal Points System

The app has a planned internal rewards system with three balance types:

| Balance Type | Purpose | Status |
|---|---|---|
| **Credits** | Reward points earned through platform engagement | Prototype (non-functional on iOS) |
| **VTNA Points** | Long-term reward points for sustained participation | Prototype (non-functional on iOS) |
| **USD Balance** | Internal representation for future paid features | Prototype (non-functional on iOS) |

## Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Standard web application |
| UI Framework | Tailwind CSS + shadcn/ui | No crypto/Web3 UI libraries |
| Backend | Supabase (PostgreSQL + Auth) | Standard relational database |
| Payments | Stripe | For event tickets and live room access only |
| Mobile Shell | Appilix (WebView) | Native wrapper for web app |

## What Is NOT in the Project

The following technologies are **completely absent** from the codebase:

- No Web3.js, Ethers.js, Viem, or any blockchain library
- No wallet connection libraries (WalletConnect, MetaMask, etc.)
- No smart contract code (Solidity, Vyper, Rust/Anchor, etc.)
- No blockchain RPC endpoints or node connections
- No cryptographic signing of transactions
- No token contract addresses
- No DeFi protocol integrations
- No DEX (decentralized exchange) integrations
- No CEX (centralized exchange) API integrations
- No cryptocurrency price feed APIs (CoinGecko, CoinMarketCap, etc.)
- No stablecoin integrations (USDC, USDT, DAI, etc.)

## How Balances Work

Balances are stored as simple numeric values in a PostgreSQL table:

```
Table: user_wallets
- id (UUID)
- user_id (UUID, references auth.users)
- currency_type (TEXT: 'USD', 'VTN', 'CREDITS')
- balance (NUMERIC, default 1000.00)
- updated_at (TIMESTAMP)
```

This is identical to how any loyalty program, gaming platform, or rewards system stores point balances.

## How Conversions Work

The planned conversion feature uses standard SQL transactions:

```
1. Debit source balance (UPDATE user_wallets SET balance = balance - amount)
2. Credit destination balance (UPDATE user_wallets SET balance = balance + amount)
3. Record transaction in wallet_transactions table
```

Conversion rates are fixed values set by platform administrators (e.g., 1 USD = 100 VTNA Points). They are not market-driven and do not reflect any real-world asset prices.

## Comparison to Approved App Store Apps

The MAXINA points system is architecturally identical to virtual currency systems in thousands of approved App Store apps:

- **Gaming apps** with coins, gems, or gold (e.g., Candy Crush gold bars, Roblox Robux)
- **Loyalty apps** with points (e.g., Starbucks Stars, airline miles)
- **Health apps** with reward points (e.g., achievement badges, wellness points)
- **Social platforms** with virtual gifts or credits

All of these use database-backed point balances with admin-controlled conversion rates and closed-loop systems.

## Closed-Loop System

The MAXINA points system is a closed-loop system:

- Points cannot be withdrawn as real currency
- Points cannot be transferred outside the platform
- Points cannot be traded on any external exchange
- Points have no real-world monetary value
- There are no fiat on-ramps or off-ramps connected to the points system
- The only real payment processing (Stripe) is used for purchasing event access, not for funding or withdrawing points
