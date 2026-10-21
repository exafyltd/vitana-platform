/**
 * Single lazy Stripe client for the wallet domain.
 *
 * Lazy so test envs without STRIPE_SECRET_KEY can import wallet routes
 * without crashing at module load. The error fires only when a route
 * actually tries to talk to Stripe.
 */

import Stripe from 'stripe';

let _client: Stripe | null = null;

export function getWalletStripe(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  _client = new Stripe(key);
  return _client;
}

export function getWalletWebhookSecret(): string {
  return process.env.STRIPE_WALLET_WEBHOOK_SECRET || '';
}

export function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'https://vitanaland.com';
}

export function getEnvironmentTag(): string {
  return process.env.NODE_ENV === 'production' ? 'production' : (process.env.NODE_ENV || 'development');
}

// Test-only: allow tests to inject a mock Stripe client.
export function __setWalletStripeForTests(client: Stripe | null): void {
  _client = client;
}
