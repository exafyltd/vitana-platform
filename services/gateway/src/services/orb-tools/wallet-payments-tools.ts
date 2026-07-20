/**
 * Wallet & Payments (A3) voice tools — community role.
 *
 * REAL backings used (never fabricated — see per-tool notes below):
 *   - wallet_accounts / wallet_ledger_entries via services/wallet/balance-service.ts
 *     (getAccountsForUser / getTransactionsForUser) — same source tool_get_wallet_balance
 *     in p0-gap-tools.ts already reads.
 *   - debit_wallet_for_spend / credit_wallet_for_earning RPCs via
 *     services/wallet/spend-earning-service.ts — the only sanctioned way to move
 *     wallet money; both own SELECT FOR UPDATE + ledger insert + idempotency via
 *     reference_type/reference_id. send_funds composes these two primitives with
 *     a shared reference_id to build a real internal transfer — there is no
 *     dedicated "transfer" RPC/table (verified: vitana-v1's CreditTransferPopup.tsx
 *     is UI-only, no backend call).
 *   - commission_event / rewards_ledger (VCAOP schema, prisma/migrations/
 *     20260604_vcaop_ctrl_schema_0002/migration.sql) — the real, currently-wired
 *     referral/commission/reward tables. Confirmed live via routes/vcaop.ts:
 *     GET /api/v1/vcaop/wallet reads rewards_ledger for the caller, GET
 *     /api/v1/vcaop/commissions reads commission_event. This module queries the
 *     same tables directly (service-role sb, same pattern every other orb-tools
 *     module uses) rather than duplicating the ⚠️ admin-gated HTTP routes.
 *     States: rewards_ledger.state ∈ {pending, confirmed, redeemable, reversed};
 *     commission_event.status ∈ {pending, confirmed, reversed} (see
 *     services/gateway/src/services/awin-conversions.ts mapAwinTxStatus).
 *
 * STUBBED (no real backing found — hard rule: never fabricate a table/RPC):
 *   - request_payment / list_payment_requests: "payment requests" in this app are
 *     NOT a table. vitana-v1's GlobalPaymentRequest.tsx sends a normal chat
 *     message with message_type='payment_request' + JSON metadata via a direct
 *     Supabase client insert. The gateway's OWN canonical send route
 *     (routes/chat.ts POST /send) explicitly rejects that: its allowedTypes set
 *     is `{'text','attachment','voice','voice_transcript'}` — 'payment_request'
 *     is not in it. Recreating the frontend's bypass in a new voice tool would
 *     mean inventing a server contract the gateway's own validation forbids, so
 *     both tools return ok:false rather than fabricate one.
 *   - exchange_currency / get_exchange_rate: the canonical wallet
 *     (types/wallet.ts) only knows WalletCurrency = 'EUR' | 'USD', and
 *     debit_wallet_for_spend / credit_wallet_for_earning only move money within
 *     ONE currency — there is no cross-currency conversion RPC anywhere in the
 *     gateway. The only `exchange_rates` table in the schema is a legacy
 *     Lovable-era ghost table (USD/VTNA/CREDITS tokens) explicitly called out as
 *     "OUT OF SCOPE ... no DDL, no reads, no writes" in
 *     supabase/migrations/20260605000000_VTID_03186_universal_cart_schema.sql,
 *     pending a convergence decision (issue #2371 / VTID-03176). Building new
 *     voice tools against a table the codebase itself flags for decommission
 *     would be reintroducing exactly the debt that migration is unwinding.
 *   - set_display_currency: verified NOT server-side at all. vitana-v1's
 *     src/hooks/useDisplayCurrency.ts stores the USD/EUR display toggle in
 *     `window.localStorage['vitana.wallet.displayCurrency']` only — there is no
 *     app_users column or user_preferences table for it, so there is nothing a
 *     gateway voice tool could write to.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { isWalletCurrency, type WalletCurrency } from '../../types/wallet';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function authGate(tool: string, id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

function strArg(args: OrbToolArgs, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function isConfirmed(args: OrbToolArgs): boolean {
  return args.confirm === true || args.confirmed === true;
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function fmtMinor(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

// ---------------------------------------------------------------------------
// get_wallet_summary — wallet_accounts + wallet_ledger_entries (balance-service)
// + user_subscriptions (benefits) + rewards_ledger (VCAOP: lifetime earnings /
// pending rewards — real numbers, not a stub, since the VCAOP reward ledger is
// a genuine gateway-owned table).
// ---------------------------------------------------------------------------

export async function tool_get_wallet_summary(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_wallet_summary', id);
  if (gate) return gate;
  try {
    const { getAccountsForUser, getTransactionsForUser } = await import('../wallet/balance-service');
    const [accounts, page] = await Promise.all([
      getAccountsForUser(id.user_id),
      getTransactionsForUser({ user_id: id.user_id, limit: 5 }),
    ]);

    interface SubscriptionRow {
      plan_key: string;
      status: string;
      current_period_end: string | null;
    }
    let subscription: SubscriptionRow | null = null;
    try {
      let subQuery = sb
        .from('user_subscriptions')
        .select('plan_key, status, current_period_end')
        .eq('user_id', id.user_id);
      if (id.tenant_id) subQuery = subQuery.eq('tenant_id', id.tenant_id);
      const { data: subRow } = await subQuery.maybeSingle();
      subscription = (subRow as SubscriptionRow | null) ?? null;
    } catch {
      /* subscription read is optional */
    }

    // Referral rewards (VCAOP rewards_ledger — same table GET /api/v1/vcaop/wallet reads).
    let lifetimeEarnings = 0;
    let pendingRewards = 0;
    let rewardsCurrency: string = accounts[0]?.currency ?? 'EUR';
    let hasRewards = false;
    try {
      const { data: rewardRows } = await sb
        .from('rewards_ledger')
        .select('amount, state, currency')
        .eq('user_id', id.user_id);
      const rows = (rewardRows ?? []) as Array<{ amount: number; state: string; currency: string }>;
      hasRewards = rows.length > 0;
      if (hasRewards) rewardsCurrency = rows[0].currency || rewardsCurrency;
      for (const r of rows) {
        const amt = Number(r.amount) || 0;
        if (r.state === 'confirmed' || r.state === 'redeemable') lifetimeEarnings += amt;
        else if (r.state === 'pending') pendingRewards += amt;
      }
    } catch {
      /* rewards read is best-effort */
    }

    const balanceLine =
      accounts.length > 0
        ? `Your wallet balance is ${accounts.map((a) => fmtMinor(a.balance_minor, a.currency)).join(' and ')}.`
        : 'Your wallet has no accounts yet — the balance is zero.';

    const subLine =
      subscription && subscription.status !== 'free' && subscription.status !== 'canceled'
        ? ` Your ${subscription.plan_key} subscription is ${subscription.status}${
            subscription.current_period_end
              ? ` until ${new Date(subscription.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
              : ''
          }.`
        : '';

    const rewardsLine = hasRewards
      ? ` You've earned ${lifetimeEarnings.toFixed(2)} ${rewardsCurrency} in referral rewards${
          pendingRewards > 0 ? `, with ${pendingRewards.toFixed(2)} ${rewardsCurrency} still pending` : ''
        }.`
      : '';

    const txLine =
      page.entries.length > 0
        ? ` Latest activity: ${page.entries
            .map((e) => `${e.description || e.entry_type} ${e.direction === 'credit' ? '+' : '-'}${fmtMinor(e.amount_minor, e.currency)}`)
            .join('; ')}.`
        : '';

    return {
      ok: true,
      result: {
        accounts: accounts.map((a) => ({ currency: a.currency, balance_minor: a.balance_minor, status: a.status })),
        subscription,
        referral_rewards: hasRewards
          ? { lifetime_earned: +lifetimeEarnings.toFixed(2), pending: +pendingRewards.toFixed(2), currency: rewardsCurrency }
          : null,
        recent_transactions: page.entries.map((e) => ({
          entry_type: e.entry_type,
          direction: e.direction,
          amount_minor: e.amount_minor,
          currency: e.currency,
          description: e.description,
          created_at: e.created_at,
        })),
      },
      text: `${balanceLine}${subLine}${rewardsLine}${txLine}`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'get_wallet_summary failed') };
  }
}

// ---------------------------------------------------------------------------
// list_wallet_transactions — wallet_ledger_entries via balance-service, with
// pagination (cursor is the last row's created_at, same contract
// getTransactionsForUser already returns as next_cursor).
// ---------------------------------------------------------------------------

export async function tool_list_wallet_transactions(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_wallet_transactions', id);
  if (gate) return gate;
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 50) : 15;
  const currencyArg = String(args.currency ?? '').trim().toUpperCase();
  const currency = isWalletCurrency(currencyArg) ? (currencyArg as WalletCurrency) : undefined;
  const cursor = typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor.trim() : null;
  try {
    const { getTransactionsForUser } = await import('../wallet/balance-service');
    const page = await getTransactionsForUser({ user_id: id.user_id, currency, limit, cursor });
    if (page.entries.length === 0) {
      return {
        ok: true,
        result: { transactions: [], next_cursor: null },
        text: cursor ? 'No more transactions.' : "You don't have any wallet transactions yet.",
      };
    }
    const lines = page.entries.map(
      (e) =>
        `${e.description || e.entry_type} ${e.direction === 'credit' ? '+' : '-'}${fmtMinor(e.amount_minor, e.currency)}` +
        ` (${new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`,
    );
    return {
      ok: true,
      result: {
        transactions: page.entries.map((e) => ({
          id: e.id,
          entry_type: e.entry_type,
          direction: e.direction,
          amount_minor: e.amount_minor,
          currency: e.currency,
          description: e.description,
          created_at: e.created_at,
        })),
        next_cursor: page.next_cursor,
      },
      text: `Here are your ${cursor ? 'next' : 'latest'} ${page.entries.length} transaction${page.entries.length === 1 ? '' : 's'}: ${lines.join('; ')}.${
        page.next_cursor ? ' Want me to read more, further back?' : ''
      }`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'list_wallet_transactions failed') };
  }
}

// ---------------------------------------------------------------------------
// send_funds (⚠️ confirm) — REAL internal user-to-user wallet transfer.
//
// No dedicated transfer RPC/table exists, so this composes the two safe,
// transactional primitives with a shared reference_id: debit the sender
// (reference_type:'manual'), then credit the recipient with the SAME
// reference_id (also 'manual' — the SpendEarningReferenceType union has no
// dedicated transfer value and the brief forbids inventing one). If the debit
// fails, nothing moves. If the debit succeeds but the credit leg fails for any
// reason (recipient account can't be found/provisioned, RPC error), this
// compensates by crediting the sender back rather than letting money vanish —
// each individual RPC call is atomic (SELECT FOR UPDATE) but the two-call
// composition is not, so the compensation step is the best available
// consistency guarantee without a dedicated two-leg transfer RPC.
//
// This is the ONLY tool in this file allowed to fully execute money movement
// by voice, per the approved payment policy — everything else here that would
// move or convert money either has no backing (stubbed) or is a read.
// ---------------------------------------------------------------------------

export async function tool_send_funds(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('send_funds', id);
  if (gate) return gate;

  let amountMinor: number;
  if (typeof args.amount_minor === 'number' && Number.isFinite(args.amount_minor)) {
    amountMinor = Math.round(args.amount_minor);
  } else if (typeof args.amount === 'number' && Number.isFinite(args.amount)) {
    amountMinor = Math.round(args.amount * 100);
  } else {
    return { ok: false, error: 'send_funds requires an `amount` (e.g. 25.00) — ask the user how much to send.' };
  }
  if (amountMinor <= 0) {
    return { ok: false, error: 'send_funds requires a positive amount.' };
  }

  try {
    const { getAccountsForUser } = await import('../wallet/balance-service');
    const { debitWalletForSpend, creditWalletForEarning } = await import('../wallet/spend-earning-service');

    const senderAccounts = await getAccountsForUser(id.user_id);
    if (senderAccounts.length === 0) {
      return {
        ok: true,
        result: { sent: false, reason: 'no_wallet' },
        text: "You don't have a wallet account yet — add funds in the Wallet screen first.",
      };
    }

    const currencyArg = String(args.currency ?? '').trim().toUpperCase();
    let senderAccount = senderAccounts[0];
    if (isWalletCurrency(currencyArg)) {
      const match = senderAccounts.find((a) => a.currency === currencyArg);
      if (!match) {
        return {
          ok: true,
          result: { sent: false, reason: 'currency_not_found' },
          text: `You don't have a ${currencyArg} wallet account.`,
        };
      }
      senderAccount = match;
    } else if (senderAccounts.length > 1) {
      return {
        ok: true,
        result: { sent: false, needs_currency: true, currencies: senderAccounts.map((a) => a.currency) },
        text: `You have wallets in ${senderAccounts.map((a) => a.currency).join(' and ')}. Which currency should I send from?`,
      };
    }
    const currency = senderAccount.currency;

    // Resolve recipient — same resolve_recipient_candidates RPC every other
    // resolver in this codebase uses (tool_resolve_recipient, groups-events'
    // resolveMember, send_chat_message).
    let recipientUserId = String(args.recipient_user_id ?? '').trim();
    let recipientName = strArg(args, 'recipient_name', 'name', 'spoken_name');
    if (!UUID_RE.test(recipientUserId)) {
      if (!recipientName) {
        return { ok: false, error: 'send_funds requires the recipient\'s name — ask the user who to send to.' };
      }
      const { data, error } = await sb.rpc('resolve_recipient_candidates', {
        p_actor: id.user_id,
        p_token: recipientName,
        p_limit: 3,
        p_global: true,
      });
      if (error) return { ok: false, error: error.message };
      const candidates = (data || []) as Array<{
        user_id: string;
        vitana_id: string | null;
        display_name: string | null;
        score: number;
      }>;
      if (candidates.length === 0) {
        return {
          ok: true,
          result: { sent: false, reason: 'recipient_not_found' },
          text: `I couldn't find anyone named "${recipientName}" — they may not have a Vitana account yet.`,
        };
      }
      const top = candidates[0];
      const topScore = Number(top.score) || 0;
      const secondScore = candidates[1] ? Number(candidates[1].score) || 0 : 0;
      const ambiguous = topScore < 0.85 || (candidates.length > 1 && secondScore / Math.max(topScore, 0.0001) > 0.85);
      if (ambiguous) {
        const names = candidates.slice(0, 3).map((c) => c.display_name || c.vitana_id || c.user_id);
        return {
          ok: true,
          result: { sent: false, candidates: candidates.slice(0, 3).map((c) => ({ user_id: c.user_id, display_name: names })) },
          text: `I found a few possible matches: ${names.join(', ')}. Which one did you mean?`,
        };
      }
      recipientUserId = top.user_id;
      recipientName = top.display_name || top.vitana_id || recipientName;
    }

    if (recipientUserId === id.user_id) {
      return { ok: false, error: 'You cannot send funds to yourself.' };
    }

    // Verify the recipient actually exists (mirrors send_chat_message's guard).
    const { data: recipRow, error: recipErr } = await sb
      .from('app_users')
      .select('user_id, display_name, vitana_id')
      .eq('user_id', recipientUserId)
      .maybeSingle();
    if (recipErr) return { ok: false, error: recipErr.message };
    if (!recipRow) {
      return {
        ok: true,
        result: { sent: false, reason: 'recipient_not_found' },
        text: `I couldn't find that person — they may have left the community.`,
      };
    }
    const recipient = recipRow as { user_id: string; display_name: string | null; vitana_id: string | null };
    const recipientDisplay = recipient.display_name || recipient.vitana_id || recipientName || 'that person';

    if (!isConfirmed(args)) {
      return {
        ok: true,
        result: {
          requires_confirmation: true,
          recipient_user_id: recipientUserId,
          recipient_name: recipientDisplay,
          amount_minor: amountMinor,
          currency,
        },
        text: `Ready to send ${fmtMinor(amountMinor, currency)} to ${recipientDisplay}. Say yes to confirm, then call send_funds again with this recipient_user_id, amount, currency, and confirm:true.`,
      };
    }

    // ---- Execute: debit sender, then credit recipient, same reference_id ----
    const transferId = randomUUID();
    const debit = await debitWalletForSpend({
      account_id: senderAccount.id,
      amount_minor: amountMinor,
      currency,
      reference_type: 'manual',
      reference_id: transferId,
      description: `Wallet transfer to ${recipientDisplay}`,
      metadata: { kind: 'p2p_transfer', recipient_user_id: recipientUserId, transfer_id: transferId },
    });
    if (!debit.ok) {
      const text =
        debit.error === 'INSUFFICIENT_BALANCE'
          ? `You don't have enough balance to send that — your ${currency} balance is${
              debit.balance_minor != null ? ` ${fmtMinor(debit.balance_minor, currency)}` : ' too low'
            }.`
          : `I couldn't complete the transfer (${debit.error}).`;
      return { ok: true, result: { sent: false, error_code: debit.error }, text };
    }

    // Find (or lazily provision, same defensive pattern as deposit-service) the
    // recipient's account in the same currency.
    const recipientAccounts = await getAccountsForUser(recipientUserId);
    let recipientAccount = recipientAccounts.find((a) => a.currency === currency && a.status === 'active');
    if (!recipientAccount) {
      const { data: created, error: createErr } = await sb
        .from('wallet_accounts')
        .insert({ user_id: recipientUserId, currency })
        .select('id, user_id, currency, balance_minor, status, created_at, updated_at')
        .single();
      if (createErr || !created) {
        // Compensate: the debit succeeded but we can't deliver — refund the sender.
        await creditWalletForEarning({
          account_id: senderAccount.id,
          amount_minor: amountMinor,
          currency,
          reference_type: 'manual',
          reference_id: `${transferId}-refund`,
          description: `Refund: could not create ${recipientDisplay}'s wallet account`,
        });
        return {
          ok: true,
          result: { sent: false, error_code: 'RECIPIENT_ACCOUNT_FAILED', refunded: true },
          text: `I couldn't set up ${recipientDisplay}'s wallet account, so I've refunded your ${fmtMinor(amountMinor, currency)} back.`,
        };
      }
      recipientAccount = created as typeof senderAccount;
    }

    const credit = await creditWalletForEarning({
      account_id: recipientAccount.id,
      amount_minor: amountMinor,
      currency,
      reference_type: 'manual',
      reference_id: transferId,
      description: `Wallet transfer received`,
      metadata: { kind: 'p2p_transfer', sender_user_id: id.user_id, transfer_id: transferId },
    });
    if (!credit.ok) {
      const refund = await creditWalletForEarning({
        account_id: senderAccount.id,
        amount_minor: amountMinor,
        currency,
        reference_type: 'manual',
        reference_id: `${transferId}-refund`,
        description: `Refund: transfer to ${recipientDisplay} failed (${credit.error})`,
      });
      if (refund.ok) {
        return {
          ok: true,
          result: { sent: false, error_code: credit.error, refunded: true },
          text: `The transfer to ${recipientDisplay} didn't go through, so I've refunded your ${fmtMinor(amountMinor, currency)}.`,
        };
      }
      // Debit succeeded, credit failed, AND the compensating refund failed.
      // This needs human reconciliation — never hide it as a soft "ok" outcome.
      return {
        ok: false,
        error: `Transfer to ${recipientDisplay} failed after debit (${credit.error}), and the automatic refund also failed (${refund.error}). This needs manual reconciliation — reference ${transferId}.`,
      };
    }

    return {
      ok: true,
      result: {
        sent: true,
        recipient_user_id: recipientUserId,
        recipient_name: recipientDisplay,
        amount_minor: amountMinor,
        currency,
        transfer_id: transferId,
        new_balance_minor: debit.balance_minor,
      },
      text: `Done — sent ${fmtMinor(amountMinor, currency)} to ${recipientDisplay}. Your new balance is ${
        debit.balance_minor != null ? fmtMinor(debit.balance_minor, currency) : 'updated'
      }.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'send_funds failed') };
  }
}

// ---------------------------------------------------------------------------
// request_payment — STUBBED. See file header: no payment_requests table; the
// only precedent (message_type='payment_request' chat message) is rejected by
// the gateway's own POST /api/v1/chat/send allowedTypes set.
// ---------------------------------------------------------------------------

export async function tool_request_payment(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('request_payment', id);
  if (gate) return gate;
  return {
    ok: false,
    error:
      "request_payment is not available yet — no backing endpoint. Payment requests exist only as a message_type='payment_request' chat-message convention the community frontend inserts directly (bypassing the gateway's own POST /api/v1/chat/send, whose allowedTypes explicitly excludes 'payment_request'). There is no payment_requests table and no gateway-owned way to create one. Tell the user to send the request from the Wallet or Messages screen.",
  };
}

// ---------------------------------------------------------------------------
// exchange_currency (⚠️ confirm) — STUBBED. See file header: no cross-currency
// RPC exists; the only exchange_rates table is a legacy ghost table explicitly
// marked out-of-scope in the VTID-03186 migration.
// ---------------------------------------------------------------------------

export async function tool_exchange_currency(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('exchange_currency', id);
  if (gate) return gate;
  return {
    ok: false,
    error:
      "exchange_currency is not available yet — no backing RPC. debit_wallet_for_spend / credit_wallet_for_earning only move money within a single currency (EUR or USD); there is no cross-currency conversion RPC in the gateway. The only exchange_rates table in the schema is a legacy Lovable-era ghost table (VTNA/CREDITS tokens) explicitly marked OUT OF SCOPE pending a convergence decision (see supabase/migrations/20260605000000_VTID_03186_universal_cart_schema.sql).",
  };
}

// ---------------------------------------------------------------------------
// get_exchange_rate — STUBBED. Same rationale as exchange_currency.
// ---------------------------------------------------------------------------

export async function tool_get_exchange_rate(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_exchange_rate', id);
  if (gate) return gate;
  return {
    ok: false,
    error:
      "get_exchange_rate is not available yet — no backing table/RPC. The canonical wallet only has EUR and USD accounts with no conversion concept; the only exchange_rates table found is the legacy ghost table called out as out-of-scope in the VTID-03186 migration, and it is not wired to any gateway service.",
  };
}

// ---------------------------------------------------------------------------
// set_display_currency — STUBBED. Verified client-only (localStorage), no
// server-side column exists at all.
// ---------------------------------------------------------------------------

export async function tool_set_display_currency(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('set_display_currency', id);
  if (gate) return gate;
  return {
    ok: false,
    error:
      "set_display_currency is not available yet — no backing column. The USD/EUR display toggle is stored only in the browser's localStorage (vitana.wallet.displayCurrency); there is no app_users column or user_preferences table for the gateway to write.",
  };
}

// ---------------------------------------------------------------------------
// get_referral_earnings — REAL: rewards_ledger (VCAOP), same table
// GET /api/v1/vcaop/wallet reads for the caller.
// ---------------------------------------------------------------------------

export async function tool_get_referral_earnings(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_referral_earnings', id);
  if (gate) return gate;
  try {
    const { data, error } = await sb
      .from('rewards_ledger')
      .select('amount, state, currency, created_at')
      .eq('user_id', id.user_id)
      .order('created_at', { ascending: false });
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<{ amount: number; state: string; currency: string; created_at: string }>;
    if (rows.length === 0) {
      return {
        ok: true,
        result: { total_earned: 0, pending: 0, currency: 'EUR', entry_count: 0 },
        text: "You haven't earned any referral rewards yet. Share your referral links from Business Hub → Sell & Earn → Referrals to start.",
      };
    }
    const currency = rows[0].currency || 'EUR';
    let earned = 0;
    let pending = 0;
    let reversed = 0;
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (r.state === 'confirmed' || r.state === 'redeemable') earned += amt;
      else if (r.state === 'pending') pending += amt;
      else if (r.state === 'reversed') reversed += amt;
    }
    return {
      ok: true,
      result: {
        total_earned: +earned.toFixed(2),
        pending: +pending.toFixed(2),
        reversed: +reversed.toFixed(2),
        currency,
        entry_count: rows.length,
      },
      text: `You've earned ${earned.toFixed(2)} ${currency} in referral rewards${
        pending > 0 ? `, with ${pending.toFixed(2)} ${currency} still pending confirmation` : ''
      }.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'get_referral_earnings failed') };
  }
}

// ---------------------------------------------------------------------------
// get_commissions_summary — REAL: commission_event (VCAOP), scoped to the
// current calendar month, same source GET /api/v1/vcaop/commissions reads
// (that route is admin-only; this queries the same table directly, scoped to
// the caller's own user_id, same pattern every other read-only tool here uses).
// ---------------------------------------------------------------------------

export async function tool_get_commissions_summary(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_commissions_summary', id);
  if (gate) return gate;
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const { data, error } = await sb
      .from('commission_event')
      .select('gross_commission, currency, status, merchant, created_at')
      .eq('user_id', id.user_id)
      .gte('created_at', monthStart)
      .order('created_at', { ascending: false });
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<{
      gross_commission: number;
      currency: string;
      status: string;
      merchant: string;
      created_at: string;
    }>;
    if (rows.length === 0) {
      return {
        ok: true,
        result: { total: 0, confirmed: 0, pending: 0, currency: 'EUR', count: 0 },
        text: "You don't have any commissions this month yet.",
      };
    }
    const currency = rows[0].currency || 'EUR';
    let confirmed = 0;
    let pending = 0;
    let reversed = 0;
    for (const r of rows) {
      const amt = Number(r.gross_commission) || 0;
      if (r.status === 'confirmed') confirmed += amt;
      else if (r.status === 'pending') pending += amt;
      else if (r.status === 'reversed') reversed += amt;
    }
    const total = confirmed + pending;
    return {
      ok: true,
      result: {
        total: +total.toFixed(2),
        confirmed: +confirmed.toFixed(2),
        pending: +pending.toFixed(2),
        reversed: +reversed.toFixed(2),
        currency,
        count: rows.length,
      },
      text: `This month you've made ${total.toFixed(2)} ${currency} in commissions across ${rows.length} order${
        rows.length === 1 ? '' : 's'
      } — ${confirmed.toFixed(2)} ${currency} confirmed and ${pending.toFixed(2)} ${currency} still pending.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'get_commissions_summary failed') };
  }
}

// ---------------------------------------------------------------------------
// get_pending_rewards — REAL: rewards_ledger where state='pending' (VCAOP).
// ---------------------------------------------------------------------------

export async function tool_get_pending_rewards(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('get_pending_rewards', id);
  if (gate) return gate;
  try {
    const { data, error } = await sb
      .from('rewards_ledger')
      .select('amount, currency, created_at')
      .eq('user_id', id.user_id)
      .eq('state', 'pending')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<{ amount: number; currency: string; created_at: string }>;
    if (rows.length === 0) {
      return {
        ok: true,
        result: { pending_total: 0, currency: 'EUR', count: 0 },
        text: "You don't have any pending rewards right now.",
      };
    }
    const currency = rows[0].currency || 'EUR';
    const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return {
      ok: true,
      result: { pending_total: +total.toFixed(2), currency, count: rows.length },
      text: `You have ${total.toFixed(2)} ${currency} in pending rewards across ${rows.length} entr${
        rows.length === 1 ? 'y' : 'ies'
      } — they'll confirm once the merchant validates the order.`,
    };
  } catch (err) {
    return { ok: false, error: errText(err, 'get_pending_rewards failed') };
  }
}

// ---------------------------------------------------------------------------
// list_payment_requests — STUBBED. Same rationale as request_payment: no
// structured table to list, and the frontend's chat-message convention isn't
// reachable through the gateway's own send validation either.
// ---------------------------------------------------------------------------

export async function tool_list_payment_requests(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('list_payment_requests', id);
  if (gate) return gate;
  return {
    ok: false,
    error:
      "list_payment_requests is not available yet — no backing endpoint. Payment requests are only free-text chat messages (message_type='payment_request', set by the frontend directly, outside the gateway's own send validation), so there is no structured table or list/read endpoint to query them from.",
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const WALLET_PAYMENTS_TOOL_HANDLERS: Record<string, Handler> = {
  get_wallet_summary: tool_get_wallet_summary,
  list_wallet_transactions: tool_list_wallet_transactions,
  send_funds: tool_send_funds,
  request_payment: tool_request_payment,
  exchange_currency: tool_exchange_currency,
  get_exchange_rate: tool_get_exchange_rate,
  set_display_currency: tool_set_display_currency,
  get_referral_earnings: tool_get_referral_earnings,
  get_commissions_summary: tool_get_commissions_summary,
  get_pending_rewards: tool_get_pending_rewards,
  list_payment_requests: tool_list_payment_requests,
};

export const WALLET_PAYMENTS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'get_wallet_summary',
    description: [
      'READ-ONLY wallet snapshot: balance per currency, active subscription,',
      'lifetime + pending referral rewards, and recent activity.',
      'CALL WHEN the user asks: "give me my wallet summary", "how much do I have',
      'and how much have I earned", "wie steht es um mein Wallet".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_wallet_transactions',
    description: [
      "READ-ONLY: list the user's recent wallet transactions, newest first.",
      'Supports pagination via cursor (from a previous call\'s next_cursor).',
      'CALL WHEN the user asks: "show my transactions", "what did I spend',
      'recently", "zeig mir meine letzten Transaktionen".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to read out, 1-50. Uses 15 when omitted.' },
        currency: { type: 'string', description: "Optional: 'EUR' or 'USD' to filter to one currency." },
        cursor: { type: 'string', description: 'Pass the previous next_cursor to page further back.' },
      },
      required: [],
    },
  },
  {
    name: 'send_funds',
    description: [
      'Send money from the user\'s wallet to another Vitana member (internal',
      'transfer only — never a card charge). ALWAYS call once WITHOUT confirm',
      'first — it resolves the recipient and previews the amount; after the user',
      'says yes, call again with confirm:true, recipient_user_id, amount and',
      'currency from the preview result.',
      'CALL WHEN the user says: "send Anna 20 euros", "transfer money to Peter",',
      '"schicke Anna 20 Euro".',
      'This is the ONLY tool that fully executes money movement by voice.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        recipient_name: { type: 'string', description: 'Spoken name of who to send money to.' },
        recipient_user_id: { type: 'string', description: 'Exact recipient UUID once resolved from a previous call.' },
        amount: { type: 'number', description: 'Amount in major currency units, e.g. 20 for 20.00.' },
        currency: { type: 'string', description: "'EUR' or 'USD'. Omit if the user has only one wallet currency." },
        confirm: { type: 'boolean', description: 'true ONLY after the user explicitly confirmed the preview.' },
      },
      required: [],
    },
  },
  {
    name: 'request_payment',
    description: [
      'NOT YET AVAILABLE — always returns an error explaining there is no',
      'backing endpoint for payment requests. Do not imply this worked; tell',
      'the user to send a payment request from the Wallet or Messages screen.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        recipient_name: { type: 'string', description: 'Spoken name of who the request would go to.' },
        amount: { type: 'number', description: 'Amount requested, major currency units.' },
        currency: { type: 'string', description: "'EUR' or 'USD'." },
        description: { type: 'string', description: 'What the request is for.' },
      },
      required: [],
    },
  },
  {
    name: 'exchange_currency',
    description: [
      'NOT YET AVAILABLE — always returns an error: the wallet has no',
      'cross-currency conversion RPC. Do not imply this worked.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to exchange.' },
        from_currency: { type: 'string', description: "Source currency, e.g. 'EUR'." },
        to_currency: { type: 'string', description: "Target currency, e.g. 'USD'." },
        confirm: { type: 'boolean', description: 'Not used — the tool is unavailable.' },
      },
      required: [],
    },
  },
  {
    name: 'get_exchange_rate',
    description: [
      'NOT YET AVAILABLE — always returns an error: no exchange-rate',
      'table/RPC is wired into the gateway.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        from_currency: { type: 'string', description: "e.g. 'EUR'." },
        to_currency: { type: 'string', description: "e.g. 'USD'." },
      },
      required: [],
    },
  },
  {
    name: 'set_display_currency',
    description: [
      'NOT YET AVAILABLE — always returns an error: the display-currency toggle',
      'is stored only in the browser, not on any server-side record.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        currency: { type: 'string', description: "'EUR' or 'USD'." },
      },
      required: [],
    },
  },
  {
    name: 'get_referral_earnings',
    description: [
      'READ-ONLY: total referral rewards earned (confirmed) and pending, from',
      "the user's reward ledger.",
      'CALL WHEN the user asks: "how much have I earned from referrals",',
      '"was habe ich mit Empfehlungen verdient".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_commissions_summary',
    description: [
      'READ-ONLY: commissions earned this calendar month — total, confirmed,',
      'and still-pending amounts.',
      'CALL WHEN the user asks: "what are my commissions this month",',
      '"wie viel Provision habe ich diesen Monat gemacht".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pending_rewards',
    description: [
      'READ-ONLY: rewards awaiting merchant confirmation (not yet payable).',
      'CALL WHEN the user asks: "do I have any pending rewards",',
      '"was ist noch ausstehend bei meinen Prämien".',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_payment_requests',
    description: [
      'NOT YET AVAILABLE — always returns an error: payment requests have no',
      'structured table to list from.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: "'incoming' or 'outgoing' — not used, tool is unavailable." },
      },
      required: [],
    },
  },
];
