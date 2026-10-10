/**
 * VTID-04933 — Commerce supplier review v1 (exafy_admin).
 *
 * The admin side of supplier onboarding: list the suppliers waiting for a
 * decision, look at one, then approve, ask for changes or reject — and hold or
 * release a single offering. Every lifecycle move goes through the lifecycle
 * graph (applyLifecycleMoves), never around it.
 *
 * Owner decisions (2026-10-07):
 * - For v1 an admin approval IS verification level 1 (no external business
 *   verification provider yet). It marks the verification step done and sets
 *   trust_level ≥ 1. It is not a go-live override: the org goes live only when
 *   every required checklist step is done; otherwise it stays in needs_action.
 *   Types that need level 2 (lab, practitioner_clinic) cannot be approved here.
 * - A supplier's draft offering never goes public at go-live without a
 *   decision the admin can take: "keep offline" switches it off on purpose,
 *   which the VTID-04769 product gate never undoes; "allow listing" is the
 *   explicit publication (on now if the org is live, otherwise with the org).
 */
import { emitOasisEvent } from './oasis-event-service';
import { fetchExcludedTestServiceAccountIds } from '../lib/excluded-test-service-accounts';
import { isLifecycleState, isPartnerType, type LifecycleState, type PartnerType } from './partner-lifecycle';
import { VERIFICATION_LEVEL_REQUIRED, evaluateVerification } from './partner-onboarding-checklist';
import { applyLifecycleMoves, type LifecycleMove, type ServiceResult } from './partner-onboarding-service';
import { loadChecklist, loadOrg, type OrgRow, type Supa } from '../routes/partner-onboarding';

/** States waiting for a review decision. */
export const REVIEWABLE_STATES: readonly LifecycleState[] = ['verifying', 'needs_action', 'exception'];
const LISTABLE_STATES: readonly LifecycleState[] = [
  'draft', 'submitted', 'verifying', 'needs_action', 'exception', 'live', 'paused', 'suspended', 'rejected',
];
export const MAX_REASON = 1000;
const SOURCE = 'admin-partner-review';

const fail = (status: number, body: Record<string, unknown>): ServiceResult => ({ status, body: { ok: false, ...body } });
const ok = (body: Record<string, unknown>): ServiceResult => ({ status: 200, body: { ok: true, ...body } });
const nowIso = () => new Date().toISOString();

/** Where an offering stands against the VTID-04769 go-live gate. */
export function listingState(p: { is_active: boolean | null; listing_hold?: string | null; first_listed_at?: string | null }):
  'live' | 'waiting_for_go_live' | 'held_excluded_account' | 'kept_offline' {
  if (p.is_active) return 'live';
  if (p.listing_hold === 'excluded_account') return 'held_excluded_account';
  if (p.listing_hold) return 'waiting_for_go_live';
  if (!p.first_listed_at) return 'waiting_for_go_live';
  return 'kept_offline';
}

export function cleanReason(input: unknown, required: boolean): { value: string | null; error: string | null } {
  if (input === undefined || input === null || input === '') {
    return required ? { value: null, error: 'reason is required' } : { value: null, error: null };
  }
  if (typeof input !== 'string') return { value: null, error: 'reason must be text' };
  const v = input.trim();
  if (required && !v) return { value: null, error: 'reason is required' };
  if (v.length > MAX_REASON) return { value: null, error: `reason is at most ${MAX_REASON} characters` };
  return { value: v || null, error: null };
}

async function orgMerchantIds(s: Supa, orgId: string): Promise<{ ids: string[]; error: string | null }> {
  const { data, error } = await s.from('merchants').select('id').eq('partner_organization_id', orgId);
  if (error) return { ids: [], error: error.message };
  return { ids: ((data ?? []) as Array<{ id: string }>).map((m) => m.id), error: null };
}

const reviewEvent = (
  type: 'partner_org.review.approved' | 'partner_org.review.changes_requested' | 'partner_org.review.rejected'
    | 'partner_org.review.product_kept_offline' | 'partner_org.review.product_listing_allowed',
  orgId: string,
  actorId: string | null,
  message: string,
  payload: Record<string, unknown>,
  status: 'success' | 'warning' | 'info' = 'success',
) =>
  emitOasisEvent({
    vtid: 'VTID-04933',
    type,
    source: SOURCE,
    status,
    message,
    payload: { partner_organization_id: orgId, ...payload },
    actor_id: actorId ?? undefined,
  });

/** GET / — suppliers by lifecycle state (default: the ones waiting for a decision). */
export async function listForReview(s: Supa, stateFilter?: string): Promise<ServiceResult> {
  let states: readonly LifecycleState[] = REVIEWABLE_STATES;
  if (stateFilter) {
    const asked = stateFilter.split(',').map((x) => x.trim()).filter(Boolean);
    if (!asked.every((x) => isLifecycleState(x) && LISTABLE_STATES.includes(x))) return fail(400, { error: 'INVALID_STATE' });
    states = asked as LifecycleState[];
  }
  const { data, error } = await s
    .from('partner_organizations')
    .select('id, org_key, display_name, legal_name, partner_type, country, website, lifecycle_state, status, trust_level, created_at, updated_at, owner_user_id')
    .in('lifecycle_state', [...states])
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) return fail(500, { error: error.message });
  // VTID-04971: review-sandbox suppliers (registered test accounts) are never a decision for staff.
  const excluded = await fetchExcludedTestServiceAccountIds(s as any);
  const rows = ((data ?? []) as Array<Record<string, any>>)
    .filter((r) => !excluded.has(String(r.owner_user_id)))
    .map(({ owner_user_id: _owner, ...rest }) => rest);

  const out = [];
  for (const row of rows) {
    const { org } = await loadOrg(s, row.id);
    const loaded = org ? await loadChecklist(s, org) : { checklist: null, error: null };
    const merchants = await orgMerchantIds(s, row.id);
    let productCount = 0;
    if (merchants.ids.length) {
      const { count } = await s.from('products').select('id', { count: 'exact', head: true }).in('merchant_id', merchants.ids);
      productCount = typeof count === 'number' ? count : 0;
    }
    const { data: terms } = await s
      .from('partner_terms_acceptances')
      .select('terms_version, accepted_at')
      .eq('partner_organization_id', row.id)
      .order('accepted_at', { ascending: false })
      .limit(1);
    const checklist = loaded.checklist;
    out.push({
      ...row,
      terms_accepted_version: ((terms ?? []) as Array<{ terms_version: string }>)[0]?.terms_version ?? null,
      product_count: productCount,
      open_steps: checklist ? checklist.steps.filter((st) => st.required && st.status !== 'done').map((st) => st.key) : [],
      verification_level_required: checklist?.verification_level_required ?? null,
    });
  }
  return ok({ states, organizations: out });
}

/** GET /:orgId — everything the reviewer needs for one supplier. */
export async function reviewDetail(s: Supa, orgId: string): Promise<ServiceResult> {
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  const loaded = await loadChecklist(s, org);
  if (loaded.error) return fail(500, { error: loaded.error });

  const merchants = await orgMerchantIds(s, orgId);
  if (merchants.error) return fail(500, { error: merchants.error });
  let products: Array<Record<string, unknown>> = [];
  if (merchants.ids.length) {
    const { data, error: pErr } = await s
      .from('products')
      .select('id, title, price_cents, currency, affiliate_url, is_active, listing_hold, first_listed_at, attributes, created_at')
      .in('merchant_id', merchants.ids)
      .order('created_at', { ascending: true });
    if (pErr) return fail(500, { error: pErr.message });
    products = ((data ?? []) as Array<Record<string, any>>).map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.attributes?.kind ?? 'product',
      price_cents: p.price_cents,
      currency: p.currency,
      url: p.affiliate_url,
      is_active: p.is_active,
      listing: listingState({ is_active: p.is_active ?? null, listing_hold: p.listing_hold, first_listed_at: p.first_listed_at }),
      admin_listing: p.attributes?.admin_listing ?? null,
    }));
  }
  const [{ data: terms }, { data: events }] = await Promise.all([
    s.from('partner_terms_acceptances').select('terms_version, content_sha256, shown_locale, accepted_at').eq('partner_organization_id', orgId)
      .order('accepted_at', { ascending: false }),
    s.from('oasis_events').select('topic, message, created_at').like('topic', 'partner_org.%').eq('metadata->>partner_organization_id', orgId)
      .order('created_at', { ascending: false }).limit(20),
  ]);
  const { owner_user_id: _owner, ...publicOrg } = org;
  return ok({
    organization: publicOrg,
    checklist: loaded.checklist,
    verification: loaded.checklist?.steps.find((st) => st.key === 'verification') ?? null,
    products,
    terms_acceptances: terms ?? [],
    events: events ?? [],
  });
}

function reviewableOrg(org: OrgRow | null): ServiceResult | null {
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  if (!isLifecycleState(org.lifecycle_state)) return fail(500, { error: `unknown lifecycle_state ${org.lifecycle_state}` });
  if (!REVIEWABLE_STATES.includes(org.lifecycle_state)) {
    return fail(409, { error: 'NOT_REVIEWABLE', lifecycle_state: org.lifecycle_state, reviewable_states: REVIEWABLE_STATES });
  }
  if (!isPartnerType(org.partner_type)) return fail(409, { error: 'PARTNER_TYPE_MISSING' });
  return null;
}

async function writeVerificationStep(s: Supa, orgId: string, status: string, detail: Record<string, unknown>, actorId: string | null) {
  const at = nowIso();
  return s.from('partner_onboarding_steps').upsert(
    { partner_organization_id: orgId, step_key: 'verification', status, detail, updated_by: actorId, updated_at: at },
    { onConflict: 'partner_organization_id,step_key' },
  );
}

const factsOf = (org: OrgRow) => ({ website: org.website, country: org.country, vat_id: org.vat_id });

/** POST /:orgId/approve — verification level 1; live only if every required step is done. */
export async function approve(s: Supa, actorId: string | null, orgId: string, noteInput: unknown): Promise<ServiceResult> {
  const note = cleanReason(noteInput, false);
  if (note.error) return fail(400, { error: 'invalid_note', message: note.error });
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  const bad = reviewableOrg(org);
  if (bad) return bad;
  const o = org as OrgRow;
  const type = o.partner_type as PartnerType;
  if (VERIFICATION_LEVEL_REQUIRED[type] > 1) {
    return fail(409, { error: 'LEVEL_2_REQUIRED', partner_type: type, message: 'An admin approval grants verification level 1; this business type needs level 2.' });
  }

  const at = nowIso();
  const { error: stepErr } = await writeVerificationStep(s, orgId, 'done', {
    method: 'admin_approval', level: 1, approved_by: actorId, approved_at: at, note: note.value, facts: factsOf(o),
  }, actorId);
  if (stepErr) return fail(500, { error: stepErr.message });
  if ((o.trust_level ?? 0) < 1) {
    const { error: tErr } = await s.from('partner_organizations').update({ trust_level: 1, updated_at: at }).eq('id', orgId);
    if (tErr) return fail(500, { error: tErr.message });
  }

  const loaded = await loadChecklist(s, { ...o, trust_level: Math.max(o.trust_level ?? 0, 1) });
  if (loaded.error || !loaded.checklist) return fail(500, { error: loaded.error ?? 'checklist unavailable' });
  const verdict = evaluateVerification(loaded.checklist);
  const from = o.lifecycle_state as LifecycleState;
  let moves: LifecycleMove[];
  if (verdict.outcome === 'live') {
    moves = from === 'needs_action'
      ? [{ from: 'needs_action', to: 'verifying' }, { from: 'verifying', to: 'live' }]
      : [{ from, to: 'live' }];
  } else {
    moves = from === 'needs_action' ? [] : [{ from, to: 'needs_action' }];
  }
  const moved = await applyLifecycleMoves(s, orgId, moves, {
    actorId, source: SOURCE, partnerType: type, reason: 'admin_approval',
    payloadFor: (m) => (m.to === 'needs_action' ? { open_steps: verdict.open_steps } : {}),
  });
  if (moved.failure) return moved.failure;

  await reviewEvent('partner_org.review.approved', orgId, actorId,
    `Partner organization ${o.display_name} approved (verification level 1) by exafy_admin; outcome ${verdict.outcome}.`,
    { level: 1, outcome: verdict.outcome, open_steps: verdict.open_steps, note: note.value });
  return ok({
    lifecycle_state: moved.applied.length ? moved.applied[moved.applied.length - 1].to : from,
    outcome: verdict.outcome,
    open_steps: verdict.open_steps,
    transitions: moved.applied,
  });
}

/** POST /:orgId/request-changes — back to the supplier with a reason; voids an earlier approval. */
export async function requestChanges(s: Supa, actorId: string | null, orgId: string, reasonInput: unknown): Promise<ServiceResult> {
  const reason = cleanReason(reasonInput, true);
  if (reason.error) return fail(400, { error: 'invalid_reason', message: reason.error });
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  const bad = reviewableOrg(org);
  if (bad) return bad;
  const o = org as OrgRow;

  const { data: prev } = await s.from('partner_onboarding_steps').select('status, detail')
    .eq('partner_organization_id', orgId).eq('step_key', 'verification').maybeSingle();
  const prevDetail = ((prev as { detail?: Record<string, unknown> } | null)?.detail ?? {}) as Record<string, unknown>;
  const voidedApproval = prevDetail.method === 'admin_approval';

  const at = nowIso();
  const { error: stepErr } = await writeVerificationStep(s, orgId, 'todo', {
    review_note: { reason: reason.value, requested_by: actorId, requested_at: at },
    facts: factsOf(o),
    ...(voidedApproval ? { voided_approval: { approved_by: prevDetail.approved_by ?? null, approved_at: prevDetail.approved_at ?? null } } : {}),
  }, actorId);
  if (stepErr) return fail(500, { error: stepErr.message });
  if (voidedApproval && (o.trust_level ?? 0) !== 0) {
    // The automatic check cannot reach level 1 today (no business-verification provider).
    const { error: tErr } = await s.from('partner_organizations').update({ trust_level: 0, updated_at: at }).eq('id', orgId);
    if (tErr) return fail(500, { error: tErr.message });
  }

  const from = o.lifecycle_state as LifecycleState;
  const moves: LifecycleMove[] = from === 'needs_action' ? [] : [{ from, to: 'needs_action' }];
  const moved = await applyLifecycleMoves(s, orgId, moves, {
    actorId, source: SOURCE, partnerType: o.partner_type as PartnerType, reason: 'admin_changes_requested',
  });
  if (moved.failure) return moved.failure;
  await reviewEvent('partner_org.review.changes_requested', orgId, actorId,
    `Changes requested from partner organization ${o.display_name}.`,
    { reason: reason.value, voided_approval: voidedApproval }, 'warning');
  return ok({ lifecycle_state: 'needs_action', transitions: moved.applied, voided_approval: voidedApproval });
}

/** POST /:orgId/reject — terminal. */
export async function rejectOrg(s: Supa, actorId: string | null, orgId: string, reasonInput: unknown): Promise<ServiceResult> {
  const reason = cleanReason(reasonInput, true);
  if (reason.error) return fail(400, { error: 'invalid_reason', message: reason.error });
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  const bad = reviewableOrg(org);
  if (bad) return bad;
  const o = org as OrgRow;

  const at = nowIso();
  const { error: stepErr } = await writeVerificationStep(s, orgId, 'failed', {
    rejected: { reason: reason.value, rejected_by: actorId, rejected_at: at },
    facts: factsOf(o),
  }, actorId);
  if (stepErr) return fail(500, { error: stepErr.message });
  const moved = await applyLifecycleMoves(s, orgId, [{ from: o.lifecycle_state as LifecycleState, to: 'rejected' }], {
    actorId, source: SOURCE, partnerType: o.partner_type as PartnerType, reason: 'admin_rejected',
  });
  if (moved.failure) return moved.failure;
  await reviewEvent('partner_org.review.rejected', orgId, actorId,
    `Partner organization ${o.display_name} rejected by exafy_admin.`, { reason: reason.value }, 'warning');
  return ok({ lifecycle_state: 'rejected', transitions: moved.applied });
}

/** POST /:orgId/products/:productId/{keep-offline|allow-listing}. */
export async function setOfferingListing(
  s: Supa,
  actorId: string | null,
  orgId: string,
  productId: string,
  decision: 'kept_offline' | 'allowed',
  reasonInput: unknown,
): Promise<ServiceResult> {
  const reason = cleanReason(reasonInput, decision === 'kept_offline');
  if (reason.error) return fail(400, { error: 'invalid_reason', message: reason.error });
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  const merchants = await orgMerchantIds(s, orgId);
  if (merchants.error) return fail(500, { error: merchants.error });
  if (!merchants.ids.length) return fail(404, { error: 'PRODUCT_NOT_FOUND' });

  const { data: cur, error: curErr } = await s.from('products').select('id, merchant_id, attributes')
    .eq('id', productId).in('merchant_id', merchants.ids).maybeSingle();
  if (curErr) return fail(500, { error: curErr.message });
  if (!cur) return fail(404, { error: 'PRODUCT_NOT_FOUND' });
  const attrs = ((cur as { attributes?: Record<string, unknown> | null }).attributes ?? {}) as Record<string, unknown>;

  const at = nowIso();
  // The VTID-04769 product gate (trg_products_supplier_gate) reads this write:
  // is_active=false is "switched off on purpose, never brought back"; is_active=true
  // is on now when the org is eligible, otherwise held and on with the org.
  const { data: updated, error: upErr } = await s
    .from('products')
    .update({
      is_active: decision === 'allowed',
      attributes: { ...attrs, admin_listing: { decision, reason: reason.value, decided_by: actorId, decided_at: at } },
    })
    .eq('id', productId)
    .eq('merchant_id', (cur as { merchant_id: string }).merchant_id)
    .select('id, title, is_active, listing_hold, first_listed_at')
    .maybeSingle();
  if (upErr) return fail(500, { error: upErr.message });
  if (!updated) return fail(404, { error: 'PRODUCT_NOT_FOUND' });
  const p = updated as { id: string; title: string; is_active: boolean; listing_hold: string | null; first_listed_at: string | null };
  const listing = listingState(p);

  await reviewEvent(
    decision === 'allowed' ? 'partner_org.review.product_listing_allowed' : 'partner_org.review.product_kept_offline',
    orgId, actorId,
    decision === 'allowed'
      ? `Offering "${p.title}" of ${org.display_name} allowed to list (now: ${listing}).`
      : `Offering "${p.title}" of ${org.display_name} kept offline by exafy_admin.`,
    { product_id: p.id, decision, listing, reason: reason.value },
    decision === 'allowed' ? 'success' : 'info',
  );
  return ok({ product: { id: p.id, title: p.title, is_active: p.is_active, listing } });
}
