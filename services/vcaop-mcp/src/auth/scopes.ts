/** Granular OAuth scopes (least privilege — brief Sec. 6/14). */
export const SCOPES = {
  CATALOG_READ: 'vitana:catalog:read',
  CART_READ: 'vitana:cart:read',
  ORDERS_READ: 'vitana:orders:read',
  WALLET_READ: 'vitana:wallet:read',
  REWARDS_READ: 'vitana:rewards:read',
  PARTNERS_READ: 'vitana:partners:read',
} as const;

export const ALL_SCOPES: string[] = Object.values(SCOPES);

/** True when every required scope is granted. */
export function hasScopes(granted: string[], required: string[]): boolean {
  return required.every((s) => granted.includes(s));
}
