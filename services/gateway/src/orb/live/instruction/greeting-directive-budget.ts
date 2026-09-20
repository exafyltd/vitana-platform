/**
 * VTID-04096 — byte budget for the greeting DIRECTIVE (the turn text).
 *
 * `instruction-budget.ts` bounds the system instruction at 30 KB and
 * `vertex-tool-catalog-budget.ts` bounds the tool catalog. The third input to
 * the same first generation request — the greeting directive the wake-brief
 * ladder composes and sends as the turn's own text — had no bound at all, and
 * is the largest of the three on an authenticated session: the
 * `newday_overview` rung renders ~19 KB, against ~551 chars for the
 * `safe_fast_proactive` rung. Production p50 for `greeting_sent` ->
 * `model_start_speaking`, by rung, over 30 days: 5,805 ms for the 19 KB rung
 * (n=42) vs 1,545 ms for the 551-char one (n=42).
 *
 * This module only decides the CEILING. What to do when a directive exceeds
 * it belongs to the rung, because only the rung knows which of its content is
 * situational (keep) and which is tuition (drop) — see
 * `buildNewDayOverviewOpenerLine`.
 *
 * `0` disables the guard, restoring the full directive with no deploy, and an
 * unparseable value resolves to the default rather than to "off": a typo must
 * never silently reinstate the thing being guarded against. That posture is
 * deliberate and is the same mistake that made `FEATURE_LATENCY_TELEMETRY_ENV
 * = "production"` a silent no-op on the live production task definition
 * (VTID-04098).
 */

export const GREETING_DIRECTIVE_BYTE_BUDGET_DEFAULT = 4 * 1024;

export const GREETING_DIRECTIVE_BYTE_BUDGET_ENV = 'ORB_GREETING_DIRECTIVE_BYTE_BUDGET';

export function resolveGreetingDirectiveByteBudget(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[GREETING_DIRECTIVE_BYTE_BUDGET_ENV] || '').trim();
  if (raw === '') return GREETING_DIRECTIVE_BYTE_BUDGET_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return GREETING_DIRECTIVE_BYTE_BUDGET_DEFAULT;
  return n <= 0 ? 0 : Math.floor(n);
}

/**
 * True when `directive` is over budget and a compact variant should be used
 * instead. Measured in UTF-8 bytes of what the socket actually carries, the
 * same unit the sibling instruction and tool-catalog guards budget in — a
 * German directive is meaningfully heavier per character than its char count
 * suggests.
 */
export function greetingDirectiveExceedsBudget(
  directive: string,
  budgetBytes: number = resolveGreetingDirectiveByteBudget(),
): boolean {
  if (budgetBytes <= 0) return false;
  return Buffer.byteLength(directive, 'utf8') > budgetBytes;
}
