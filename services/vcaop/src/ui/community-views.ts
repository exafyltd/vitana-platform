/**
 * Community UI view-models (UIC-WALLET-0001 / UIC-CART-0002, runbook Sec. 6).
 *
 * Framework-agnostic presenters the community React app binds to. The actual
 * components live in the Vitanaland frontend (BLK-003). These enforce ownership
 * (a user only ever sees their own data) and never expose secrets/PII.
 */
import { Repository, Record_ } from '../api/repository';
import { Attribution } from '../rewards/attribution';

export interface WalletEntry {
  id: string;
  amount: number;
  state: string; // pending | confirmed | redeemable | redeemed | reversed
}
export interface WalletView {
  userId: string;
  balance: number; // spendable (confirmed/redeemable)
  pending: number;
  entries: WalletEntry[];
}

/** Wallet + earnings ledger for the OWNING user only (RLS-equivalent at the presenter). */
export async function buildWalletView(userId: string, repo: Repository, attr = new Attribution(repo, { emit: async () => {} })): Promise<WalletView> {
  const rows = await repo.list('rewards_ledger', (r) => r.user_id === userId);
  const entries: WalletEntry[] = rows.map((r) => ({ id: String(r.id), amount: Number(r.amount), state: String(r.state) }));
  const pending = rows.filter((r) => r.state === 'pending').reduce((s, r) => s + Number(r.amount), 0);
  return { userId, balance: await attr.walletBalance(userId), pending: +pending.toFixed(4), entries };
}

export interface CartLineView {
  merchant: string;
  checkoutConnector: string | null;
  itemCount: number;
}
export interface CartView {
  cartOrderId: string;
  userId: string;
  total: number;
  lines: CartLineView[];
  /** FTC disclosure — MUST be present and non-dismissible at checkout. */
  disclosure: { text: string; dismissible: boolean } | null;
}

/** Cart summary + affiliate disclosure for the owning user. */
export async function buildCartView(cartOrderId: string, userId: string, repo: Repository): Promise<CartView | null> {
  const cart = await repo.get('cart_order', cartOrderId);
  if (!cart || cart.user_id !== userId) return null; // ownership
  const routes = await repo.list('merchant_route', (r) => r.cart_order_id === cartOrderId);
  const disclosures = await repo.list('disclosure', (r) => r.cart_order_id === cartOrderId);
  const d = disclosures[0] as Record_ | undefined;
  return {
    cartOrderId,
    userId,
    total: Number(cart.total_amount ?? 0),
    lines: routes.map((r) => ({
      merchant: String(r.merchant),
      checkoutConnector: (r.checkout_connector as string) ?? null,
      itemCount: Array.isArray(r.line_items) ? (r.line_items as unknown[]).length : 0,
    })),
    disclosure: d ? { text: String(d.text), dismissible: Boolean(d.dismissible) } : null,
  };
}
