/**
 * Community voice tools — Subscriptions & Billing (A4) + Vouchers & Referrals
 * (A5), Wave 4 of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/billing.ts and routes/automations.ts.
 * Stripe-backed writes (upgrade_subscription, add_voice_minutes) prepare a
 * Checkout Session and hand off the URL to the screen — voice never
 * confirms a card charge, per the plan's payment policy.
 * cancel_subscription/get_billing_history have no dedicated backend beyond
 * the Stripe Customer Portal — both hand off there rather than inventing
 * an invoice-list/cancel endpoint. redeem_voucher, send_gift_voucher and
 * activate_reseller are NOT implemented here — vouchers/reseller tables are
 * explicitly out-of-scope "ghost tables" (VTID-03186 migration comment),
 * so those three stay `status: planned` in the manifest.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

const NO_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_session' },
  text: "I need your signed-in session to check that — I don't have one for this voice session.",
};

// ---------------------------------------------------------------------------
// 1. get_my_subscription — GET /api/v1/billing/me
// ---------------------------------------------------------------------------

export const get_my_subscription: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_my_subscription requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/billing/me', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `get_my_subscription failed (${status}): ${String(body.error ?? 'unknown')}` };
  const plan = (body.plan ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: body,
    text: `Your plan is ${String(plan.plan_key ?? 'unknown')} (${String(plan.status ?? 'unknown')}).`,
  };
};

// ---------------------------------------------------------------------------
// 2. compare_subscription_plans — direct Supabase read (no dedicated route)
// ---------------------------------------------------------------------------

export const compare_subscription_plans: Handler = async (_args, id, sb) => {
  if (!id.user_id) return { ok: false, error: 'compare_subscription_plans requires an authenticated user.' };
  const [plansRes, pricesRes] = await Promise.all([
    sb.from('subscription_plans').select('plan_key, display_name, description'),
    sb.from('subscription_plan_prices').select('plan_key, price_key, billing_interval, price_cents, currency'),
  ]);
  if (plansRes.error) return { ok: false, error: `compare_subscription_plans failed: ${plansRes.error.message}` };
  const plans = (plansRes.data ?? []) as Array<{ plan_key: string; display_name?: string }>;
  const prices = (pricesRes.data ?? []) as Array<{ plan_key: string; price_key: string; billing_interval: string; price_cents: number; currency: string }>;
  if (plans.length === 0) return { ok: true, result: { plans: [] }, text: 'No subscription plans found.' };
  const lines = plans.map((p) => {
    const planPrices = prices.filter((pr) => pr.plan_key === p.plan_key);
    const priceText = planPrices.map((pr) => `${(pr.price_cents / 100).toFixed(2)} ${pr.currency}/${pr.billing_interval}`).join(' or ');
    return `${p.display_name ?? p.plan_key}${priceText ? ` — ${priceText}` : ''}`;
  });
  return { ok: true, result: { plans, prices }, text: `Plans: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 3. upgrade_subscription — POST /api/v1/billing/checkout/subscription
// ---------------------------------------------------------------------------

export const upgrade_subscription: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'upgrade_subscription requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const priceKey = String(args.price_key ?? '').trim();
  if (!priceKey) return { ok: false, error: 'upgrade_subscription requires price_key — look it up with compare_subscription_plans first.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, price_key: priceKey },
      text: `About to start checkout for plan "${priceKey}" — you'll confirm payment on screen. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/billing/checkout/subscription', {
    method: 'POST',
    headers: authHeaders(id),
    body: { price_key: priceKey },
  });
  if (!ok) return { ok: true, result: { started: false, status, detail: body }, text: `Could not start checkout: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return {
    ok: true,
    result: { started: true, checkout_url: body.session_url ?? body.url, directive: { type: 'orb_directive', directive: 'open_url', url: body.session_url ?? body.url } },
    text: `Opening checkout to finish upgrading — confirm payment on screen.`,
  };
};

// ---------------------------------------------------------------------------
// 4. cancel_subscription — hands off to the Stripe billing portal (no direct cancel route)
// ---------------------------------------------------------------------------

export const cancel_subscription: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'cancel_subscription requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/billing/portal', { method: 'POST', headers: authHeaders(id) });
  if (!ok) return { ok: true, result: { opened: false, status, detail: body }, text: `Could not open the billing portal: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return {
    ok: true,
    result: { opened: true, portal_url: body.url, directive: { type: 'orb_directive', directive: 'open_url', url: body.url } },
    text: `There's no direct voice-cancel — opening your billing portal where you can cancel the subscription.`,
  };
};

// ---------------------------------------------------------------------------
// 5. add_voice_minutes — POST /api/v1/billing/checkout/credits
// ---------------------------------------------------------------------------

export const add_voice_minutes: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'add_voice_minutes requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const pack = String(args.credit_pack ?? '').trim();
  if (!['starter', 'boost', 'power'].includes(pack)) {
    return { ok: false, error: 'add_voice_minutes requires credit_pack: starter, boost, or power.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, credit_pack: pack },
      text: `About to start checkout for the "${pack}" credit pack — you'll confirm payment on screen. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/billing/checkout/credits', {
    method: 'POST',
    headers: authHeaders(id),
    body: { credit_pack: pack },
  });
  if (!ok) return { ok: true, result: { started: false, status, detail: body }, text: `Could not start checkout: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return {
    ok: true,
    result: { started: true, checkout_url: body.session_url ?? body.url, directive: { type: 'orb_directive', directive: 'open_url', url: body.session_url ?? body.url } },
    text: `Opening checkout for the "${pack}" pack — confirm payment on screen.`,
  };
};

// ---------------------------------------------------------------------------
// 6. redeem_subscription_code — POST /api/v1/billing/redeem (internal, voice-completable)
// ---------------------------------------------------------------------------

export const redeem_subscription_code: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'redeem_subscription_code requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const code = String(args.code ?? '').trim();
  if (!code) return { ok: false, error: 'redeem_subscription_code requires a code.' };
  const { ok, status, body } = await gatewayApiCall('/api/v1/billing/redeem', {
    method: 'POST',
    headers: authHeaders(id),
    body: { code },
  });
  if (!ok) return { ok: true, result: { redeemed: false, status, detail: body }, text: `Could not redeem that code: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { redeemed: true, detail: body }, text: `Code redeemed.` };
};

// ---------------------------------------------------------------------------
// 7. get_billing_history — hands off to the Stripe billing portal (no invoice-list route)
// ---------------------------------------------------------------------------

export const get_billing_history: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_billing_history requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/billing/portal', { method: 'POST', headers: authHeaders(id) });
  if (!ok) return { ok: true, result: { opened: false, status, detail: body }, text: `Could not open the billing portal: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return {
    ok: true,
    result: { opened: true, portal_url: body.url, directive: { type: 'orb_directive', directive: 'open_url', url: body.url } },
    text: `There's no in-voice invoice list yet — opening your billing portal, which shows your full billing history.`,
  };
};

// ---------------------------------------------------------------------------
// 8. get_referral_link — GET/POST /api/v1/automations/sharing/*
// ---------------------------------------------------------------------------

export const get_referral_link: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_referral_link requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const listRes = await gatewayApiCall('/api/v1/automations/sharing/links', { headers: authHeaders(id) });
  const links = (Array.isArray((listRes.body as Record<string, unknown>).links) ? (listRes.body as Record<string, unknown>).links : []) as Array<{ url?: string }>;
  if (links.length > 0) {
    return { ok: true, result: { link: links[0] }, text: `Your referral link: ${String(links[0].url ?? '')}` };
  }
  const genRes = await gatewayApiCall('/api/v1/automations/sharing/generate-link', {
    method: 'POST',
    headers: authHeaders(id),
    body: { target_type: 'referral' },
  });
  if (!genRes.ok) return { ok: false, error: `get_referral_link failed (${genRes.status}): ${String(genRes.body.error ?? 'unknown')}` };
  const link = (genRes.body.link ?? {}) as Record<string, unknown>;
  return { ok: true, result: { link }, text: `Your new referral link: ${String(link.url ?? '')}` };
};

// ---------------------------------------------------------------------------
// 9. invite_friend — generates/shares a link only; there is no outbound
// email/SMS dispatch anywhere in the backend today.
// ---------------------------------------------------------------------------

export const invite_friend: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'invite_friend requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true },
      text: `I can generate a shareable invite link for you (there's no automated way to email/text your friend directly yet). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/automations/sharing/generate-link', {
    method: 'POST',
    headers: authHeaders(id),
    body: { target_type: 'referral' },
  });
  if (!ok) return { ok: true, result: { generated: false, status, detail: body }, text: `Could not generate an invite link: ${String(body.error ?? `gateway returned ${status}`)}.` };
  const link = (body.link ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: { generated: true, link },
    text: `Here's your invite link to share: ${String(link.url ?? '')}. Send it to your friend yourself — voice can't send it for you yet.`,
  };
};

// ---------------------------------------------------------------------------
// 10. get_referral_status — GET /api/v1/automations/referrals
// ---------------------------------------------------------------------------

export const get_referral_status: Handler = async (_args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_referral_status requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/automations/referrals', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `get_referral_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  const referrals = (Array.isArray((body as Record<string, unknown>).referrals) ? (body as Record<string, unknown>).referrals : []) as Array<{ status: string }>;
  if (referrals.length === 0) return { ok: true, result: { referrals: [] }, text: 'Nobody has joined via your referral link yet.' };
  const activated = referrals.filter((r) => r.status === 'activated').length;
  return { ok: true, result: { referrals }, text: `${referrals.length} referrals (${activated} activated).` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const SUBSCRIPTIONS_BILLING_TOOL_HANDLERS: Record<string, Handler> = {
  get_my_subscription,
  compare_subscription_plans,
  upgrade_subscription,
  cancel_subscription,
  add_voice_minutes,
  redeem_subscription_code,
  get_billing_history,
  get_referral_link,
  invite_friend,
  get_referral_status,
};

export const SUBSCRIPTIONS_BILLING_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'get_my_subscription', description: 'Current plan, status, renewal date, and voice-minutes usage.', parameters: { type: 'object', properties: {} } },
  { name: 'compare_subscription_plans', description: 'List subscription plans with prices.', parameters: { type: 'object', properties: {} } },
  {
    name: 'upgrade_subscription',
    description: 'Start Stripe checkout to upgrade the subscription — hands off to the screen for payment. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { price_key: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['price_key'] },
  },
  { name: 'cancel_subscription', description: 'Opens the Stripe billing portal to cancel (no direct in-voice cancel exists).', parameters: { type: 'object', properties: {} } },
  {
    name: 'add_voice_minutes',
    description: 'Start Stripe checkout to buy a voice-minutes credit pack — hands off to the screen for payment. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { credit_pack: { type: 'string', description: 'starter, boost, or power. Required.' }, confirm: { type: 'boolean' } }, required: ['credit_pack'] },
  },
  { name: 'redeem_subscription_code', description: 'Redeem a subscription code to grant a plan directly.', parameters: { type: 'object', properties: { code: { type: 'string', description: 'Required.' } }, required: ['code'] } },
  { name: 'get_billing_history', description: 'Opens the Stripe billing portal, which shows invoice history (no in-voice invoice list exists).', parameters: { type: 'object', properties: {} } },
  { name: 'get_referral_link', description: 'Your referral link — generates one if you don\'t have one yet.', parameters: { type: 'object', properties: {} } },
  {
    name: 'invite_friend',
    description: 'Generate a shareable invite link (there is no automated email/SMS send yet — the user must share it themselves). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { confirm: { type: 'boolean' } } },
  },
  { name: 'get_referral_status', description: 'Who joined via your referral link and reward status.', parameters: { type: 'object', properties: {} } },
];
