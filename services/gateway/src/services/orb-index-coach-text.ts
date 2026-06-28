/**
 * Speakable text builders for the ORB "improve my Index" coaching tools.
 *
 * The live model is handed ONLY a tool result's spoken text. Two real failures
 * came from that:
 *   - get_index_improvement_suggestions returned raw JSON with an empty list when
 *     the user had no queued autopilot recommendations → the model narrated
 *     "Das konnte ich nicht abschließen" (offer-then-fail).
 *   - create_index_improvement_plan wrote 6 calendar events but only said
 *     "Scheduled 6 actions" → the user had "keine Ahnung" what was added.
 *
 * These builders make both tools return concrete, presentable content with an
 * explicit anti-fake-fail guard, and (for the plan) force the assistant to NAME
 * exactly what it put on the calendar so nothing happens to the user opaquely.
 */

/** Suggestions on how to lift a pillar — never empty, never JSON, never a fake-fail. */
export function buildIndexSuggestionsText(
  pillar: string,
  items: Array<{ title?: string | null; description?: string | null }>,
): string {
  const lines = items
    .slice(0, 6)
    .map((it, i) => {
      const t = String(it.title ?? '').trim() || 'an action';
      const d = String(it.description ?? '').trim();
      return `${i + 1}) ${t}${d ? ` — ${d}` : ''}`;
    })
    .join('; ');
  if (!lines) {
    return (
      `HANDLED — no specific ${pillar} suggestions are queued yet. Tell the user warmly that completing ` +
      `any current recommendation unlocks more, and offer to build a starter ${pillar} plan now. ` +
      `Do NOT say you could not do it.`
    );
  }
  return (
    `SUCCESS — concrete ways to lift the user's ${pillar} pillar (their weakest): ${lines}. ` +
    `Present these warmly as suggestions and offer to build them into a plan on the calendar. ` +
    `Do NOT say you could not do it.`
  );
}

/** Confirmation of a written plan that NAMES each scheduled activity (transparency). */
export function buildIndexPlanText(
  pillar: string,
  days: number,
  scheduled: Array<{ title?: string | null; start_time?: string | null }>,
): string {
  const list = scheduled
    .slice(0, 8)
    .map((s, i) => {
      const t = String(s.title ?? '').trim() || 'an activity';
      const day = s.start_time ? String(s.start_time).slice(0, 10) : '';
      return `${i + 1}) ${t}${day ? ` (${day})` : ''}`;
    })
    .join('; ');
  const n = scheduled.length;
  return (
    `SUCCESS — ${n} ${pillar} action${n === 1 ? '' : 's'} added to the calendar over the next ${days} days. ` +
    `Tell the user EXACTLY what was added so they know what is in their calendar — name each one: ${list}. ` +
    `Then offer to adjust or remove any of them. Do NOT just say "I added some things" — name them.`
  );
}
