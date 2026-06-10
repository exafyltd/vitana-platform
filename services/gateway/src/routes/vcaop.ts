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

  let total = 0;
  const earnings: any[] = [];
  for (const m of merchants) {
    const mtotal = (m.items || []).reduce((s, i) => s + Number(i.qty) * Number(i.price), 0);
    total += mtotal;
    const subId = m.affiliateProgramId ? subIdFor(uid, m.affiliateProgramId) : null;
    const routeId = randomUUID();
    await supabase.from('merchant_route').insert({
      id: routeId, cart_order_id: cartId, merchant: m.merchant, checkout_connector: m.checkoutConnector || 'ucp',
      affiliate_program_id: m.affiliateProgramId || null, sub_id: subId, line_items: m.items, status: 'routed', created_at: now, updated_at: now,
    });
    if (m.affiliateProgramId && subId) {
      const rate = typeof m.commissionRate === 'number' ? m.commissionRate : 0.05;
      const gross = +(mtotal * rate).toFixed(4);
      const reward = +(gross * 0.5).toFixed(4);
      const commissionId = randomUUID();
      await supabase.from('commission_event').insert({
        id: commissionId, affiliate_program_id: m.affiliateProgramId, sub_id: subId, user_id: uid, merchant: m.merchant,
        order_ref: routeId, gross_commission: gross, currency: 'EUR', status: 'pending', created_at: now, updated_at: now,
      });
      await supabase.from('rewards_ledger').insert({
        id: randomUUID(), user_id: uid, commission_event_id: commissionId, amount: reward, currency: 'EUR', state: 'pending', created_at: now, updated_at: now,
      });
      earnings.push({ merchant: m.merchant, affiliateProgramId: m.affiliateProgramId, subId, commissionId, projectedReward: reward });
    }
  }
  await supabase.from('cart_order').update({ status: 'routed', total_amount: +total.toFixed(2), updated_at: now }).eq('id', cartId);
  await emitEvent(supabase, 'vcaop.commerce.shopped', 'success', `shop routed ${merchants.length} merchant(s)`, { cartOrderId: cartId, userId: uid });

  res.status(201).json({ ok: true, data: { cartOrderId: cartId, total: +total.toFixed(2), disclosure: { text: FTC_DISCLOSURE, dismissible: false }, earnings, totalProjectedReward: +earnings.reduce((s, e) => s + e.projectedReward, 0).toFixed(4) } });
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
  let ids: string[] = Array.isArray(req.body?.providerIds) ? req.body.providerIds : [];
  if (ids.length === 0) {
    const { data } = await supabase.from('provider').select('id');
    ids = (data || []).map((p: any) => p.id);
  }
  const now = new Date().toISOString();
  let queued = 0, humanTasks = 0;
  for (const pid of ids) {
    const { data: prov } = await supabase.from('provider').select('id,connector_mode,kyb_required').eq('id', pid).maybeSingle();
    if (!prov) continue;
    const accountId = randomUUID();
    await supabase.from('provider_account').insert({ id: accountId, tenant_id: tenant, provider_id: pid, status: 'discovered', created_at: now, updated_at: now });
    const jobId = randomUUID();
    await supabase.from('provisioning_job').insert({ id: jobId, tenant_id: tenant, provider_account_id: accountId, status: 'queued', connector_tier: prov.connector_mode, created_at: now, updated_at: now });
    const tasks: { type: string }[] = [{ type: 'IRREVERSIBLE_SUBMIT' }];
    if (prov.kyb_required) tasks.unshift({ type: 'KYB' });
    for (const t of tasks) {
      await supabase.from('human_task').insert({
        id: randomUUID(), tenant_id: tenant, type: t.type, provider_id: pid, job_id: jobId, status: 'open',
        payload: { provider_id: pid, business_identity_ref: `business_identity:${tenant}`, fields_to_complete: ['legal_name', 'entity_type', 'registration_no'] },
        created_at: now, updated_at: now,
      });
      humanTasks++;
    }
    queued++;
  }
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
