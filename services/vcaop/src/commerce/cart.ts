/**
 * Universal Cart (CMRC-CART-0001, runbook Sec. 4.6).
 *
 * Builds a multi-merchant cart and routes each merchant through the checkout ladder
 * (pickCheckout). Attaches a per-merchant affiliate SubID (monetization) when a
 * route is available. A NON-DISMISSIBLE FTC affiliate disclosure is attached to
 * every cart (Sec. 4.6 / Sec. 10).
 */
import { Repository, newId } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { CheckoutConnector, CheckoutKind, CheckoutLineItem, pickCheckout, MockCheckoutConnector } from './checkout';
import { mintSubId } from '../agents/monetization';

export const FTC_DISCLOSURE_TEXT =
  'Vitanaland earns a commission on qualifying purchases made through these links, ' +
  'which funds your stacked savings. This does not change the price you pay.';

export interface CartMerchantInput {
  merchant: string;
  items: CheckoutLineItem[];
  /** Checkout kinds the merchant supports (for ladder selection). */
  supports?: CheckoutKind[];
  /** Affiliate program id for SubID minting (optional). */
  affiliateProgramId?: string;
}

export interface RoutedMerchant {
  merchantRouteId: string;
  merchant: string;
  checkoutConnector: CheckoutKind;
  subId: string | null;
  total: number;
  status: string;
}

export interface BuiltCart {
  cartOrderId: string;
  disclosureId: string;
  routes: RoutedMerchant[];
  total: number;
}

export class CartService {
  constructor(
    private readonly repo: Repository,
    private readonly oasis: OasisSink,
    /** Factory for a checkout connector of a given kind (mock by default). */
    private readonly checkoutFactory: (kind: CheckoutKind) => CheckoutConnector = (k) => new MockCheckoutConnector(k),
  ) {}

  /** Build a multi-merchant cart and route each merchant; attach FTC disclosure. */
  async buildAndRoute(userId: string, merchants: CartMerchantInput[]): Promise<BuiltCart> {
    const cart = await this.repo.create('cart_order', {
      id: newId('cart_order'),
      user_id: userId,
      status: 'open',
      currency: 'EUR',
    });

    // Non-dismissible FTC disclosure on every cart.
    const disclosure = await this.repo.create('disclosure', {
      id: newId('disclosure'),
      cart_order_id: cart.id,
      kind: 'ftc_affiliate',
      text: FTC_DISCLOSURE_TEXT,
      dismissible: false,
      shown_at: new Date().toISOString(),
    });

    const routes: RoutedMerchant[] = [];
    let cartTotal = 0;

    for (const m of merchants) {
      const kind = pickCheckout(m.supports ?? []);
      const connector = this.checkoutFactory(kind);
      const result = await connector.route(m.merchant, m.items);
      const total = Number((result.data as { total?: number })?.total ?? 0);
      cartTotal += total;
      const subId = m.affiliateProgramId ? mintSubId(userId, m.affiliateProgramId) : null;

      const route = await this.repo.create('merchant_route', {
        id: newId('merchant_route'),
        cart_order_id: cart.id,
        merchant: m.merchant,
        checkout_connector: kind,
        affiliate_program_id: m.affiliateProgramId ?? null,
        sub_id: subId,
        line_items: m.items,
        status: result.ok ? 'routed' : 'failed',
      });

      routes.push({ merchantRouteId: route.id, merchant: m.merchant, checkoutConnector: kind, subId, total, status: route.status as string });
    }

    await this.repo.update('cart_order', cart.id, { status: 'routed', total_amount: +cartTotal.toFixed(2) });
    await this.oasis.emit({
      type: 'vcaop.cart.routed', source: 'cart', status: 'success',
      message: `cart routed across ${routes.length} merchant(s)`,
      payload: { cartOrderId: cart.id, merchants: routes.length },
    });

    return { cartOrderId: cart.id, disclosureId: disclosure.id, routes, total: +cartTotal.toFixed(2) };
  }
}
