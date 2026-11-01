/**
 * VTID-05099 — the Vitana Companion Messages tick (Phase 1: SHADOW ONLY).
 *
 * Every 15 minutes: for each member whose LOCAL time is inside the delivery
 * window and who has not been decided for today, pick the one moment (and
 * Vitana card) Vitana would bring, and record it in companion_messages_ledger
 * as a shadow row. A capped sample is fully composed by Claude on Bedrock so
 * the wording can be reviewed. Nothing is sent: no DM, no push, no pacer touch.
 *
 * VTID-05100 — sending modes (only with COMPANION_SEND_ENABLED=true, see
 * config.ts): in `staff` mode members holding a staff/admin role get a real
 * Vitana DM + one push (delivery.ts) and everyone else keeps exactly the
 * shadow behaviour; in `live` mode every eligible member gets the DM. A send
 * claims the ledger with mode staff|live (the partial unique index keeps it
 * to one real proactive DM per member per local day, whoever sends it),
 * composes without the shadow cap, and a failed composition finishes the
 * slot as `failed` with no DM — never a template.
 *
 * Guards: never on staging (shared database); feature flag + COMPANION_MODE;
 * test/service accounts excluded with the STRICT lookup (a failed lookup skips
 * the whole tick); members who switched companion messages off, already have
 * a ledger row today (any sender), had an onboarding touch today, or whom the
 * presence pacer would not allow, are skipped.
 */
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchExcludedTestServiceAccountIdsStrict } from '../../lib/excluded-test-service-accounts';
import { VITANA_BOT_USER_ID } from '../../lib/vitana-bot';
import { bulkGetUserLocales } from '../../i18n/server-locale';
import { emitOasisEvent } from '../oasis-event-service';
import { canSurfaceProactively, type PacerDecision } from '../guide/presence-pacer';
import { fetchVitanaIndexForProfiler, type VitanaIndexSnapshot } from '../user-context-profiler';
import * as repo from './companion-repository';
import { composeCompanionMessage, type ComposeResult } from './composer';
import { resolveCompanionConfig, isSendMode, type CompanionConfig } from './config';
import { deliverCompanionMessage, type DeliveryInput, type DeliveryResult } from './delivery';
import { localTime, minusDays } from './local-time';
import { pickMoment, type MemberContext, type MomentCandidate } from './moments';
import { backoffDecision } from './backoff';
import { fetchMemberSignals, memberSignals, fetchEnrichmentCompletions, type FetchSignals, type FetchEnrichmentCompletions } from './signals';
import { eligibleEnrichmentCards } from '../enrichment/card-catalog';
import { unavailableEnrichmentCards } from '../enrichment/card-availability';

const VTID = 'VTID-05099';
// VTID-05101: long enough for the weekly back-off (7 unreplied sends at a
// weekly cadence) and the moments' anti-repeat windows.
const LEDGER_LOOKBACK_DAYS = 60;

export interface CompanionTickResult {
  ok: boolean;
  mode: CompanionConfig['mode'];
  reason: string;
  tick_id?: string;
  members?: number;
  in_window?: number;
  decided?: number;
  composed?: number;
  compose_failed?: number;
  /** VTID-05100: real DMs delivered / that failed to deliver this tick. */
  sent?: number;
  send_failed?: number;
  moments?: Record<string, number>;
  skipped?: Record<string, number>;
  /** VTID-05101: signal sources that could not be read this tick (their moments did not fire). */
  signals_unavailable?: string[];
  /** VTID-05367: enrichment completion/dismissal sources that could not be read (their E-cards did not fire). */
  enrichment_unavailable?: string[];
  error?: string;
}

export interface CompanionTickDeps {
  sb: SupabaseClient;
  now?: Date;
  config?: CompanionConfig;
  emit?: typeof emitOasisEvent;
  pacer?: (userId: string) => Promise<PacerDecision>;
  fetchIndex?: (sb: SupabaseClient, userId: string) => Promise<VitanaIndexSnapshot | null>;
  compose?: (ctx: MemberContext, moment: MomentCandidate, config: CompanionConfig) => Promise<ComposeResult>;
  locales?: (sb: SupabaseClient, ids: string[]) => Promise<Map<string, string>>;
  /** VTID-05100: send-mode seams. */
  deliver?: (input: DeliveryInput) => Promise<DeliveryResult>;
  staffIds?: (sb: SupabaseClient, members: repo.MemberRow[]) => Promise<Set<string>>;
  /** VTID-05101: Phase 3 member signals, one batch per page of members. */
  signals?: FetchSignals;
  /** VTID-05367: bulk enrichment completion + dismissal, one batch per page. */
  enrichment?: FetchEnrichmentCompletions;
}

export async function runCompanionTick(deps: CompanionTickDeps): Promise<CompanionTickResult> {
  const config = deps.config ?? resolveCompanionConfig();
  if (config.mode !== 'shadow' && !isSendMode(config.mode)) return { ok: true, mode: config.mode, reason: config.reason };

  const sb = deps.sb;
  const now = deps.now ?? new Date();
  const emit = deps.emit ?? emitOasisEvent;
  const pacer = deps.pacer ?? ((id: string) => canSurfaceProactively(id, 'messenger_companion'));
  const fetchIndex = deps.fetchIndex ?? fetchVitanaIndexForProfiler;
  const compose = deps.compose ?? ((ctx, m, c) => composeCompanionMessage(ctx, m, c));
  const locales = deps.locales ?? bulkGetUserLocales;
  const deliver = deps.deliver ?? ((input: DeliveryInput) => deliverCompanionMessage(input, { sb }));
  const staffIds = deps.staffIds ?? repo.fetchStaffMemberIds;
  const fetchSignals = deps.signals ?? fetchMemberSignals;
  const fetchEnrichment = deps.enrichment ?? fetchEnrichmentCompletions;

  const excluded = await fetchExcludedTestServiceAccountIdsStrict(sb);
  if (!excluded.ok) return { ok: false, mode: config.mode, reason: 'exclusion_unavailable', error: excluded.error };

  const tickId = randomUUID();
  const skipped: Record<string, number> = {};
  const skip = (r: string) => { skipped[r] = (skipped[r] ?? 0) + 1; };
  const moments: Record<string, number> = {};

  const allMembers = await repo.fetchMembers(sb);
  const members = allMembers.filter((m) => m.user_id !== VITANA_BOT_USER_ID && !excluded.ids.has(m.user_id));

  // Who is inside their local delivery window right now?
  const profiles = await repo.fetchProfiles(sb, members.map((m) => m.user_id));
  const profileBy = new Map(profiles.map((p) => [p.user_id, p]));
  const inWindow: Array<repo.MemberRow & { date: string; firstName: string | null }> = [];
  for (const m of members) {
    const p = profileBy.get(m.user_id);
    const lt = localTime(now, p?.timezone);
    if (lt.minuteOfDay >= config.windowStartMin && lt.minuteOfDay < config.windowEndMin) {
      inWindow.push({ ...m, date: lt.date, firstName: p?.first_name ?? null });
    }
  }

  let decided = 0;
  let composed = 0;
  let composeFailed = 0;
  let sent = 0;
  let sendFailed = 0;
  let signalsUnavailable: string[] = [];
  let enrichmentUnavailable: string[] = [];

  if (inWindow.length > 0) {
    const ids = inWindow.map((m) => m.user_id);
    const earliest = inWindow.map((m) => m.date).sort()[0];
    const [prefs, ledger, onboarding, localeMap, signals, enrichment] = await Promise.all([
      repo.fetchPreferences(sb, ids),
      repo.fetchRecentLedger(sb, ids, minusDays(earliest, LEDGER_LOOKBACK_DAYS)),
      repo.fetchOnboardingTouches(sb, ids, earliest),
      locales(sb, ids),
      fetchSignals(sb, ids, now),
      fetchEnrichment(sb, ids),
    ]);
    signalsUnavailable = signals.unavailable;
    enrichmentUnavailable = enrichment.unavailable;
    // VTID-05367: enrichment cards unavailable on this stack (E6/E7 while Meta
    // OAuth is unset). Computed once per tick; passed as the 5th arg below so
    // an unconfigured card is never offered (the TS default would silently
    // enable it — R2-F3).
    const unavailableCards = unavailableEnrichmentCards();
    const prefBy = new Map(prefs.map((p) => [p.user_id, p]));
    const ledgerBy = new Map<string, repo.LedgerRow[]>();
    for (const r of ledger) {
      if (!ledgerBy.has(r.user_id)) ledgerBy.set(r.user_id, []);
      ledgerBy.get(r.user_id)!.push(r);
    }
    const onboardingToday = new Set(onboarding.map((o) => `${o.user_id}|${o.local_day}`));

    const startOfUtcDay = new Date(now);
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    let composeBudget = Math.max(0, config.shadowComposeLimit - await repo.countShadowComposedSince(sb, startOfUtcDay.toISOString()));

    // VTID-05100: who gets a real DM this tick. staff → only staff/admin
    // members (a failed lookup means nobody: fail closed); live → everyone.
    let staff = new Set<string>();
    if (config.mode === 'staff') {
      try { staff = await staffIds(sb, inWindow); } catch (err: any) {
        console.warn(`[companion] staff lookup failed, nobody is sent to this tick: ${err?.message ?? err}`);
        staff = new Set<string>();
      }
    }
    const sendModeFor = (userId: string): 'staff' | 'live' | null =>
      config.mode === 'live' ? 'live' : config.mode === 'staff' && staff.has(userId) ? 'staff' : null;

    for (const m of inWindow) {
      const pref = prefBy.get(m.user_id);
      if (pref && !pref.enabled) { skip('opted_out'); continue; }
      const rows = ledgerBy.get(m.user_id) ?? [];
      if (rows.some((r) => r.local_date === m.date)) { skip('already_today'); continue; }
      if (onboardingToday.has(`${m.user_id}|${m.date}`)) { skip('onboarding_touched_today'); continue; }
      // VTID-05101 back-off: unanswered real sends slow Vitana down (ledger only).
      if (!backoffDecision(rows, m.date).allow) { skip('backoff'); continue; }

      const decision = await pacer(m.user_id);
      if (!decision.allow) { skip(`pacer_${decision.reason ?? 'denied'}`); continue; }

      const lastUsed: Record<string, string> = {};
      for (const r of rows) {
        if (!lastUsed[r.moment_key] || lastUsed[r.moment_key] < r.local_date) lastUsed[r.moment_key] = r.local_date;
      }
      let index: VitanaIndexSnapshot | null = null;
      try { index = await fetchIndex(sb, m.user_id); } catch { index = null; }

      // VTID-05367: which enrichment cards this member should be offered, with
      // the tick's real `now` (Moment.build has no Date — R3-F1). Completion is
      // false-initialized (R1-F3) so a member with no source rows is eligible.
      const completions = enrichment.completions.get(m.user_id) ?? new Map();
      const dismissRows = enrichment.dismissals.get(m.user_id) ?? [];
      const eligibleEnrichmentCardTypes = new Set(
        eligibleEnrichmentCards(completions, dismissRows, 'messenger', now, unavailableCards).map((c) => c.card_type),
      );

      const ctx: MemberContext = {
        userId: m.user_id,
        tenantId: m.tenant_id,
        firstName: m.firstName,
        locale: localeMap.get(m.user_id) ?? 'de',
        localDate: m.date,
        topics: {
          health: pref?.topic_health ?? true,
          community: pref?.topic_community ?? true,
          business: pref?.topic_business ?? false,
        },
        vitanaIndex: index,
        lastUsed,
        eligibleEnrichmentCardTypes,
        ...memberSignals(signals.by.get(m.user_id), rows, m.date),
      };
      const moment = pickMoment(ctx);
      const sendMode = sendModeFor(m.user_id);

      const claim = await repo.claimMessage(sb, {
        user_id: m.user_id, tenant_id: m.tenant_id, local_date: m.date, mode: sendMode ?? 'shadow',
        sender: 'companion', moment_key: moment.momentKey, card_type: moment.cardType, facts: moment.facts,
      });
      if (!claim.ok) { skip('claim_error'); continue; }
      if (!claim.claimed) { skip(claim.reason); continue; }

      decided++;
      moments[moment.momentKey] = (moments[moment.momentKey] ?? 0) + 1;

      if (sendMode) {
        // A real send: always composed (no shadow cap); a failed composition is no DM.
        const c = await compose(ctx, moment, config);
        if (!c.ok) {
          composeFailed++;
          skip(`compose_${c.error.split(':')[0]}`);
          await repo.finishMessage(sb, claim.id, 'failed', null, null);
          continue;
        }
        composed++;
        const d = await deliver({
          ledgerId: claim.id, mode: sendMode, userId: m.user_id, tenantId: m.tenant_id,
          momentKey: moment.momentKey, cardType: moment.cardType, facts: moment.facts,
          text: c.text, model: c.model,
        });
        if (d.ok) sent++; else { sendFailed++; skip('send_failed'); }
        continue;
      }

      let text: string | null = null;
      let model: string | null = null;
      if (composeBudget > 0) {
        composeBudget--;
        const c = await compose(ctx, moment, config);
        if (c.ok) { text = c.text; model = c.model; composed++; }
        else { composeFailed++; skip(`compose_${c.error.split(':')[0]}`); }
      }
      await repo.finishMessage(sb, claim.id, 'shadow', text, model);
    }
  }

  const result: CompanionTickResult = {
    ok: true, mode: config.mode, reason: config.reason, tick_id: tickId,
    members: members.length, in_window: inWindow.length, decided, composed, compose_failed: composeFailed,
    ...(isSendMode(config.mode) ? { sent, send_failed: sendFailed } : {}),
    moments, skipped,
    ...(signalsUnavailable.length > 0 ? { signals_unavailable: signalsUnavailable } : {}),
    ...(enrichmentUnavailable.length > 0 ? { enrichment_unavailable: enrichmentUnavailable } : {}),
  };
  // One aggregate event per tick that decided something — never one per member,
  // and nothing for a tick that found no one (OASIS: decisions, not polling).
  if (decided > 0 || composeFailed > 0) {
    await emit({
      vtid: VTID, type: 'companion.tick.completed', source: 'companion-messages', status: 'success',
      message: `companion messages (${config.mode}): ${decided} decided, ${composed} composed${isSendMode(config.mode) ? `, ${sent} sent` : ''}`,
      payload: { ...result },
      actor_role: 'system', surface: 'system',
    }).catch(() => undefined);
  }
  return result;
}
