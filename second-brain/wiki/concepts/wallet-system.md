# Wallet System

> Vitana Wallet architecture: multi-currency credits and tokens, transaction processing, exchange system, real-time balance updates, and security model.

## Content

### Overview

The Vitana Wallet is a multi-currency transaction system supporting three currency types: USD, VTN (Vitana tokens), and Credits. It provides real-time balance management, currency exchange with fee calculation, and secure transaction processing. As of December 2024, core functionality is production-ready for beta launch.

### Currency Model

| Currency | Purpose | Default Balance |
|----------|---------|-----------------|
| USD | Fiat currency representation | 1,000.00 |
| VTN | Vitana platform tokens | 1,000.00 |
| CREDITS | In-app credits for services | 1,000.00 |

Exchange rate simulation includes trend indicators (up, down, stable) and 24-hour change tracking. A 1% fee is applied on currency exchanges.

### Database Schema

**`user_wallets`** -- per-user, per-currency balance tracking:
- `user_id` (references `auth.users`), `currency_type`, `balance` (DECIMAL 15,2)
- Unique constraint on `(user_id, currency_type)`
- Row Level Security (RLS) policies enabled

**`wallet_transactions`** -- full transaction audit log:
- `from_user_id`, `to_user_id`, `transaction_type` (transfer, exchange, reward, purchase)
- `from_currency`, `to_currency`, `amount`, `exchange_rate`, `fees`
- `status` (pending, completed, failed, cancelled)
- `metadata` (JSONB), timestamps

**`exchange_rates`** -- live rate management:
- `from_currency`, `to_currency`, `rate` (DECIMAL 10,6)
- `trend`, `change_24h`, `is_active` flag

### Database Functions

- `initialize_user_wallet()` -- auto-creates 1,000 balance for all three currencies
- `get_user_balance()` -- retrieves current balance for any currency
- `update_user_balance()` -- safely updates balances with validation (prevents negative balances)

### Frontend Components

- **QuickExchangeWidget** -- currency conversion UI (USD, VTN, Credits) with real-time rates
- **WalletPopup** -- sidebar wallet with balance overview using real database data
- **Payment flows** -- Request, Send, Transfer components
- **Chat integration** -- payment attachments in messaging
- **Exchange & Send** -- combined exchange + payment flow

### Real-Time Infrastructure

- **`useWallet` hook** -- real-time balance and transaction management
- **Supabase Realtime subscriptions** -- live balance updates pushed to the frontend
- **Database event triggers** -- automatic notifications on balance changes
- **Loading states and error handling** throughout the UI

### Security

- Row Level Security (RLS) on all wallet tables
- Transaction validation preventing negative balances
- Full audit trail with timestamps on every operation
- All sensitive operations happen server-side

### Missing / Planned Features

**Not yet implemented:**
- Batch/atomic multi-step transactions
- Transaction limits (daily/monthly spending caps)
- Scheduled/recurring payments
- Dispute and refund mechanism
- 2FA for large transactions
- Fraud detection and suspicious activity monitoring
- Rate limiting on rapid transaction attempts
- Push notifications for transactions
- WebSocket scaling beyond ~1,000 concurrent users
- External payment gateways (Stripe/PayPal for USD deposits)
- Bank account linking
- Blockchain connectivity for VTN tokens
- Analytics and reporting dashboards

### Infrastructure Costs

- Current: approximately $50/month
- Scaled (10,000+ users): approximately $200/month
- Recommended security audit: $5,000-$8,000

## Related Pages

- [[command-hub-architecture]]
- [[sse-event-streaming]]

## Sources

- `raw/wallet/VITANA_WALLET_CTO_REPORT.md`

## Last Updated

2026-04-12
