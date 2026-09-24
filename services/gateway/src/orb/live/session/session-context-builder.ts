/**
 * VTID-04414 (Plan v1 WS-1.3) — one context builder for every ORB voice path.
 *
 * Before this module, the voice session's standing context was assembled in
 * three different places with three different results:
 *
 *   - session start (live-session-controller.ts): the brain
 *     (`buildBrainSystemInstructionCached`) when `vitana_brain_orb_enabled`
 *     is on, the legacy `buildBootstrapContextPack` otherwise, then the
 *     Autopilot offer, the admin briefing and the Guided Journey standing
 *     block appended;
 *   - the SSE reconnect rebuild (orb-live.ts GET /live/stream): ALWAYS the
 *     legacy pack, with none of the three appended blocks — so a session that
 *     started on the brain silently switched to the legacy context, and lost
 *     its journey position, on any reconnect more than 60 s into it. A
 *     guided-topic lesson was even swapped from its lesson context to the full
 *     community pack mid-lesson;
 *   - LiveKit (orb-livekit.ts): ALWAYS the legacy pack.
 *
 * Here every path asks the same two questions — which builder, which role —
 * and composes the same appended blocks. Session start records its answers on
 * the session (`contextBuilder`, `contextBrainRole`, `contextExtras`), so a
 * reconnect rebuilds exactly what the session started with.
 *
 * The guided-topic (lesson) surface stays deliberately small — its first
 * audio must not wait for the brain — but it now carries the learner's
 * verified facts from the stored core snapshot (VTID-04399), bounded, so the
 * lesson can be made relevant to the person hearing it.
 */

import type { SupabaseIdentity } from '../../../middleware/auth-supabase-jwt';
import type { ContextPack } from '../../../types/conversation';
import { splitBootstrapSections } from '../instruction/bootstrap-packer';

export type ContextBuilderKind = 'brain' | 'legacy' | 'lesson';

export interface BaseContextResult {
  contextInstruction?: string;
  contextPack?: ContextPack;
  latencyMs?: number;
  skippedReason?: string;
  builder: ContextBuilderKind;
  /** Brain only: the instruction without the time-bound proactive guide (VTID-04399). */
  coreInstruction?: string;
  /** Set when the brain was asked for and failed, so the legacy pack served. */
  brainError?: string;
}

export interface LegacyResult {
  contextInstruction?: string;
  contextPack?: ContextPack;
  latencyMs?: number;
  skippedReason?: string;
}

export type LegacyBuilder = (identity: SupabaseIdentity, sessionId: string) => Promise<LegacyResult>;

export interface BrainBuildInput {
  user_id: string;
  tenant_id: string;
  role: string;
  channel: 'orb';
  thread_id: string;
  user_timezone?: string;
}

export type BrainBuilder = (input: BrainBuildInput) => Promise<{
  instruction: string;
  contextPack: ContextPack;
  coreInstruction: string;
}>;

export interface BaseContextDeps {
  legacy: LegacyBuilder;
  buildBrain?: BrainBuilder;
  isBrainEnabled?: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * The role the brain builds for. Mobile is always community; the Command Hub
 * is developer; otherwise the identity's active role. Same rule the
 * controller used inline before this module.
 */
export function resolveBrainRole(input: {
  isMobile?: boolean;
  route?: string | null;
  identityRole?: string | null;
}): string {
  if (input.isMobile) return 'community';
  if ((input.route || '').startsWith('/command-hub')) return 'developer';
  return input.identityRole || 'community';
}

// ---------------------------------------------------------------------------
// Base build (brain or legacy)
// ---------------------------------------------------------------------------

async function defaultIsBrainEnabled(): Promise<boolean> {
  const { isVitanaBrainOrbEnabled } = await import('../../../services/system-controls-service');
  return isVitanaBrainOrbEnabled();
}

async function defaultBuildBrain(input: BrainBuildInput) {
  const { buildBrainSystemInstructionCached } = await import('../../../services/vitana-brain-cache');
  return buildBrainSystemInstructionCached(input);
}

/**
 * Build the base (pre-append) context. `useBrain` may be passed when the
 * caller already evaluated the flag; otherwise it is read here. A brain
 * failure falls back to the legacy pack and says so in `brainError`.
 */
export async function buildBaseSessionContext(
  req: {
    identity: SupabaseIdentity;
    sessionId: string;
    brainRole: string;
    timezone?: string | null;
    useBrain?: boolean;
  },
  deps: BaseContextDeps,
): Promise<BaseContextResult> {
  const useBrain = typeof req.useBrain === 'boolean'
    ? req.useBrain
    : await (deps.isBrainEnabled ?? defaultIsBrainEnabled)().catch(() => false);
  if (!useBrain) {
    const legacy = await deps.legacy(req.identity, req.sessionId);
    return { ...legacy, builder: 'legacy' };
  }
  const start = Date.now();
  try {
    const { instruction, contextPack, coreInstruction } = await (deps.buildBrain ?? defaultBuildBrain)({
      user_id: req.identity.user_id,
      tenant_id: req.identity.tenant_id || 'default',
      role: req.brainRole,
      channel: 'orb',
      thread_id: req.sessionId,
      user_timezone: req.timezone || undefined,
    });
    return {
      contextInstruction: instruction,
      contextPack,
      latencyMs: Date.now() - start,
      builder: 'brain',
      coreInstruction,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    console.warn(`[VTID-04414] brain context failed for ${req.sessionId}, serving the legacy pack: ${message}`);
    const legacy = await deps.legacy(req.identity, req.sessionId);
    return { ...legacy, builder: 'legacy', brainError: message };
  }
}

// ---------------------------------------------------------------------------
// Composition (the blocks appended after the base build)
// ---------------------------------------------------------------------------

export interface ContextExtras {
  /** Community sessions only (VTID-03201). */
  autopilotOffer?: string | null;
  /** Admin roles only (BOOTSTRAP-ADMIN-EE). */
  adminBriefing?: string | null;
}

/**
 * Append the session extras and the Guided Journey standing block to the base
 * context, in the order session start has always used: offer, briefing,
 * journey. Pure. Returns which extras were actually applied so the caller can
 * log / emit for them and store them for a reconnect rebuild.
 */
export function composeSessionContext(input: {
  base: string;
  role: string | null | undefined;
  isAdminRole: boolean;
  extras: ContextExtras;
  journeyBlock?: string | null;
}): { text: string; applied: { autopilotOffer: boolean; adminBriefing: boolean; journey: boolean } } {
  let text = input.base || '';
  const applied = { autopilotOffer: false, adminBriefing: false, journey: false };
  const offer = input.extras.autopilotOffer || '';
  if (input.role === 'community' && offer) {
    text = text ? `${text}\n\n${offer}` : offer;
    applied.autopilotOffer = true;
  }
  const briefing = input.extras.adminBriefing || '';
  if (input.isAdminRole && briefing) {
    text = text ? `${text}\n\n${briefing}` : briefing;
    applied.adminBriefing = true;
  }
  const journey = input.journeyBlock || '';
  if (journey) {
    text = text ? `${text}${journey}` : journey.trimStart();
    applied.journey = true;
  }
  return { text, applied };
}

/**
 * The Guided Journey standing block for a user (empty for brand-new users).
 * Fail-open to ''.
 */
export async function fetchJourneyStandingBlock(userId: string, lang: string): Promise<string> {
  try {
    const { getSupabase } = await import('../../../lib/supabase');
    const supa = getSupabase() ?? undefined;
    if (!supa || !userId) return '';
    const { fetchGuidedJourney, buildGuidedJourneyStandingInstruction } = await import(
      '../../../services/assistant-continuation/providers/new-day-overview-payload'
    );
    const gj = await fetchGuidedJourney(supa, userId, lang);
    return buildGuidedJourneyStandingInstruction(gj) || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Lesson surface (guided topics)
// ---------------------------------------------------------------------------

export const LESSON_LEARNER_MAX_CHARS = 1_200;
export const LESSON_SNAPSHOT_WAIT_MS = 300;
export const LESSON_LEARNER_HEADER = '=== LEARNER BACKGROUND (reference only) ===';

export function isLessonLearnerContextEnabled(raw: string | undefined = process.env.BRAIN_LESSON_CONTEXT): boolean {
  return raw !== 'false';
}

/**
 * The persona line for a guided-topic lesson. An instruction to the model,
 * never a spoken sentence (NEVER rule 41); English per §13b — the session's
 * LANGUAGE directive decides what language Vitana speaks.
 */
export const LESSON_PERSONA =
  'You are Vitana — the warm, calm voice of the Vitanaland longevity community. You are introducing and teaching one Guided Journey topic. Stay on the lesson you are given.';

/**
 * Pull the learner's verified facts out of a core-snapshot instruction and
 * wrap them as background for a lesson. Only the `## Verified Facts` section
 * is used — the snapshot's rules, goal directives and opener sections would
 * compete with the lesson. Cut at a line boundary. Returns '' when there is
 * nothing to add. Pure.
 */
export function buildLessonLearnerBlock(snapshotInstruction: string | null | undefined, max = LESSON_LEARNER_MAX_CHARS): string {
  if (!snapshotInstruction) return '';
  const facts = splitBootstrapSections(snapshotInstruction).find((s) => s.key === 'verified_facts');
  if (!facts) return '';
  const lines = facts.text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith('- '));
  if (lines.length === 0) return '';
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (kept.length === 0) return '';
  return [
    LESSON_LEARNER_HEADER,
    'What you already know about this learner. Use it only to make the lesson relevant to them; do not recite it, and do not leave the topic.',
    ...kept,
  ].join('\n');
}

export interface LessonContextDeps {
  fetchJourneyBlock?: (userId: string, lang: string) => Promise<string>;
  readSnapshotInstruction?: (tenantId: string, userId: string) => Promise<string | null>;
  snapshotWaitMs?: number;
}

async function defaultReadSnapshotInstruction(tenantId: string, userId: string): Promise<string | null> {
  const m = await import('../../../services/conversation/brain-core-snapshot');
  if (!m.isBrainCoreSnapshotEnabled()) return null;
  const snap = await m.readBrainCoreSnapshot({ tenantId, userId });
  const usable = m.snapshotUsable(snap, { nowMs: Date.now() });
  return usable.ok && snap ? snap.instruction : null;
}

/**
 * The lesson surface's context: persona + journey standing block + learner
 * background. The two reads run in parallel; the snapshot read is bounded
 * (300 ms) so it never delays first audio beyond the journey read.
 */
export async function buildLessonContext(
  req: { userId: string; tenantId?: string | null; lang: string },
  deps: LessonContextDeps = {},
): Promise<{ text: string; learnerChars: number; journey: boolean }> {
  const journeyWork = (deps.fetchJourneyBlock ?? fetchJourneyStandingBlock)(req.userId, req.lang).catch(() => '');
  const learnerWork: Promise<string> = isLessonLearnerContextEnabled() && req.tenantId
    ? Promise.race([
        (deps.readSnapshotInstruction ?? defaultReadSnapshotInstruction)(req.tenantId, req.userId)
          .then((s) => buildLessonLearnerBlock(s))
          .catch(() => ''),
        new Promise<string>((resolve) => {
          const t = setTimeout(() => resolve(''), deps.snapshotWaitMs ?? LESSON_SNAPSHOT_WAIT_MS);
          (t as any).unref?.();
        }),
      ])
    : Promise.resolve('');
  const [journeyBlock, learnerBlock] = await Promise.all([journeyWork, learnerWork]);
  let text = LESSON_PERSONA;
  if (journeyBlock) text = `${text}${journeyBlock}`;
  if (learnerBlock) text = `${text}\n\n${learnerBlock}`;
  return { text, learnerChars: learnerBlock.length, journey: !!journeyBlock };
}

// ---------------------------------------------------------------------------
// Reconnect rebuild
// ---------------------------------------------------------------------------

export interface RebuildableSession {
  identity?: SupabaseIdentity;
  lang: string;
  active_role?: string | null;
  clientContext?: { timezone?: string | null } | null;
  contextBuilder?: ContextBuilderKind;
  contextBrainRole?: string;
  contextExtras?: ContextExtras;
}

/**
 * Rebuild a live session's standing context with the builder and role it
 * started with, re-applying its extras and a fresh journey block. A session
 * with no recorded builder (started before this module) keeps the legacy
 * rebuild it always had.
 */
export async function rebuildSessionContext(
  session: RebuildableSession,
  sessionId: string,
  deps: BaseContextDeps & { isAdminRole: (role: string | null | undefined) => boolean; lesson?: LessonContextDeps; fetchJourneyBlock?: (userId: string, lang: string) => Promise<string> },
): Promise<{ contextInstruction: string; builder: ContextBuilderKind; latencyMs: number; brainError?: string } | null> {
  const identity = session.identity;
  if (!identity) return null;
  const start = Date.now();
  const builder: ContextBuilderKind = session.contextBuilder ?? 'legacy';
  if (builder === 'lesson') {
    const lesson = await buildLessonContext(
      { userId: identity.user_id, tenantId: identity.tenant_id, lang: session.lang },
      deps.lesson,
    );
    return { contextInstruction: lesson.text, builder, latencyMs: Date.now() - start };
  }
  const base = await buildBaseSessionContext(
    {
      identity,
      sessionId,
      brainRole: session.contextBrainRole || 'community',
      timezone: session.clientContext?.timezone,
      useBrain: builder === 'brain',
    },
    deps,
  );
  if (!base.contextInstruction) return null;
  const journeyBlock = await (deps.fetchJourneyBlock ?? fetchJourneyStandingBlock)(identity.user_id, session.lang).catch(() => '');
  const role = session.active_role ?? null;
  const { text } = composeSessionContext({
    base: base.contextInstruction,
    role,
    isAdminRole: deps.isAdminRole(role),
    extras: session.contextExtras ?? {},
    journeyBlock,
  });
  return { contextInstruction: text, builder: base.builder, latencyMs: Date.now() - start, brainError: base.brainError };
}
