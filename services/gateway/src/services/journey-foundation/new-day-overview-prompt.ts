/**
 * VTID-03255 — new-day overview prompt (P3).
 *
 * Renders the morning greeting as a STRUCTURAL block (required elements +
 * facts), not a verbatim script — consistent with journey-greeting.ts, so the
 * model phrases it naturally and never recites a template. The single proactive
 * move it names is the snapshot's current_next_step, so Vitana always drives the
 * journey and the user has no space to diverge.
 */

import type { NewDayOverviewPayload } from './new-day-overview-payload';
import { getStepDef } from './foundation-steps';

export interface MorningOverviewOpts {
  userName?: string | null;
}

/** The "Seit dem letzten Gespräch erledigt: …" data for the screen + greeting. */
export function sinceLastSummary(payload: NewDayOverviewPayload): string | null {
  const last = payload.last_session_update;
  if (!last || !last.completed_steps?.length) return null;
  const titles = last.completed_steps.map((k) => getStepDef(k)?.title ?? k);
  return titles.join(', ');
}

/**
 * A structural prompt block for the morning greeting. Returns null when the
 * journey hasn't started (the gate greeting handles that case).
 */
export function renderMorningOverviewBlock(
  payload: NewDayOverviewPayload,
  opts: MorningOverviewOpts = {},
): string | null {
  const s = payload.snapshot;
  if (!s.journey_started) return null;

  const next = s.current_next_step;
  const nextDef = next ? getStepDef(next.key) : null;
  const since = sinceLastSummary(payload);
  const name = opts.userName?.trim();

  const lines: string[] = [
    '## MORNING JOURNEY OVERVIEW (VTID-03255)',
    'Open warmly and lead the journey. Phrase naturally — do NOT recite. Required elements, in order:',
    `  1. A morning greeting${name ? ` to ${name}` : ''}.`,
  ];
  if (since) {
    lines.push(`  2. One line acknowledging what was completed since you last spoke: ${since}.`);
  }
  lines.push(
    `  ${since ? 3 : 2}. Where they are: Day ${s.goal_day ?? 1}${
      s.days_left != null ? ` with ${s.days_left} days left` : ''
    }${s.north_stars.health ? ` toward "${s.north_stars.health}"` : ''}.`,
  );
  if (next) {
    lines.push(
      `  ${since ? 4 : 3}. The single strongest next move: ${next.title} — ${next.benefit}`,
    );
    if (nextDef) {
      lines.push(`     Drive it with this intent (adapt, don't quote): "${nextDef.execute_prompt}"`);
    }
    if (next.navigation_route) {
      lines.push(`     Offer to open ${next.navigation_route} for them.`);
    }
  }
  lines.push(
    'Keep it to a few sentences. Name only the ONE next move — never list the whole path.',
  );
  return lines.join('\n');
}
