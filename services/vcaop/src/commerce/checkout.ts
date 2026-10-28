/**
 * Checkout connector ladder (CMRC-CART-0001, runbook Sec. 2.3 / Sec. 4.6).
 *
 * Maps a merchant to the best checkout path: API-class (UCP / Shopify-agent /
 * Violet) preferred, browser (Rye / Skyvern) as fallback. Vendors unverified —
 * mock-to-interface per Sec. 0.8. Swappable behind `CheckoutConnector`.
 */
import { OperateResult } from '../connectors/connector';

export type CheckoutKind = 'ucp' | 'shopify_agent' | 'violet' | 'rye' | 'skyvern';

/** Preference order: API-class first, browser fallback last. */
export const CHECKOUT_LADDER: CheckoutKind[] = ['ucp', 'shopify_agent', 'violet', 'rye', 'skyvern'];

export interface CheckoutLineItem {
  sku: string;
  qty: number;
  price: number;
}

export interface CheckoutConnector {
  kind: CheckoutKind;
  /** Place/route the order for a merchant. Mock impls never hit a live merchant. */
  route(merchant: string, items: CheckoutLineItem[]): Promise<OperateResult>;
}

/** Pick the highest-preference checkout kind a merchant supports. */
export function pickCheckout(supported: CheckoutKind[]): CheckoutKind {
  for (const kind of CHECKOUT_LADDER) {
    if (supported.includes(kind)) return kind;
  }
  // Default to browser fallback if nothing declared (still mock in dev/CI).
  return 'skyvern';
}

/** Mock checkout connector — echoes the routed order; no live merchant calls. */
export class MockCheckoutConnector implements CheckoutConnector {
  constructor(public readonly kind: CheckoutKind) {}
  async route(merchant: string, items: CheckoutLineItem[]): Promise<OperateResult> {
    const total = items.reduce((s, i) => s + i.qty * i.price, 0);
    return { ok: true, data: { merchant, kind: this.kind, itemCount: items.length, total: +total.toFixed(2) } };
  }
}
