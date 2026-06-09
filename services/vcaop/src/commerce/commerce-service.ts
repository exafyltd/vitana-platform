/**
 * Commerce service (the revenue + rewards loop).
 *
 * Ties Universal Cart + monetization + attribution into the end-to-end value flow:
 *   user shops -> cart routed via the checkout ladder -> per-user SubID minted ->
 *   PENDING commission/reward recorded (projected earnings) -> on a confirmed
 *   purchase postback, the reward is credited to the user's wallet -> reversal
 *   claws back. This is how users buy products/services and earn rewards/commissions
 *   while Vitanaland captures affiliate revenue.
 */
import { Repository } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { CartService, CartMerchantInput, BuiltCart } from './cart';
import { Attribution } from '../rewards/attribution';

export interface ShopMerchantInput extends CartMerchantInput {
  /** Effective commission rate for the merchant (e.g. 0.05). Default 0.05. */
  commissionRate?: number;
}

export interface ProjectedEarning {
  merchant: string;
  affiliateProgramId: string | null;
  subId: string | null;
  commissionId: string | null;
  rewardId: string | null;
  projectedReward: number;
}

export interface ShopResult {
  cart: BuiltCart;
  earnings: ProjectedEarning[];
  totalProjectedReward: number;
}

export class CommerceService {
  private readonly cart: CartService;
  private readonly attr: Attribution;
  constructor(private readonly repo: Repository, private readonly oasis: OasisSink, private readonly userShare = 0.5) {
    this.cart = new CartService(repo, oasis);
    this.attr = new Attribution(repo, oasis);
  }

  /** Shop: build + route the multi-merchant cart and record projected (pending) rewards. */
  async shop(userId: string, merchants: ShopMerchantInput[]): Promise<ShopResult> {
    const built = await this.cart.buildAndRoute(userId, merchants);
    const earnings: ProjectedEarning[] = [];

    for (const m of merchants) {
      const route = built.routes.find((r) => r.merchant === m.merchant);
      if (!route || !m.affiliateProgramId || !route.subId) {
        earnings.push({ merchant: m.merchant, affiliateProgramId: m.affiliateProgramId ?? null, subId: route?.subId ?? null, commissionId: null, rewardId: null, projectedReward: 0 });
        continue;
      }
      const rate = m.commissionRate ?? 0.05;
      const grossCommission = +(route.total * rate).toFixed(4);
      const { commissionId, rewardId } = await this.attr.ingestPending({
        subId: route.subId, userId, affiliateProgramId: m.affiliateProgramId, merchant: m.merchant,
        orderRef: route.merchantRouteId, grossCommission, userShare: this.userShare,
      });
      earnings.push({ merchant: m.merchant, affiliateProgramId: m.affiliateProgramId, subId: route.subId, commissionId, rewardId, projectedReward: +(grossCommission * this.userShare).toFixed(4) });
    }

    const totalProjectedReward = +earnings.reduce((s, e) => s + e.projectedReward, 0).toFixed(4);
    await this.oasis.emit({
      type: 'vcaop.commerce.shopped', source: 'commerce', status: 'success',
      message: `shop routed ${built.routes.length} merchant(s); projected reward ${totalProjectedReward}`,
      payload: { cartOrderId: built.cartOrderId, userId, totalProjectedReward },
    });
    return { cart: built, earnings, totalProjectedReward };
  }

  /** A confirmed purchase postback → confirm the commission and credit the user's wallet. */
  async confirmPurchase(commissionId: string, postbackRef: string): Promise<void> {
    await this.attr.confirm(commissionId, postbackRef);
  }

  /** A reversal/refund → claw back the reward. */
  async reversePurchase(commissionId: string, reason?: string): Promise<void> {
    await this.attr.reverse(commissionId, reason);
  }

  /** The user's spendable wallet balance + ledger. */
  async wallet(userId: string): Promise<{ balance: number; entries: { id: string; amount: number; state: string }[] }> {
    const balance = await this.attr.walletBalance(userId);
    const rows = await this.repo.list('rewards_ledger', (r) => r.user_id === userId);
    return { balance, entries: rows.map((r) => ({ id: String(r.id), amount: Number(r.amount), state: String(r.state) })) };
  }
}
