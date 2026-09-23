/**
 * VTID-04349: shadow delivery mode for the community automation engine.
 *
 * Staging and production share one database, so an automation run on the
 * staging gateway reaches the same real members a production run does. That
 * made it impossible to bring the engine back and verify it on staging
 * without notifying people. Shadow mode lets a run execute end to end against
 * real data while nothing leaves the building:
 *
 *   - ctx.notify records the notification instead of sending it;
 *   - ctx.supabase is wrapped: reads pass through, every insert / update /
 *     upsert / delete and every RPC is recorded and skipped;
 *   - handlers that reach a path the wrapper cannot see (an HTTP call to the
 *     scheduled-notifications routes, or a lazily imported service that opens
 *     its own client or calls an external API) are not run at all, and the
 *     run records why.
 *
 * AUTOMATIONS_DELIVERY_MODE: unset or 'live' keeps today's behaviour
 * (production is unchanged by this file). Any other explicit value, a typo
 * included, resolves to 'shadow', so a mistyped staging pin fails safe.
 */

export type AutomationDeliveryMode = 'live' | 'shadow';

export function resolveAutomationDeliveryMode(
  env: Record<string, string | undefined> = process.env,
): AutomationDeliveryMode {
  const raw = env.AUTOMATIONS_DELIVERY_MODE;
  if (raw === undefined || raw === '' || raw === 'live') return 'live';
  return 'shadow';
}

/**
 * Handlers that reach members (or external services) through something other
 * than ctx.notify / ctx.supabase. Shadow mode never runs these.
 * test/vtid-04349-automation-shadow.test.ts recomputes this set from the
 * handler sources and fails the build if a new handler of that kind is added
 * without being listed here.
 */
export const SHADOW_UNSAFE_HANDLERS: ReadonlySet<string> = new Set([
  // community-groups: recommendation-engine (own client)
  'runWelcomeSquad',
  // engagement-events: POSTs to /scheduled-notifications/*, milestone-service
  'runGraduatedReminders',
  'runMorningBriefing',
  'runWeeklyCommunityDigest',
  'runMilestoneCelebration',
  'runDiaryReminderSocial',
  'runWeeklyReflection',
  'runMilestoneScanner',
  'runUpcomingEventsToday',
  // memory-intelligence: pattern-extractor / memory-facts-service /
  // user-model-synthesis / orb-memory-bridge (own clients, LLM + embeddings)
  'runRoutinePatternExtraction',
  'runMemoryEmbeddingBackfill',
  'runUserModelSynthesis',
  'runOwnPostMemoryCapture',
  // onboarding-growth: recommendation-engine, social-connect-service
  // (posts to members' own social accounts), milestone-service
  'runOrbGuidedOnboarding',
  'runSocialAccountConnect',
  'runAutoShareToSocial',
  // platform-operations: HTTP call
  'runPostDeployHealthCheck',
]);

export interface ShadowRecorder {
  writes: Array<{ table: string; op: string }>;
  rpcs: string[];
  notifications: Array<{ user_id: string; type: string; title: string }>;
}

export function createShadowRecorder(): ShadowRecorder {
  return { writes: [], rpcs: [], notifications: [] };
}

const WRITE_OPS = new Set(['insert', 'update', 'upsert', 'delete']);
const EMPTY_RESULT = Object.freeze({ data: null, error: null, count: 0, status: 200, statusText: 'shadow' });

/**
 * A query builder that accepts any chained call (.eq, .select, .single, ...)
 * and resolves to an empty, error-free result. Returned for every skipped
 * write and RPC so handler code runs on without touching the database.
 */
export function noopQueryBuilder(): any {
  const target = function noop() { /* callable */ };
  const proxy: any = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(EMPTY_RESULT);
      if (prop === 'catch') return () => Promise.resolve(EMPTY_RESULT);
      if (prop === 'finally') return (fn?: () => void) => { if (fn) fn(); return Promise.resolve(EMPTY_RESULT); };
      return () => proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}

function shadowTable(builder: any, table: string, rec: ShadowRecorder): any {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRITE_OPS.has(prop)) {
        return () => { rec.writes.push({ table, op: prop }); return noopQueryBuilder(); };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** Wrap a Supabase client: reads pass through, writes and RPCs are recorded. */
export function createShadowSupabase(real: any, rec: ShadowRecorder): any {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'from') return (table: string) => shadowTable(target.from(table), table, rec);
      if (prop === 'rpc') return (name: string) => { rec.rpcs.push(name); return noopQueryBuilder(); };
      if (prop === 'schema') return (s: string) => createShadowSupabase(target.schema(s), rec);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function summarizeShadow(rec: ShadowRecorder): Record<string, unknown> {
  const writes: Record<string, number> = {};
  for (const w of rec.writes) writes[`${w.op}:${w.table}`] = (writes[`${w.op}:${w.table}`] || 0) + 1;
  const types: Record<string, number> = {};
  for (const n of rec.notifications) types[n.type] = (types[n.type] || 0) + 1;
  return {
    suppressed_writes: writes,
    suppressed_rpcs: rec.rpcs,
    suppressed_notifications: rec.notifications.length,
    suppressed_notification_types: types,
    sample_recipients: rec.notifications.slice(0, 5).map((n) => n.user_id.slice(0, 8)),
  };
}
