/**
 * VTID-04847 — partner onboarding writes as shared service functions.
 *
 * Starting onboarding, updating the company facts, submitting for
 * verification, listing the catalogue and changing a product used to live
 * only inside the route handlers (routes/partner-onboarding.ts,
 * routes/partner-onboarding-catalogue.ts). The Commerce MCP endpoint lets a
 * supplier's AI assistant do the same setup on their behalf, so the rules are
 * here once and both the routes and MCP call them: the same validation, the
 * same lifecycle guards, the same OASIS events. Nothing is written to the
 * database from MCP directly.
 *
 * Every function takes the service-role client plus an already-authenticated
 * caller id. Authorization is part of each function (org_admin of the org, or
 * an exafy_admin), so a caller cannot skip it.
 *
 * Results are { status, body } with the routes' own HTTP status and JSON body,
 * so the routes answer exactly as before.
 */
import { randomBytes, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { isSandboxAccount } from './sandbox-accounts';
import {
  PARTNER_TYPES,
  canTransition,
  isLifecycleState,
  isPartnerType,
  parseCompanyFacts,
  type LifecycleState,
  type PartnerType,
} from './partner-lifecycle';
import { VERIFICATION_LEVEL_REQUIRED, evaluateVerification, submitTransitions, verificationIsStale, type Checklist } from './partner-onboarding-checklist';
import {
  computeVerification,
  domainProofInstructions,
  domainsMatch,
  emailDomainOf,
  hostOf,
  htmlContainsMetaToken,
  isEuCountry,
  normalizeVatNumber,
  txtRecordsContainToken,
  type CheckStatus,
  type VerificationChecks,
} from './partner-verification';
import { checkVatVies, fetchSiteHtml, lookupDomainProofTxt, readEmailConfirmation } from './partner-verification-io';
import { assertPublicHost, detectPlatform } from './platform-detect';
import { PRODUCT_FIELDS, catalogueEvent, findOrgMerchant, syncCatalogueStep } from './partner-setup';
import { isPartnerTriageOn, runPartnerTriage } from './jev/gates/partner-triage-gate';
import { loadChecklist, loadOrg, makeOrgKey, type OrgRow, type Supa } from '../routes/partner-onboarding';
import { ProductPatchSchema, SHIPS_SOMEWHERE_MESSAGE, shipsSomewhere } from '../routes/vcaop-portal-my-products';
import { insertConnection } from '../routes/vcaop-portal-my';
import {
  CONNECTIONS_LOCKED_STATES,
  CONNECTOR_TOKEN,
  listOrgConnections,
  refreshMappingStep,
} from '../routes/partner-onboarding-connections';

export interface ServiceResult {
  status: number;
  body: Record<string, unknown>;
}

export interface Caller {
  userId: string;
  /** exafy_admin may act on any org (support). */
  exafyAdmin?: boolean;
  /**
   * Set only by the HTTP routes, after their requireOrgAdmin() middleware has
   * already checked this caller for this org, so the check is not run twice.
   * Every other caller (MCP) is checked here.
   */
  orgAdminChecked?: boolean;
  email?: string | null;
  tenantId?: string | null;
}

/** States in which the partner may still edit the company facts. */
export const COMPANY_EDITABLE_STATES: readonly LifecycleState[] = ['draft', 'needs_action'];
/** Lifecycle states in which the catalogue can no longer be edited. */
export const CATALOGUE_LOCKED_STATES: readonly string[] = ['rejected', 'suspended'];

const fail = (status: number, body: Record<string, unknown>): ServiceResult => ({ status, body: { ok: false, ...body } });

/** org_admin of this org, or a global exafy_admin. */
export async function callerIsOrgAdmin(s: Supa, callerId: string, orgId: string): Promise<boolean> {
  const { data, error } = await s
    .from('partner_organization_members')
    .select('role')
    .eq('partner_organization_id', orgId)
    .eq('user_id', callerId)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { role: string }).role === 'org_admin';
}

async function authorize(s: Supa, caller: Caller, orgId: string): Promise<ServiceResult | null> {
  if (caller.exafyAdmin || caller.orgAdminChecked) return null;
  if (await callerIsOrgAdmin(s, caller.userId, orgId)) return null;
  return fail(403, {
    error: 'NOT_ORG_ADMIN',
    message: "Only this organization's own org_admin (or an exafy_admin) can perform this action.",
  });
}

function publicOrg(org: OrgRow) {
  const { owner_user_id: _owner, ...rest } = org;
  return rest;
}

/** The org and its checklist, as the routes answer it. */
export async function orgState(s: Supa, orgId: string, status = 200, extra: Record<string, unknown> = {}): Promise<ServiceResult> {
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  const loaded = await loadChecklist(s, org);
  if (loaded.error) return fail(500, { error: loaded.error });
  return { status, body: { ok: true, organization: publicOrg(org), checklist: loaded.checklist, ...extra } };
}

/** The organizations the caller belongs to (any role). */
export async function listMyOrgs(
  s: Supa,
  caller: Caller,
): Promise<ServiceResult> {
  const { data, error } = await s
    .from('partner_organization_members')
    .select('role, partner_organization_id, partner_organizations(id, display_name, partner_type, lifecycle_state, commerce_vertical, created_at)')
    .eq('user_id', caller.userId)
    .limit(20);
  if (error) return fail(500, { error: error.message });
  const organizations = ((data ?? []) as Array<Record<string, any>>).map((m) => ({
    ...(m.partner_organizations ?? { id: m.partner_organization_id }),
    role: m.role,
  }));
  return { status: 200, body: { ok: true, organizations } };
}

/** Status of one org (org_admin only). */
export async function getOnboardingStatus(s: Supa, caller: Caller, orgId: string): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  return orgState(s, orgId);
}

/** Start onboarding: a draft org with the caller as org_admin. Idempotent per user + type while a draft. */
export async function startOnboarding(
  s: Supa,
  caller: Caller,
  input: { partner_type?: unknown; display_name?: unknown },
  meta: { source?: string } = {},
): Promise<ServiceResult> {
  // The account step is "a signed-in user with an email address".
  if (!caller.email) return fail(403, { error: 'ACCOUNT_EMAIL_REQUIRED' });
  const partnerType = input.partner_type;
  if (!isPartnerType(partnerType)) {
    return fail(400, { error: `partner_type must be one of: ${PARTNER_TYPES.join(', ')}` });
  }
  const displayName = typeof input.display_name === 'string' ? input.display_name.trim() : '';
  if (!displayName || displayName.length > 200) {
    return fail(400, { error: 'display_name is required (at most 200 characters)' });
  }

  const existing = await s
    .from('partner_organizations')
    .select('id')
    .eq('owner_user_id', caller.userId)
    .eq('partner_type', partnerType)
    .eq('lifecycle_state', 'draft')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing.error) return fail(500, { error: existing.error.message });
  if (existing.data) return orgState(s, (existing.data as { id: string }).id, 200, { created: false });

  let orgId: string | null = null;
  for (let attempt = 0; attempt < 2 && !orgId; attempt++) {
    const { data, error } = await s
      .from('partner_organizations')
      .insert({
        org_key: makeOrgKey(displayName),
        display_name: displayName,
        org_type: partnerType,
        partner_type: partnerType,
        lifecycle_state: 'draft',
        owner_user_id: caller.userId,
        business_details: {},
      })
      .select('id')
      .single();
    if (data) orgId = (data as { id: string }).id;
    else if (error?.code !== '23505') return fail(500, { error: error?.message ?? 'partner_organizations insert failed' });
  }
  if (!orgId) return fail(500, { error: 'ORG_KEY_COLLISION' });

  const { error: memberErr } = await s
    .from('partner_organization_members')
    .insert({ partner_organization_id: orgId, user_id: caller.userId, role: 'org_admin', granted_by: caller.userId });
  if (memberErr) return fail(500, { error: memberErr.message });

  await emitOasisEvent({
    vtid: 'VTID-04478',
    type: 'partner_org.onboarding_started',
    source: meta.source ?? 'partner-onboarding',
    status: 'success',
    message: `Partner onboarding started for "${displayName}" (${partnerType}).`,
    payload: { partner_organization_id: orgId, partner_type: partnerType },
    actor_id: caller.userId,
  });
  return orgState(s, orgId, 201, { created: true });
}

/** Whether a company-fact change would void a verification that already passed. */
export function changeVoidsVerification(checklist: Checklist | null, fields: string[]): boolean {
  const verification = checklist?.steps.find((step) => step.key === 'verification');
  return verification?.status === 'done' && fields.some((f) => ['website', 'country', 'vat_id'].includes(f));
}

/** Update the company facts (draft / needs_action only). */
export async function updateCompany(
  s: Supa,
  caller: Caller,
  orgId: string,
  input: unknown,
  meta: { source?: string } = {},
): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  // Changing verified facts on a submitted or live org needs a re-verification
  // flow, which does not exist yet.
  if (!COMPANY_EDITABLE_STATES.includes(org.lifecycle_state as LifecycleState)) {
    return fail(409, { error: 'COMPANY_LOCKED', lifecycle_state: org.lifecycle_state });
  }
  const parsed = parseCompanyFacts(input);
  if (!parsed.ok) return fail(400, { error: parsed.error });
  if (Object.keys(parsed.facts).length === 0) {
    return fail(400, { error: 'at least one of legal_name, country, vat_id, website is required' });
  }
  // VTID-04941: defence in depth. parseCompanyFacts only checks the website is
  // a well-formed http(s) URL; refuse one that points at an internal address
  // here, so it is never stored. The fetch-time guard stays authoritative.
  if (parsed.facts.website) {
    const blocked = await websiteIsInternal(parsed.facts.website);
    if (blocked) return fail(400, { error: 'website must be a public internet address' });
  }

  const { error: updErr } = await s
    .from('partner_organizations')
    .update({ ...parsed.facts, updated_at: new Date().toISOString() })
    .eq('id', orgId);
  if (updErr) return fail(500, { error: updErr.message });

  await emitOasisEvent({
    vtid: 'VTID-04478',
    type: 'partner_org.company_updated',
    source: meta.source ?? 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId} updated its company facts.`,
    // Field names only: the values (VAT id, legal name) stay in the org row.
    payload: { partner_organization_id: orgId, fields: Object.keys(parsed.facts) },
    actor_id: caller.userId,
  });
  return orgState(s, orgId);
}

/**
 * VTID-04890 — give a typeless draft its business type, once.
 *
 * /partner-orgs/register may create an org without partner_type; such an org
 * has no checklist and can never be submitted (PARTNER_TYPE_MISSING). Only a
 * draft whose type is still null can get one here; a type already set is never
 * changed by this path.
 *
 * Draft only, narrower than COMPANY_EDITABLE_STATES on purpose: a typeless org
 * cannot reach needs_action. submitForVerification refuses it before
 * draft -> submitted, needs_action is entered only from verifying/exception,
 * and a legacy status-only write never lands on needs_action
 * (trg_partner_organizations_sync).
 */
export async function setMissingPartnerType(
  s: Supa,
  caller: Caller,
  orgId: string,
  partnerType: unknown,
  meta: { source?: string } = {},
): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  if (!isPartnerType(partnerType)) {
    return fail(400, { error: `partner_type must be one of: ${PARTNER_TYPES.join(', ')}` });
  }
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });

  const answer = (current: OrgRow): ServiceResult | null => {
    if (current.lifecycle_state !== 'draft') {
      return fail(409, { error: 'PARTNER_TYPE_LOCKED', lifecycle_state: current.lifecycle_state });
    }
    if (current.partner_type === partnerType) return { status: 200, body: {} };
    if (current.partner_type !== null) {
      return fail(409, { error: 'PARTNER_TYPE_ALREADY_SET', partner_type: current.partner_type });
    }
    return null;
  };
  const early = answer(org);
  if (early) return early.status === 200 ? orgState(s, orgId) : early;

  // Conditional write: never overwrite a type set concurrently, never touch a
  // business that left draft in between. The DB trigger derives
  // commerce_vertical from the new type.
  const { data: updated, error: updErr } = await s
    .from('partner_organizations')
    .update({ partner_type: partnerType, updated_at: new Date().toISOString() })
    .eq('id', orgId)
    .is('partner_type', null)
    .eq('lifecycle_state', 'draft')
    .select('id');
  if (updErr) return fail(500, { error: updErr.message });
  if (!Array.isArray(updated) || updated.length === 0) {
    const again = await loadOrg(s, orgId);
    if (again.error) return fail(500, { error: again.error });
    if (!again.org) return fail(404, { error: 'ORG_NOT_FOUND' });
    const late = answer(again.org);
    if (late && late.status !== 200) return late;
    return orgState(s, orgId);
  }

  await emitOasisEvent({
    vtid: 'VTID-04890',
    type: 'partner_org.partner_type_set',
    source: meta.source ?? 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId} set its business type to ${partnerType}.`,
    payload: { partner_organization_id: orgId, partner_type: partnerType },
    actor_id: caller.userId,
  });
  return orgState(s, orgId);
}

export type LifecycleMove = { from: LifecycleState; to: LifecycleState };

/**
 * Applies lifecycle moves one at a time, each a compare-and-set on the current
 * state and allowed by the lifecycle graph, with one `partner_org.lifecycle_changed`
 * event per move. Shared by submit (VTID-04478) and the admin review (VTID-04933),
 * so no caller can move an org outside the graph.
 */
export async function applyLifecycleMoves(
  s: Supa,
  orgId: string,
  moves: LifecycleMove[],
  opts: {
    actorId: string | null;
    source: string;
    partnerType: PartnerType | null;
    reason: string;
    payloadFor?: (move: LifecycleMove) => Record<string, unknown>;
  },
): Promise<{ applied: LifecycleMove[]; failure: ServiceResult | null }> {
  const applied: LifecycleMove[] = [];
  for (const move of moves) {
    if (!canTransition(move.from, move.to)) return { applied, failure: fail(500, { error: `illegal transition ${move.from} -> ${move.to}` }) };
    const { data, error: updErr } = await s
      .from('partner_organizations')
      .update({ lifecycle_state: move.to, updated_at: new Date().toISOString() })
      .eq('id', orgId)
      .eq('lifecycle_state', move.from)
      .select('id');
    if (updErr) return { applied, failure: fail(500, { error: updErr.message, applied }) };
    if (!Array.isArray(data) || data.length === 0) return { applied, failure: fail(409, { error: 'CONCURRENT_UPDATE', applied }) };
    applied.push(move);

    await emitOasisEvent({
      vtid: 'VTID-04478',
      type: 'partner_org.lifecycle_changed',
      source: opts.source,
      status: move.to === 'needs_action' || move.to === 'rejected' ? 'warning' : 'success',
      message: `Partner organization ${orgId}: ${move.from} -> ${move.to}.`,
      payload: {
        partner_organization_id: orgId,
        partner_type: opts.partnerType,
        from: move.from,
        to: move.to,
        reason: opts.reason,
        ...(opts.payloadFor ? opts.payloadFor(move) : {}),
      },
      actor_id: opts.actorId ?? undefined,
    });
  }
  return { applied, failure: null };
}

/** Submit for verification: the rules decide live / needs_action. */
export async function submitForVerification(
  s: Supa,
  caller: Caller,
  orgId: string,
  meta: { source?: string } = {},
): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  if (!isPartnerType(org.partner_type)) return fail(409, { error: 'PARTNER_TYPE_MISSING' });
  if (!isLifecycleState(org.lifecycle_state)) return fail(500, { error: `unknown lifecycle_state ${org.lifecycle_state}` });

  const loaded = await loadChecklist(s, org);
  if (loaded.error || !loaded.checklist) return fail(500, { error: loaded.error ?? 'checklist unavailable' });
  const checklist = loaded.checklist;
  if (!checklist.submit_ready) {
    return fail(409, { error: 'SUBMIT_PREREQUISITES_MISSING', missing: checklist.submit_missing, checklist });
  }

  const verdict = evaluateVerification(checklist);
  const moves = submitTransitions(org.lifecycle_state, verdict.outcome);
  if (!moves) return fail(409, { error: 'NOT_SUBMITTABLE', lifecycle_state: org.lifecycle_state });

  // VTID-04971: a review-sandbox supplier (registered test account) is recorded and
  // stopped here: no state change, so no review queue entry and no go-live.
  if (await isSandboxAccount(s as any, org.owner_user_id ?? caller.userId)) {
    await emitOasisEvent({
      vtid: 'VTID-04971',
      type: 'partner_org.sandbox_submitted',
      source: meta.source ?? 'partner-onboarding',
      status: 'info',
      message: `Sandbox organization ${orgId} submitted; nothing changed.`,
      payload: { partner_organization_id: orgId, would_be_outcome: verdict.outcome, open_steps: verdict.open_steps },
      actor_id: caller.userId,
    }).catch(() => undefined);
    return orgState(s, orgId, 200, { transitions: [], open_steps: verdict.open_steps, sandbox: true });
  }

  const moved = await applyLifecycleMoves(s, orgId, moves, {
    actorId: caller.userId,
    source: meta.source ?? 'partner-onboarding',
    partnerType: org.partner_type as PartnerType,
    reason: 'submit',
    payloadFor: (move) => (move.to === 'needs_action' ? { open_steps: verdict.open_steps, failed_steps: verdict.failed_steps } : {}),
  });
  if (moved.failure) return moved.failure;
  const applied = moved.applied;

  // VTID-04820 (Jev E10, shadow): advisory triage, never awaited.
  if (applied.length && isPartnerTriageOn()) {
    void runPartnerTriage({
      org,
      tenantId: caller.tenantId ?? null,
      steps: checklist.steps,
      verificationLevel: checklist.verification_level_required,
      rulesOutcome: verdict.outcome,
    });
  }
  return orgState(s, orgId, 200, { transitions: applied, open_steps: verdict.open_steps });
}

/** The org's merchant and products (org_admin only). */
export async function listCatalogue(s: Supa, caller: Caller, orgId: string): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  const found = await findOrgMerchant(s, org.id);
  if (found.error) return fail(500, { error: found.error });
  if (!found.merchant) return { status: 200, body: { ok: true, merchant: null, products: [] } };
  const { data, error: pErr } = await s
    .from('products')
    .select(PRODUCT_FIELDS)
    .eq('merchant_id', found.merchant.id)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (pErr) return fail(500, { error: pErr.message });
  return { status: 200, body: { ok: true, merchant: found.merchant, products: data ?? [] } };
}

/** Change one of the org's products (never makes it live). */
export async function updateProduct(
  s: Supa,
  caller: Caller,
  orgId: string,
  productId: string,
  input: unknown,
): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  const { org, error: orgErr } = await loadOrg(s, orgId);
  if (orgErr) return fail(500, { error: orgErr });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  if (CATALOGUE_LOCKED_STATES.includes(org.lifecycle_state)) {
    return fail(409, { error: 'CATALOGUE_LOCKED', lifecycle_state: org.lifecycle_state });
  }
  const found = await findOrgMerchant(s, org.id);
  if (found.error) return fail(500, { error: found.error });
  if (!found.merchant) return fail(404, { error: 'PRODUCT_NOT_FOUND' });
  const merchantId = found.merchant.id;

  const parsed = ProductPatchSchema.safeParse(input);
  if (!parsed.success) return fail(400, { error: 'invalid_product', details: parsed.error.flatten() });
  if (Object.keys(parsed.data).length === 0) return fail(400, { error: 'invalid_product', message: 'no fields to change' });

  // The ships-to rule holds for the product's final state, not the patch.
  if (parsed.data.ships_to_countries !== undefined || parsed.data.ships_to_regions !== undefined) {
    const { data: current, error } = await s
      .from('products')
      .select('ships_to_countries,ships_to_regions')
      .eq('id', productId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (error) return fail(500, { error: error.message });
    if (!current) return fail(404, { error: 'PRODUCT_NOT_FOUND' });
    if (!shipsSomewhere({ ...(current as object), ...parsed.data })) {
      return fail(400, { error: 'invalid_product', details: { fieldErrors: { ships_to_countries: [SHIPS_SOMEWHERE_MESSAGE] } } });
    }
  }

  // VTID-04933: `attributes.admin_listing` is the admin's listing decision
  // (keep offline / allow listing). A supplier never sets it, and replacing
  // `attributes` keeps the decision that is already there.
  const patch: Record<string, unknown> = { ...parsed.data };
  if (patch.attributes && typeof patch.attributes === 'object') {
    const { admin_listing: _ignored, ...supplierAttrs } = patch.attributes as Record<string, unknown>;
    const { data: cur, error: curErr } = await s
      .from('products')
      .select('attributes')
      .eq('id', productId)
      .eq('merchant_id', merchantId)
      .maybeSingle();
    if (curErr) return fail(500, { error: curErr.message });
    if (!cur) return fail(404, { error: 'PRODUCT_NOT_FOUND' });
    const kept = ((cur as { attributes?: Record<string, unknown> | null }).attributes ?? {}).admin_listing;
    patch.attributes = kept === undefined ? supplierAttrs : { ...supplierAttrs, admin_listing: kept };
  }

  // merchant_id is the authorization: another org's product matches no row.
  const { data, error } = await s
    .from('products')
    .update(patch)
    .eq('id', productId)
    .eq('merchant_id', merchantId)
    .select(PRODUCT_FIELDS)
    .maybeSingle();
  if (error) return fail(500, { error: error.message });
  if (!data) return fail(404, { error: 'PRODUCT_NOT_FOUND' });

  const step = await syncCatalogueStep(s, org.id, merchantId, caller.userId);
  if (step.error) return fail(500, { error: step.error });
  if (step.changed) await catalogueEvent(org.id, step, caller.userId);
  return orgState(s, org.id, 200, { product: data });
}


// ==================== VTID-04941: verification, store detection, connections ====================

/** How long the host lookup at store time may take; a slow resolver never blocks a save. */
const WEBSITE_HOST_CHECK_MS = 2000;

/**
 * True only when the website's host is, or resolves to, a loopback, private,
 * link-local or other non-public address. A DNS failure or a slow resolver is
 * NOT a refusal here (a typo or a flaky resolver must not stop a save); the
 * fetch-time guard (ssrfGuardedFetch) is authoritative.
 */
export async function websiteIsInternal(website: string): Promise<boolean> {
  const host = hostOf(website);
  if (!host) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      assertPublicHost(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('host_check_timeout')), WEBSITE_HOST_CHECK_MS);
      }),
    ]);
    return false;
  } catch (err) {
    return (err as Error)?.message === 'blocked_private_address';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TIMED_OUT = Symbol('timed_out');

/** Runs one slow check inside what is left of an overall time budget. */
async function withinBudget<T>(deadline: number | null, run: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  if (deadline === null) return run();
  const left = deadline - Date.now();
  if (left <= 0) return TIMED_OUT;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), left);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs the automated verification checks of spec §7 and records the result as
 * the `verification` step row (moved here from routes/partner-onboarding.ts so
 * the Commerce MCP runs exactly the same checks). With `budgetMs`, slow checks
 * (DNS, the site fetch, VIES) that exceed the overall budget are reported as
 * `unavailable` with `retry_after` instead of blocking; a timed-out check never
 * credits a level.
 */
export async function checkVerification(
  s: Supa,
  caller: Caller,
  orgId: string,
  opts: { budgetMs?: number } = {},
): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  const callerId = caller.userId;

  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  if (!isPartnerType(org.partner_type)) return fail(409, { error: 'PARTNER_TYPE_MISSING' });
  if (org.lifecycle_state === 'rejected') {
    return fail(409, { error: 'NOT_CHECKABLE', lifecycle_state: org.lifecycle_state });
  }
  const required = VERIFICATION_LEVEL_REQUIRED[org.partner_type];
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : null;
  let timedOut = false;

  const prior = await s
    .from('partner_onboarding_steps')
    .select('detail')
    .eq('partner_organization_id', orgId)
    .eq('step_key', 'verification')
    .maybeSingle();
  if (prior.error) return fail(500, { error: prior.error.message });
  const priorDetail = ((prior.data as { detail?: Record<string, unknown> | null } | null)?.detail ?? null) as Record<string, unknown> | null;
  // VTID-04933: an admin approval (verification level 1, owner decision for v1)
  // holds until the company facts change; this check still runs and reports,
  // but never downgrades it. Read before anything is written.
  const heldApproval = priorDetail?.method === 'admin_approval' && !verificationIsStale(priorDetail, { partner_type: org.partner_type, legal_name: org.legal_name, country: org.country, vat_id: org.vat_id, website: org.website });
  const priorToken = priorDetail?.domain_token;
  const token = typeof priorToken === 'string' && /^[a-f0-9]{32}$/.test(priorToken) ? priorToken : randomBytes(16).toString('hex');

  // Level 0: the org owner's confirmed email and ownership of the website.
  const email = await readEmailConfirmation(s as any, org.owner_user_id);
  const emailStatus: CheckStatus =
    email.status === 'confirmed' ? 'passed' : email.status === 'unconfirmed' ? 'failed' : 'unavailable';

  const host = hostOf(org.website);
  let domainStatus: CheckStatus = 'pending';
  let domainMethod: 'email_domain' | 'dns_txt' | 'meta_tag' | null = null;
  if (host) {
    const emailDomain = emailDomainOf(email.email);
    if (email.status === 'confirmed' && emailDomain && domainsMatch(host, emailDomain)) {
      domainMethod = 'email_domain';
    } else {
      const txt = await withinBudget(deadline, () => lookupDomainProofTxt(host));
      if (txt === TIMED_OUT) timedOut = true;
      else if (txtRecordsContainToken(txt, token)) domainMethod = 'dns_txt';
      if (!domainMethod && !timedOut) {
        const html = await withinBudget(deadline, () => fetchSiteHtml(org.website as string));
        if (html === TIMED_OUT) timedOut = true;
        else if (html !== null && htmlContainsMetaToken(html, token)) domainMethod = 'meta_tag';
      }
    }
    if (domainMethod) domainStatus = 'passed';
    else if (timedOut) domainStatus = 'unavailable';
  }

  // Level 1: EU VAT id in VIES (not required outside the EU). Only looked up
  // for types that need level 1+; otherwise left `pending`, never `not_required`.
  let vatStatus: CheckStatus = isEuCountry(org.country) ? 'pending' : org.country ? 'not_required' : 'pending';
  let vatRegisteredName: string | null = null;
  let vatError: string | undefined;
  if (required >= 1 && isEuCountry(org.country)) {
    const vat = org.vat_id ? normalizeVatNumber(org.vat_id, org.country as string) : null;
    if (!org.vat_id) vatStatus = 'pending';
    else if (!vat) vatStatus = 'failed';
    else {
      const vies = await withinBudget(deadline, () => checkVatVies(vat.country_code, vat.number));
      if (vies === TIMED_OUT) {
        timedOut = true;
        vatStatus = 'unavailable';
        vatError = 'timeout';
      } else {
        vatStatus = vies.status === 'valid' ? 'passed' : vies.status === 'invalid' ? 'failed' : 'unavailable';
        vatRegisteredName = vies.name;
        vatError = vies.error;
      }
    }
  }

  const checks: VerificationChecks = {
    email_verified: emailStatus,
    domain: domainStatus,
    vat: vatStatus,
    // Spec Q2 (Stripe Connect or VIES + billing mandate) and Q6 (licence
    // sources) are open, so neither provider exists yet.
    business_verification: 'not_configured',
    licence: 'not_configured',
  };
  const outcome = computeVerification(required, checks);
  if (!host) outcome.missing.unshift('website');
  const checkedAt = new Date().toISOString();

  const detail = {
    level_required: required,
    level_reached: outcome.level_reached,
    checks,
    missing: outcome.missing,
    domain_method: domainMethod,
    domain_token: token,
    vat_registered_name: vatRegisteredName,
    ...(vatError ? { vat_error: vatError } : {}),
    facts: { website: org.website, country: org.country, vat_id: org.vat_id },
    checked_at: checkedAt,
  };
  const { error: upErr } = await s.from('partner_onboarding_steps').upsert(
    {
      partner_organization_id: orgId,
      step_key: 'verification',
      status: heldApproval ? 'done' : outcome.step_status,
      detail: heldApproval
        ? { ...priorDetail, domain_token: token, auto_check: { level_reached: outcome.level_reached, checks, missing: outcome.missing, domain_method: domainMethod, checked_at: checkedAt } }
        : detail,
      updated_by: callerId,
      updated_at: checkedAt,
    },
    { onConflict: 'partner_organization_id,step_key' },
  );
  if (upErr) return fail(500, { error: upErr.message });

  const trustLevel = heldApproval ? Math.max(outcome.level_reached ?? 0, 1) : outcome.level_reached ?? 0;
  if (trustLevel !== org.trust_level) {
    const { error: trustErr } = await s
      .from('partner_organizations')
      .update({ trust_level: trustLevel, updated_at: checkedAt })
      .eq('id', orgId);
    if (trustErr) return fail(500, { error: trustErr.message });
  }

  await emitOasisEvent({
    vtid: 'VTID-04486',
    type: 'partner_org.verification_checked',
    source: 'partner-onboarding',
    status: outcome.step_status === 'done' ? 'success' : outcome.step_status === 'failed' ? 'warning' : 'info',
    message: `Partner organization ${orgId}: verification level ${outcome.level_reached ?? 'none'} of ${required} (${outcome.step_status}).`,
    // Check statuses only: the VAT id, email and registered name stay in the step row.
    payload: {
      partner_organization_id: orgId,
      level_required: required,
      level_reached: outcome.level_reached,
      step_status: outcome.step_status,
      checks,
      domain_method: domainMethod,
    },
    actor_id: callerId,
  });

  return orgState(s, orgId, 200, {
    verification: {
      level_required: required,
      level_reached: outcome.level_reached,
      status: outcome.step_status,
      checks,
      missing: outcome.missing,
      domain_method: domainMethod,
      domain_proof: host && domainStatus !== 'passed' ? domainProofInstructions(host, token) : null,
      ...(timedOut ? { partial: true, retry_after_seconds: 30 } : {}),
      ...(heldApproval ? { admin_approval: true } : {}),
    },
  });
}

/** Detect the storefront platform from the org's website and record it (moved from the /detect route). */
export async function detectStore(
  s: Supa,
  caller: Caller,
  orgId: string,
  input: { website?: unknown } = {},
): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;

  const { data: row, error } = await s
    .from('partner_organizations')
    .select('id, website, business_details')
    .eq('id', orgId)
    .maybeSingle();
  if (error) return fail(500, { error: error.message });
  if (!row) return fail(404, { error: 'ORG_NOT_FOUND' });
  const current = row as { id: string; website: string | null; business_details: Record<string, unknown> | null };

  const requested = input.website;
  let website: string | null = current.website;
  if (requested !== undefined && requested !== null && requested !== '') {
    const parsed = parseCompanyFacts({ website: requested });
    if (!parsed.ok) return fail(400, { error: parsed.error });
    website = parsed.facts.website ?? null;
  }
  if (!website) return fail(400, { error: 'WEBSITE_REQUIRED' });

  const detection = await detectPlatform(website);
  if (!detection.ok) {
    return fail(422, { error: 'DETECTION_FAILED', reason: detection.error ?? 'unknown' });
  }

  const record = {
    url: website,
    connector_id: detection.connector_id ?? null,
    provider_id: detection.provider_id ?? null,
    platform_name: detection.name_hint ?? null,
    confidence: detection.confidence ?? 'none',
    detected_at: new Date().toISOString(),
  };
  const { error: updErr } = await s
    .from('partner_organizations')
    .update({
      business_details: { ...(current.business_details ?? {}), platform_detection: record },
      updated_at: new Date().toISOString(),
    })
    .eq('id', orgId);
  if (updErr) return fail(500, { error: updErr.message });

  await emitOasisEvent({
    vtid: 'VTID-04481',
    type: 'partner_org.platform_detected',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId}: storefront platform ${record.connector_id ?? 'not recognised'} (${record.confidence}).`,
    payload: {
      partner_organization_id: orgId,
      connector_id: record.connector_id,
      provider_id: record.provider_id,
      confidence: record.confidence,
    },
    actor_id: caller.userId,
  });

  return orgState(s, orgId, 200, {
    detection: record,
    suggested: { website, display_name: detection.site_name ?? null },
  });
}

/**
 * Start a connection for the org (moved from POST /:orgId/connections). The
 * connector defaults from the org's website detection. With `reuseExisting`
 * (the MCP's idempotent path) a connection the org already has for the same
 * connector and provider is returned instead of creating a second one.
 */
export async function startConnection(
  s: Supa,
  caller: Caller,
  orgId: string,
  input: Record<string, unknown> = {},
  opts: { reuseExisting?: boolean } = {},
): Promise<ServiceResult> {
  const denied = await authorize(s, caller, orgId);
  if (denied) return denied;
  const callerId = caller.userId;

  const { org, error } = await loadOrg(s, orgId);
  if (error) return fail(500, { error });
  if (!org) return fail(404, { error: 'ORG_NOT_FOUND' });
  if (CONNECTIONS_LOCKED_STATES.includes(org.lifecycle_state)) {
    return fail(409, { error: 'CONNECTIONS_LOCKED', lifecycle_state: org.lifecycle_state });
  }

  let connectorId = input.connector_id;
  let providerId = input.provider_id;
  if (connectorId === undefined && providerId === undefined) {
    const { data: row, error: bdErr } = await s
      .from('partner_organizations')
      .select('business_details')
      .eq('id', orgId)
      .maybeSingle();
    if (bdErr) return fail(500, { error: bdErr.message });
    const det = ((row as { business_details?: Record<string, any> } | null)?.business_details ?? {}).platform_detection;
    if (det && typeof det === 'object') {
      connectorId = det.connector_id ?? undefined;
      providerId = det.provider_id ?? undefined;
    }
  }
  if (typeof connectorId !== 'string' || !CONNECTOR_TOKEN.test(connectorId) || typeof providerId !== 'string' || !CONNECTOR_TOKEN.test(providerId)) {
    return fail(400, {
      error: 'CONNECTOR_REQUIRED',
      message: 'connector_id and provider_id are required (or run POST /detect on a recognised storefront first)',
    });
  }
  for (const key of ['connection_type', 'risk_level'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !CONNECTOR_TOKEN.test(input[key] as string))) {
      return fail(400, { error: `${key} must be a short lowercase token` });
    }
  }
  const openapi = input.openapi_document;
  if (openapi !== undefined && (openapi === null || typeof openapi !== 'object' || Array.isArray(openapi))) {
    return fail(400, { error: 'openapi_document must be a JSON object' });
  }

  if (opts.reuseExisting) {
    const listed = await listOrgConnections(s, orgId);
    if (listed.error) return fail(500, { error: listed.error });
    const same = listed.rows.find((r) => r.connector_id === connectorId && r.provider_id === providerId);
    if (same) {
      const refreshed = await refreshMappingStep(s, orgId, callerId);
      if (refreshed.error) return fail(500, { error: refreshed.error });
      return orgState(s, orgId, 200, {
        connection: { id: same.id, connector_id: connectorId, provider_id: providerId, state: same.status },
        reused: true,
      });
    }
  }

  const now = new Date().toISOString();

  // One partner_tenant per org.
  const found = await s
    .from('partner_tenant')
    .select('id')
    .eq('partner_organization_id', orgId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (found.error) return fail(500, { error: found.error.message });
  let partnerTenantId = (found.data as { id: string } | null)?.id ?? null;
  if (!partnerTenantId) {
    partnerTenantId = randomUUID();
    const { error: ptErr } = await s.from('partner_tenant').insert({
      id: partnerTenantId,
      tenant_id: caller.tenantId || 'platform',
      name: org.display_name,
      status: 'discovered',
      jurisdiction: org.country,
      partner_organization_id: orgId,
      // The org owner, so the portal's per-connection endpoints serve them.
      owner_user_id: org.owner_user_id,
      owner_email: callerId === org.owner_user_id ? caller.email ?? null : null,
      created_at: now,
      updated_at: now,
    });
    if (ptErr) return fail(500, { error: ptErr.message });
  }

  const created = await insertConnection(s, {
    partnerTenantId,
    connector_id: connectorId,
    provider_id: providerId,
    connection_type: input.connection_type as string | undefined,
    risk_level: input.risk_level as string | undefined,
    openapi_document: openapi,
    now,
  });
  if (!created.ok) return fail(created.status, { error: created.error });

  await emitOasisEvent({
    vtid: 'VTID-04499',
    type: 'partner_org.connection_started',
    source: 'partner-onboarding',
    status: 'success',
    message: `Partner organization ${orgId}: connection ${created.manifestId} started (${connectorId}, ${created.initialState}).`,
    payload: {
      partner_organization_id: orgId,
      connection_id: created.manifestId,
      connector_id: connectorId,
      provider_id: providerId,
      state: created.initialState,
    },
    actor_id: callerId,
  });

  const refreshed = await refreshMappingStep(s, orgId, callerId);
  if (refreshed.error) return fail(500, { error: refreshed.error });

  return orgState(s, orgId, 201, {
    connection: { id: created.manifestId, connector_id: connectorId, provider_id: providerId, state: created.initialState },
  });
}
