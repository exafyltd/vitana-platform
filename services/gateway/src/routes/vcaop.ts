/**
 * VCAOP API — Vitanaland Commerce & Account-Operations Platform (gateway surface).
 *
 * Self-contained route over the live VCAOP Supabase tables (provider,
 * affiliate_program, cart_order, merchant_route, disclosure, commission_event,
 * rewards_ledger, provider_account, provisioning_job, human_task). The heavy
 * agent/guardrail logic lives in services/vcaop (used by workers/CI); this exposes
 * the read/write surface the community + admin apps need so users can shop, earn,
 * and staff can run onboarding.
 *
 * Roles: any authenticated user = community (own data only). exafy_admin = staff/admin
 * (back office). Service-role client bypasses RLS, so ownership/role is enforced here.
 */
import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { requireAuth } from '../middleware/auth-supabase-jwt';

const router = Router();
router.use(requireAuth as any);

const FTC_DISCLOSURE =
  'Vitanaland earns a commission on qualifying purchases made through these links, which funds your stacked savings. This does not change the price you pay.';

function subIdFor(userId: string, programId: string): string {
  return 'sub_' + createHash('sha256').update(`${userId}:${programId}`).digest('hex').slice(0, 16);
}
function db(res: Response) {
  const s = getSupabase();
  if (!s) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
    return null;
  }
  return s;
}
function isAdmin(req: Request): boolean {
  return Boolean((req as any).identity?.exafy_admin);
}
function userId(req: Request): string {
  return String((req as any).identity?.user_id || '');
}
function tenantId(req: Request): string {
  return String((req as any).identity?.tenant_id || 'platform');
}
async function emitEvent(supabase: any, type: string, status: string, message: string, payload: Record<string, unknown>) {
  try {
    await supabase.from('oasis_events').insert({
      id: randomUUID(), service: 'vcaop', source: 'vcaop', type, topic: type, status, message,
      metadata: payload, created_at: new Date().toISOString(),
    });
  } catch { /* never block the request on the audit write */ }
}

// ===== Catalog (any authenticated user) =====
router.get('/providers', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  let q = supabase.from('provider').select('id,name,category,connector_mode,kyb_required').order('category');
  if (req.query.category) q = q.eq('category', String(req.query.category));
  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, data });
});

router.get('/affiliate-programs', async (_req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const { data, error } = await supabase.from('affiliate_program').select('id,network,merchant,source,affiliate_cashback_allowed').order('id');
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, data });
});

// ===== Shop → route → earn (community) =====
interface ShopItem { sku: string; qty: number; price: number }
interface ShopMerchant { merchant: string; items: ShopItem[]; affiliateProgramId?: string; checkoutConnector?: string; commissionRate?: number }

router.post('/shop', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const uid = userId(req);
  const merchants: ShopMerchant[] = Array.isArray(req.body?.merchants) ? req.body.merchants : [];
  if (merchants.length === 0) return res.status(400).json({ ok: false, error: 'merchants[] required' });

  const cartId = randomUUID();
  const now = new Date().toISOString();
  await supabase.from('cart_order').insert({ id: cartId, user_id: uid, status: 'open', currency: 'EUR', created_at: now, updated_at: now });
  const disclosureId = randomUUID();
  await supabase.from('disclosure').insert({ id: disclosureId, cart_order_id: cartId, kind: 'ftc_affiliate', text: FTC_DISCLOSURE, dismissible: false, shown_at: now, created_at: now });

  // Build all rows first, then insert per-table batches (3 round-trips total
  // instead of up to 3 per merchant). Insert order respects FK dependencies:
  // merchant_route → commission_event → rewards_ledger.
  let total = 0;
  const earnings: any[] = [];
  const routeRows: any[] = [];
  const commissionRows: any[] = [];
  const rewardRows: any[] = [];
  for (const m of merchants) {
    const mtotal = (m.items || []).reduce((s, i) => s + Number(i.qty) * Number(i.price), 0);
    total += mtotal;
    const subId = m.affiliateProgramId ? subIdFor(uid, m.affiliateProgramId) : null;
    const routeId = randomUUID();
    routeRows.push({
      id: routeId, cart_order_id: cartId, merchant: m.merchant, checkout_connector: m.checkoutConnector || 'ucp',
      affiliate_program_id: m.affiliateProgramId || null, sub_id: subId, line_items: m.items, status: 'routed', created_at: now, updated_at: now,
    });
    if (m.affiliateProgramId && subId) {
      const rate = typeof m.commissionRate === 'number' ? m.commissionRate : 0.05;
      const gross = +(mtotal * rate).toFixed(4);
      const reward = +(gross * 0.5).toFixed(4);
      const commissionId = randomUUID();
      commissionRows.push({
        id: commissionId, affiliate_program_id: m.affiliateProgramId, sub_id: subId, user_id: uid, merchant: m.merchant,
        order_ref: routeId, gross_commission: gross, currency: 'EUR', status: 'pending', created_at: now, updated_at: now,
      });
      rewardRows.push({
        id: randomUUID(), user_id: uid, commission_event_id: commissionId, amount: reward, currency: 'EUR', state: 'pending', created_at: now, updated_at: now,
      });
      earnings.push({ merchant: m.merchant, affiliateProgramId: m.affiliateProgramId, subId, commissionId, projectedReward: reward });
    }
  }
  await supabase.from('merchant_route').insert(routeRows);
  if (commissionRows.length > 0) await supabase.from('commission_event').insert(commissionRows);
  if (rewardRows.length > 0) await supabase.from('rewards_ledger').insert(rewardRows);
  await supabase.from('cart_order').update({ status: 'routed', total_amount: +total.toFixed(2), updated_at: now }).eq('id', cartId);
  await emitEvent(supabase, 'vcaop.commerce.shopped', 'success', `shop routed ${merchants.length} merchant(s)`, { cartOrderId: cartId, userId: uid });

  res.status(201).json({ ok: true, data: { cartOrderId: cartId, total: +total.toFixed(2), disclosure: { text: FTC_DISCLOSURE, dismissible: false }, earnings, totalProjectedReward: +earnings.reduce((s, e) => s + e.projectedReward, 0).toFixed(4) } });
});

// ===== Per-user affiliate deeplink (community) =====
// Builds the member's tracked link for a program and records the subid->member
// mapping so the public postback can attribute the conversion back. The rewards
// badge is shown only when the program allows cashback (Amazon = false).
router.post('/affiliate-link', async (req: Request, res: Response) => {
  // impact-allow-no-oasis: link issuance is not a lifecycle state transition; the
  // OASIS-worthy reward events are emitted by the postback handler instead.
  const supabase = db(res); if (!supabase) return;
  const uid = userId(req);
  const tenant = tenantId(req);
  const programId = String(req.body?.affiliateProgramId || '').trim();
  const productUrl = String(req.body?.productUrl || '').trim();
  if (!programId) return res.status(400).json({ ok: false, error: 'affiliateProgramId required' });

  const { data: prog } = await supabase
    .from('affiliate_program')
    .select('id,network,policy,affiliate_cashback_allowed')
    .eq('id', programId).maybeSingle();
  if (!prog) return res.status(404).json({ ok: false, error: 'program not found' });

  const subId = subIdFor(uid, programId);
  const now = new Date().toISOString();
  // Reverse-attribution map (idempotent): postback resolves subId -> this member.
  await supabase.from('subid_map').upsert({
    sub_id: subId, user_id: uid, tenant_id: tenant, affiliate_program_id: programId,
    network: prog.network, updated_at: now,
  }, { onConflict: 'sub_id' });

  // Decorate the program gotolink with our subid (+ optional product deeplink).
  const policy = (prog.policy || {}) as Record<string, unknown>;
  const gotolink = String(policy.gotolink || '');
  let link = '';
  if (gotolink) {
    try {
      const u = new URL(gotolink);
      u.searchParams.set(String(policy.subid_param || 'subid'), subId);
      if (productUrl) u.searchParams.set(String(policy.deeplink_param || 'ulp'), productUrl);
      link = u.toString();
    } catch { link = ''; }
  }
  const rewardsEnabled = prog.affiliate_cashback_allowed === true;
  res.json({
    ok: true,
    data: { affiliateProgramId: programId, network: prog.network, subId, link, rewardsEnabled,
      disclosure: { text: FTC_DISCLOSURE, dismissible: false } },
  });
});

// ===== Wallet (community: own only) =====
router.get('/wallet', async (req: Request, res: Response) => {
  const supabase = db(res); if (!supabase) return;
  const uid = userId(req);
  const { data, error } = await supabase.from('rewards_ledger').select('id,amount,state,currency').eq('user_id', uid);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  const balance = (data || []).filter((r: any) => r.state === 'confirmed' || r.state === 'redeemable').reduce((s: number, r: any) => s + Number(r.amount), 0);
  res.json({ ok: true, data: { balance: +balance.toFixed(4), entries: data } });
});

// ===== Commissions queue (admin) =====
router.get('/commissions', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const supabase = db(res); if (!supabase) return;
  let q = supabase.from('commission_event')
    .select('id,merchant,user_id,sub_id,gross_commission,currency,status,postback_ref,created_at')
    .order('created_at', { ascending: false }).limit(200);
  if (req.query.status) q = q.eq('status', String(req.query.status));
  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, data });
});

// ===== Confirm / reverse a commission (admin/system) =====
router.post('/commissions/:id/confirm', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const supabase = db(res); if (!supabase) return;
  const postbackRef = String(req.body?.postbackRef || '');
  if (!postbackRef) return res.status(400).json({ ok: false, error: 'postbackRef required' });
  const { data: c } = await supabase.from('commission_event').select('id,status').eq('id', req.params.id).maybeSingle();
  if (!c) return res.status(404).json({ ok: false, error: 'commission not found' });
  if (c.status !== 'pending') return res.status(409).json({ ok: false, error: `commission is '${c.status}', not pending` });
  const now = new Date().toISOString();
  await supabase.from('commission_event').update({ status: 'confirmed', postback_ref: postbackRef, updated_at: now }).eq('id', req.params.id);
  await supabase.from('rewards_ledger').update({ state: 'confirmed', updated_at: now }).eq('commission_event_id', req.params.id);
  await emitEvent(supabase, 'vcaop.reward.confirmed', 'success', 'commission confirmed', { commissionId: req.params.id });
  res.json({ ok: true });
});

router.post('/commissions/:id/reverse', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const supabase = db(res); if (!supabase) return;
  const now = new Date().toISOString();
  await supabase.from('commission_event').update({ status: 'reversed', updated_at: now }).eq('id', req.params.id);
  await supabase.from('rewards_ledger').update({ state: 'reversed', updated_at: now }).eq('commission_event_id', req.params.id);
  await emitEvent(supabase, 'vcaop.reward.reversed', 'warning', 'commission reversed', { commissionId: req.params.id });
  res.json({ ok: true });
});

// ===== Onboarding (admin) =====
router.get('/onboarding/inbox', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const supabase = db(res); if (!supabase) return;
  const { data, error } = await supabase.from('human_task').select('id,type,status,provider_id,job_id,payload,created_at').in('status', ['open', 'in_progress']).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, data });
});

router.post('/onboarding/batch', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const supabase = db(res); if (!supabase) return;
  const tenant = tenantId(req);
  const ids: string[] = Array.isArray(req.body?.providerIds) ? req.body.providerIds : [];
  // One query for all requested providers (previously one select per id),
  // then per-table batch inserts in FK order: provider_account →
  // provisioning_job → human_task.
  let providersQuery = supabase.from('provider').select('id,connector_mode,kyb_required');
  if (ids.length > 0) providersQuery = providersQuery.in('id', ids);
  const { data: provRows } = await providersQuery;
  const now = new Date().toISOString();
  let queued = 0, humanTasks = 0;
  const accountRows: any[] = [];
  const jobRows: any[] = [];
  const taskRows: any[] = [];
  for (const prov of provRows || []) {
    const pid = prov.id;
    const accountId = randomUUID();
    accountRows.push({ id: accountId, tenant_id: tenant, provider_id: pid, status: 'discovered', created_at: now, updated_at: now });
    const jobId = randomUUID();
    jobRows.push({ id: jobId, tenant_id: tenant, provider_account_id: accountId, status: 'queued', connector_tier: prov.connector_mode, created_at: now, updated_at: now });
    const tasks: { type: string }[] = [{ type: 'IRREVERSIBLE_SUBMIT' }];
    if (prov.kyb_required) tasks.unshift({ type: 'KYB' });
    for (const t of tasks) {
      taskRows.push({
        id: randomUUID(), tenant_id: tenant, type: t.type, provider_id: pid, job_id: jobId, status: 'open',
        payload: { provider_id: pid, business_identity_ref: `business_identity:${tenant}`, fields_to_complete: ['legal_name', 'entity_type', 'registration_no'] },
        created_at: now, updated_at: now,
      });
      humanTasks++;
    }
    queued++;
  }
  if (accountRows.length > 0) await supabase.from('provider_account').insert(accountRows);
  if (jobRows.length > 0) await supabase.from('provisioning_job').insert(jobRows);
  if (taskRows.length > 0) await supabase.from('human_task').insert(taskRows);
  await emitEvent(supabase, 'vcaop.onboarding.batch_kickoff', 'success', `batch onboard: ${queued} queued`, { tenant, queued, humanTasks });
  res.status(201).json({ ok: true, data: { queued, humanTasksCreated: humanTasks } });
});

router.post('/tasks/:id/complete', async (req: Request, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const supabase = db(res); if (!supabase) return;
  const { data: task } = await supabase.from('human_task').select('id,type,job_id').eq('id', req.params.id).maybeSingle();
  if (!task) return res.status(404).json({ ok: false, error: 'task not found' });
  const now = new Date().toISOString();
  await supabase.from('human_task').update({ status: 'completed', updated_at: now }).eq('id', req.params.id);
  if (task.job_id) await supabase.from('provisioning_job').update({ status: 'running', updated_at: now }).eq('id', task.job_id);
  await emitEvent(supabase, 'vcaop.human_task.completed', 'success', `task ${req.params.id} completed`, { taskId: req.params.id, type: task.type });
  res.json({ ok: true });
});

export default router;
