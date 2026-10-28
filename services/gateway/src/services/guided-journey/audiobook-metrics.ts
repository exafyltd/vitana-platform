/**
 * VTID-04763 — Audiobook measurement.
 *
 * Computes the four numbers the Audiobook initiative is judged by, from the
 * product-analytics events the player sends (feature_key 'audiobook'):
 *
 *   listen_through_rate     finished tracks / started tracks
 *   season0_completion      listeners who finished all six Prolog episodes
 *                           / listeners
 *   day7_return_rate        of listeners whose first play was at least 7 days
 *                           before the end of the window, the share who
 *                           listened again on day 7-13 after that first play
 *   listen_to_action_rate   listeners who finished an episode and then took a
 *                           first step (Try it now, or Ask Vitana) / listeners
 *                           who finished an episode
 *
 * Users are counted by `user_id_hash` (the pipeline never stores user ids).
 * Pure function: the route feeds it rows, tests feed it fixtures.
 */

export const AUDIOBOOK_FEATURE_KEY = 'audiobook';
export const PROLOG_EPISODES = 6;

export interface AudiobookEventRow {
  event_name: string;
  user_id_hash: string | null;
  properties: Record<string, unknown> | null;
  occurred_at: string;
}

export interface AudiobookMetrics {
  listeners: number;
  tracks_started: number;
  tracks_completed: number;
  listen_through_rate: number;
  episodes_completed: number;
  season0_completed_listeners: number;
  season0_completion: number;
  day7_cohort: number;
  day7_returned: number;
  day7_return_rate: number;
  finished_an_episode: number;
  took_first_action: number;
  listen_to_action_rate: number;
  top_episodes: Array<{ episode: number; completions: number }>;
}

const DAY = 86_400_000;

function rate(n: number, d: number): number {
  return d > 0 ? Number((n / d).toFixed(4)) : 0;
}

export function computeAudiobookMetrics(
  events: readonly AudiobookEventRow[],
  windowEnd: Date = new Date(),
): AudiobookMetrics {
  const sorted = [...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const firstPlay = new Map<string, number>();
  const activeTimes = new Map<string, number[]>();
  const prologDone = new Map<string, Set<number>>();
  const firstEpisodeDone = new Map<string, number>();
  const actedAfter = new Set<string>();
  const episodeCounts = new Map<number, number>();
  let tracksStarted = 0;
  let tracksCompleted = 0;
  let episodesCompleted = 0;

  for (const ev of sorted) {
    const user = ev.user_id_hash;
    const at = Date.parse(ev.occurred_at);
    const props = ev.properties ?? {};
    switch (ev.event_name) {
      case 'audiobook_play_started':
        if (user && !firstPlay.has(user)) firstPlay.set(user, at);
        break;
      case 'audiobook_track_started':
        tracksStarted++;
        break;
      case 'audiobook_track_completed':
        tracksCompleted++;
        break;
      case 'audiobook_episode_completed': {
        episodesCompleted++;
        const episode = Number(props.episode);
        if (Number.isInteger(episode)) episodeCounts.set(episode, (episodeCounts.get(episode) ?? 0) + 1);
        if (user) {
          if (!firstEpisodeDone.has(user)) firstEpisodeDone.set(user, at);
          if (props.chapter_id === 'prolog' && Number.isInteger(episode)) {
            const set = prologDone.get(user) ?? new Set<number>();
            set.add(episode);
            prologDone.set(user, set);
          }
        }
        break;
      }
      case 'audiobook_try_it_now':
      case 'audiobook_ask_vitana':
        if (user && firstEpisodeDone.has(user) && at >= firstEpisodeDone.get(user)!) actedAfter.add(user);
        break;
      default:
        break;
    }
    if (user && ev.event_name.startsWith('audiobook_')) {
      const list = activeTimes.get(user) ?? [];
      list.push(at);
      activeTimes.set(user, list);
    }
  }

  const listeners = firstPlay.size;
  const season0Completed = [...prologDone.values()].filter((s) => s.size >= PROLOG_EPISODES).length;

  let cohort = 0;
  let returned = 0;
  const end = windowEnd.getTime();
  for (const [user, first] of firstPlay) {
    if (end - first < 7 * DAY) continue;
    cohort++;
    const times = activeTimes.get(user) ?? [];
    if (times.some((t) => t >= first + 7 * DAY && t < first + 14 * DAY)) returned++;
  }

  return {
    listeners,
    tracks_started: tracksStarted,
    tracks_completed: tracksCompleted,
    listen_through_rate: rate(tracksCompleted, tracksStarted),
    episodes_completed: episodesCompleted,
    season0_completed_listeners: season0Completed,
    season0_completion: rate(season0Completed, listeners),
    day7_cohort: cohort,
    day7_returned: returned,
    day7_return_rate: rate(returned, cohort),
    finished_an_episode: firstEpisodeDone.size,
    took_first_action: actedAfter.size,
    listen_to_action_rate: rate(actedAfter.size, firstEpisodeDone.size),
    top_episodes: [...episodeCounts.entries()]
      .map(([episode, completions]) => ({ episode, completions }))
      .sort((a, b) => b.completions - a.completions || a.episode - b.episode)
      .slice(0, 20),
  };
}
