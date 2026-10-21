/**
 * Conservative per-provider policy seeds (runbook CTRL-POLICY-0003, Sec. 4.3).
 *
 * These are SEEDS, not verified ToS rulings. Every major provider is
 * `registration_method: human_required` and `captcha_policy: human_only`, and
 * `multi_account_allowed: false`. `automation_allowed` is the CEILING for
 * post-registration operations — nothing self-registers, and all live calls stay
 * mock/sandbox until a connector is verified (Sec. 0.8). An admin tightens/loosens
 * these later (Sec. 5); unknown providers remain default-deny (PolicyEngine).
 *
 * `affiliate_cashback_allowed`: true only for affiliate networks/aggregators whose
 * purpose is commission sharing; null for marketplaces (gated off until reviewed);
 * false for loyalty programs (official, read-only — no user cashback).
 */
import { PolicyEngine, ProviderPolicy } from '../guardrails/policy-engine';

const REVIEW = 'conservative seed — ToS not yet verified (Sec. 0.8); verify before enabling live automation';

function marketplace(automation: ProviderPolicy['automation_allowed'], notes = REVIEW): ProviderPolicy {
  return {
    automation_allowed: automation,
    registration_method: 'human_required',
    captcha_policy: 'human_only',
    kyb_required: true,
    multi_account_allowed: false,
    affiliate_cashback_allowed: null,
    notes,
  };
}

function affiliateNetwork(automation: ProviderPolicy['automation_allowed'] = 'api_only'): ProviderPolicy {
  return {
    automation_allowed: automation,
    registration_method: 'human_required',
    captcha_policy: 'human_only',
    kyb_required: true,
    multi_account_allowed: false,
    affiliate_cashback_allowed: true,
    notes: REVIEW,
  };
}

function loyaltyProgram(): ProviderPolicy {
  return {
    automation_allowed: 'manual_only',
    registration_method: 'human_required',
    captcha_policy: 'human_only',
    kyb_required: false,
    multi_account_allowed: false,
    affiliate_cashback_allowed: false, // loyalty is official-API, read-only — no user cashback
    notes: 'loyalty: read-only, official-API-only, credential-free (guardrails 4/5); ' + REVIEW,
  };
}

/** Top ~20 provider seeds keyed by canonical provider id. */
export const PROVIDER_POLICY_SEEDS: Readonly<Record<string, ProviderPolicy>> = Object.freeze({
  // --- Supply-side marketplaces (L1) ---
  amazon: marketplace('api_only'), // SP-API, post human-gated registration
  ebay: marketplace('api_only'),
  walmart: marketplace('api_only'),
  bestbuy: marketplace('api_only'),
  shopify: marketplace('oauth_only'), // app install
  etsy: marketplace('oauth_only'),
  booking_com: marketplace('api_only'),
  expedia: marketplace('api_only'),
  aliexpress: marketplace('browser_with_human_submit'),
  target: marketplace('manual_only'), // no suitable ops API — human/manual

  // --- Affiliate networks & aggregators (L2) ---
  // Amazon.ae Associates is LIVE (associate tag `vitanaland-21`). VERIFIED 2026-06-15:
  // the Amazon Associates Operating Agreement PROHIBITS offering users any incentive —
  // cashback, rebate, points, rewards — for using affiliate links. So Amazon items are
  // recommendations only and must NEVER carry Vitana rewards → affiliate_cashback_allowed=false.
  // PA-API product data is sales-gated (~3 qualifying sales / 180 days) so catalog auto-pull is
  // deferred; per-user affiliate-link decoration (`ascsubtag`) is all that's needed meanwhile.
  amazon_associates: {
    ...marketplace('api_only'),
    affiliate_cashback_allowed: false, // reviewed: Amazon forbids user cashback on affiliate links
    notes:
      'Amazon.ae Associates LIVE (tag vitanaland-21); recommendations only, NO user rewards on ' +
      'Amazon items per Operating Agreement; PA-API product data sales-gated. ' + REVIEW,
  },
  awin: affiliateNetwork(),
  cj: affiliateNetwork(), // Commission Junction
  impact: affiliateNetwork(),
  rakuten_advertising: affiliateNetwork(),
  skimlinks: affiliateNetwork(), // aggregator (~50k merchants)
  sovrn: affiliateNetwork(), // aggregator
  wildfire: affiliateNetwork(), // aggregator-class

  // --- Loyalty (L3, official read-only) ---
  united_mileageplus: loyaltyProgram(),
  marriott_bonvoy: loyaltyProgram(),
});

export const SEEDED_PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_POLICY_SEEDS));

/** Register all seeds into a PolicyEngine. Returns the engine for chaining. */
export function seedPolicyEngine(engine: PolicyEngine = new PolicyEngine()): PolicyEngine {
  for (const [providerId, policy] of Object.entries(PROVIDER_POLICY_SEEDS)) {
    engine.setPolicy(providerId, policy);
  }
  return engine;
}
