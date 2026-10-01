/**
 * VTID-04784: memory plan phase 2 — compare the two ORB memory read paths on
 * real sessions before production voice moves to recall().
 *
 * Production voice reads memory through the legacy six-table read in
 * orb-memory-bridge.ts; staging reads through recall() (VTID-04452,
 * MEMORY_ORB_RECALL_ENABLED). Flipping production needs evidence that both
 * give the model the same memory, and staging has too few sessions to say.
 *
 * With MEMORY_ORB_RECALL_SHADOW=true the bridge keeps serving the path it
 * serves today and, after answering, reads the OTHER path in the background.
 * The two results are compared and one line is logged per session:
 *
 *   [VTID-04784] recall-shadow served=legacy shadow=recall facts=12/12
 *     only_served=0 only_shadow=1 value_diff=0 ai_memory=3/0 other=9/7
 *     chars=4120/3987 ms=210/140
 *
 * Counts only — never a fact key, value or any member text (the log is not a
 * place for member data). The shadow read is never awaited by the session,
 * never throws, and is read-only: both paths only SELECT.
 *
 * scripts/memory/recall-shadow-report.sh summarises the lines from CloudWatch.
 */

/** The parts of an ORB memory context the comparison needs. */
export interface ShadowComparableContext {
  ok: boolean;
  items: Array<{
    id: string;
    source: string;
    content_json?: Record<string, unknown> | null;
  }>;
  formatted_context: string;
}

export type ReadPath = 'legacy' | 'recall';

export interface RecallShadowComparison {
  served: ReadPath;
  shadow: ReadPath;
  facts_served: number;
  facts_shadow: number;
  facts_only_served: number;
  facts_only_shadow: number;
  facts_value_diff: number;
  ai_memory_served: number;
  ai_memory_shadow: number;
  other_served: number;
  other_shadow: number;
  chars_served: number;
  chars_shadow: number;
  ms_served: number;
  ms_shadow: number;
  shadow_ok: boolean;
}

export function isRecallShadowEnabled(): boolean {
  return process.env.MEMORY_ORB_RECALL_SHADOW === 'true';
}

function factsOf(ctx: ShadowComparableContext): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of ctx.items) {
    if (item.source !== 'memory_facts') continue;
    const key = String(item.content_json?.fact_key ?? '').trim().toLowerCase();
    if (!key) continue;
    if (!out.has(key)) out.set(key, String(item.content_json?.fact_value ?? '').trim());
  }
  return out;
}

function countBy(ctx: ShadowComparableContext): { ai_memory: number; other: number } {
  let ai = 0;
  let other = 0;
  for (const item of ctx.items) {
    if (item.source === 'memory_facts') continue;
    if (item.source === 'ai_memory') ai++;
    else other++;
  }
  return { ai_memory: ai, other };
}

/** Pure: compare the served context with the shadow one. */
export function compareMemoryContexts(
  served: ShadowComparableContext,
  shadow: ShadowComparableContext,
  meta: { served: ReadPath; ms_served: number; ms_shadow: number },
): RecallShadowComparison {
  const fs = factsOf(served);
  const fh = factsOf(shadow);
  let onlyServed = 0;
  let valueDiff = 0;
  for (const [key, value] of fs) {
    if (!fh.has(key)) onlyServed++;
    else if (fh.get(key) !== value) valueDiff++;
  }
  let onlyShadow = 0;
  for (const key of fh.keys()) if (!fs.has(key)) onlyShadow++;
  const cs = countBy(served);
  const ch = countBy(shadow);
  return {
    served: meta.served,
    shadow: meta.served === 'legacy' ? 'recall' : 'legacy',
    facts_served: fs.size,
    facts_shadow: fh.size,
    facts_only_served: onlyServed,
    facts_only_shadow: onlyShadow,
    facts_value_diff: valueDiff,
    ai_memory_served: cs.ai_memory,
    ai_memory_shadow: ch.ai_memory,
    other_served: cs.other,
    other_shadow: ch.other,
    chars_served: served.formatted_context.length,
    chars_shadow: shadow.formatted_context.length,
    ms_served: meta.ms_served,
    ms_shadow: meta.ms_shadow,
    shadow_ok: shadow.ok,
  };
}

export function formatShadowLine(c: RecallShadowComparison): string {
  return (
    `[VTID-04784] recall-shadow served=${c.served} shadow=${c.shadow} ok=${c.shadow_ok} ` +
    `facts=${c.facts_served}/${c.facts_shadow} only_served=${c.facts_only_served} ` +
    `only_shadow=${c.facts_only_shadow} value_diff=${c.facts_value_diff} ` +
    `ai_memory=${c.ai_memory_served}/${c.ai_memory_shadow} other=${c.other_served}/${c.other_shadow} ` +
    `chars=${c.chars_served}/${c.chars_shadow} ms=${c.ms_served}/${c.ms_shadow}`
  );
}

/**
 * Read the other path and log the comparison. Never throws, never awaited by
 * the session. `readOther` must be read-only.
 */
export function runRecallShadow(
  served: ShadowComparableContext,
  meta: { served: ReadPath; ms_served: number },
  readOther: () => Promise<ShadowComparableContext>,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const t0 = Date.now();
  return readOther()
    .then((shadow) => {
      log(formatShadowLine(compareMemoryContexts(served, shadow, { ...meta, ms_shadow: Date.now() - t0 })));
    })
    .catch((err: any) => {
      log(`[VTID-04784] recall-shadow served=${meta.served} failed: ${err?.message ?? err}`);
    });
}
