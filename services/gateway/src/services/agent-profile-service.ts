/**
 * VTID-02631 — Phase 7b — Agent Profile Service.
 *
 * Composes a per-user agent profile from the broker MemoryPack and
 * renders it as markdown ready to drop into a brain system prompt.
 * This is the "who is this user, what should I know, what NOT to
 * pitch" digest that the LLM reads at the top of every turn.
 *
 * Plan reference:
 *   /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
 *   Part 9 (Created files, roadmap Phase 7) +
 *   Part 6 default block selection for `open_session` intent
 *
 * No new external dependencies. Pure synthesis over getMemoryContext.
 */

import { getMemoryContext, MemoryPack } from './memory-broker';

const VTID = 'VTID-02631';

export interface AgentProfileInput {
  tenant_id: string;
  user_id: string;
  // Latency budget for the underlying broker call. The synthesis itself is
  // synchronous and fast (string formatting only).
  latency_budget_ms?: number;
  // Maximum profile length in characters. Default 4000 — comfortable fit
  // inside a Gemini system prompt without crowding out the rest of the
  // context pack.
  max_chars?: number;
}

export interface AgentProfile {
  ok: boolean;
  user_id: string;
  tenant_id: string;
  // Markdown digest. Drop this directly into the system prompt above the
  // turn input (it already includes section headings).
  markdown: string;
  // Structured echo of what got synthesized — useful for telemetry, never
  // shipped to the LLM.
  facets: {
    has_identity: boolean;
    has_recent_episode: boolean;
    fact_count: number;
    trajectory_days: number;
    network_people: number;
    location_known: boolean;
    biometric_signals: number;
    diary_entries_14d: number;
    governance_dismissals: number;
  };
  // Source pack for traceability (block kinds + per-stream latency).
  pack_meta: MemoryPack['meta'];
  generated_at: string;
}

/**
 * Build a per-user agent profile.
 *
 * Calls the broker with `intent: 'open_session'` (which by default pulls
 * IDENTITY + EPISODIC + TRAJECTORY + BIOMETRICS + LOCATION + NETWORK +
 * GOVERNANCE). Each section in the rendered markdown maps to one block;
 * empty blocks get omitted. SEMANTIC is added explicitly because the
 * profile depends on the user's stable facts.
 */
export async function buildAgentProfile(
  input: AgentProfileInput
): Promise<AgentProfile> {
  const generatedAt = new Date().toISOString();
  const pack = await getMemoryContext({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    intent: 'open_session',
    channel: 'admin',
    role: 'community',
    latency_budget_ms: input.latency_budget_ms ?? 1500,
    required_blocks: [
      'IDENTITY',
      'SEMANTIC',
      'EPISODIC',
      'TRAJECTORY',
      'BIOMETRICS',
      'LOCATION',
      'NETWORK',
      'GOVERNANCE',
    ],
  });

  if (!pack.ok) {
    return {
      ok: false,
      user_id: input.user_id,
      tenant_id: input.tenant_id,
      markdown: '',
      facets: {
        has_identity: false,
        has_recent_episode: false,
        fact_count: 0,
        trajectory_days: 0,
        network_people: 0,
        location_known: false,
        biometric_signals: 0,
        diary_entries_14d: 0,
        governance_dismissals: 0,
      },
      pack_meta: pack.meta,
      generated_at: generatedAt,
    };
  }

  const blocks = pack.blocks as any;
  const id = blocks.IDENTITY;
  const sem = blocks.SEMANTIC;
  const ep = blocks.EPISODIC;
  const traj = blocks.TRAJECTORY;
  const bio = blocks.BIOMETRICS;
  const loc = blocks.LOCATION;
  const net = blocks.NETWORK;
  const gov = blocks.GOVERNANCE;

  const sections: string[] = [];

  // ---- IDENTITY (always, when present) ----------------------------------
  if (id) {
    const lines: string[] = ['## User Identity'];
    const name = id.preferred_name || id.full_name || id.first_name;
    if (name) lines.push(`- Name: ${name}`);
    if (id.vitana_id) lines.push(`- Vitana ID: ${id.vitana_id}`);
    if (id.date_of_birth) lines.push(`- Date of birth: ${id.date_of_birth}`);
    if (id.locale) lines.push(`- Locale: ${id.locale}`);
    if (id.email) lines.push(`- Email on file: ${id.email}`);
    sections.push(lines.join('\n'));
  }

  // ---- SEMANTIC FACTS (max 12, ordered by asserted_at desc) -------------
  if (sem && Array.isArray(sem.facts) && sem.facts.length > 0) {
    const lines: string[] = ['## What the user has told us (semantic facts)'];
    const top = sem.facts.slice(0, 12);
    for (const f of top) {
      const conf = typeof f.confidence === 'number' ? ` (${(f.confidence * 100).toFixed(0)}%)` : '';
      lines.push(`- **${f.fact_key}** = ${truncate(f.fact_value, 160)}${conf}`);
    }
    if (sem.facts.length > top.length) {
      lines.push(`- _(${sem.facts.length - top.length} more semantic facts in memory)_`);
    }
    sections.push(lines.join('\n'));
  }

  // ---- LIFE TRAJECTORY (Vitana Index last 30d) --------------------------
  if (traj && Array.isArray(traj.days) && traj.days.length > 0) {
    const lines: string[] = ['## Vitana Index trajectory (last 30 days)'];
    const latest = traj.latest_total ?? traj.days[traj.days.length - 1]?.score_total ?? null;
    const earliest = traj.days[0]?.score_total ?? null;
    if (latest !== null) lines.push(`- Latest total: ${latest}`);
    if (earliest !== null && latest !== null && earliest !== latest) {
      const delta = latest - earliest;
      const arrow = delta > 0 ? '↑' : (delta < 0 ? '↓' : '→');
      lines.push(`- 30-day movement: ${earliest} → ${latest} (${arrow} ${Math.abs(delta)})`);
    }
    lines.push(`- Days with data: ${traj.days.length}`);
    sections.push(lines.join('\n'));
  }

  // ---- LOCATION (if known) ----------------------------------------------
  if (loc) {
    const cur = loc.current;
    if (cur) {
      const lines: string[] = ['## Location'];
      const where = [cur.locality, cur.country].filter(Boolean).join(', ');
      lines.push(`- Currently: ${where || cur.location_type} (${cur.timezone})`);
      lines.push(`- Source: ${cur.source}`);
      sections.push(lines.join('\n'));
    } else if (Array.isArray(loc.named_places) && loc.named_places.length > 0) {
      const lines: string[] = ['## Known places'];
      for (const p of loc.named_places.slice(0, 5)) {
        const where = [p.locality, p.country].filter(Boolean).join(', ');
        lines.push(`- ${p.name}${where ? ` — ${where}` : ''}${p.user_confirmed ? '' : ' (unconfirmed)'}`);
      }
      sections.push(lines.join('\n'));
    }
  }

  // ---- BIOMETRICS (current trends + active anomalies) -------------------
  if (bio) {
    const trends = Array.isArray(bio.trends) ? bio.trends : [];
    const events = Array.isArray(bio.events) ? bio.events : [];
    if (trends.length > 0 || events.length > 0) {
      const lines: string[] = ['## Health signals'];
      // Highlight anomalies first
      const anomalies = trends.filter((t: any) => t.anomaly_flag);
      for (const t of anomalies.slice(0, 5)) {
        lines.push(`- ⚠ ${t.feature_key} (${t.pillar}): ${t.trend_class}, latest ${t.latest}`);
      }
      const stable = trends.filter((t: any) => !t.anomaly_flag).slice(0, 5);
      for (const t of stable) {
        lines.push(`- ${t.feature_key} (${t.pillar}): ${t.trend_class}, latest ${t.latest}`);
      }
      if (events.length > 0) {
        lines.push('### Active biometric events');
        for (const e of events.slice(0, 5)) {
          lines.push(`- ${e.event_type} on ${e.feature_key} at ${e.observed_at?.slice(0, 10)}`);
        }
      }
      sections.push(lines.join('\n'));
    }
  }

  // ---- NETWORK (closest people) -----------------------------------------
  if (net && Array.isArray(net.people) && net.people.length > 0) {
    const lines: string[] = ['## Closest people'];
    for (const p of net.people.slice(0, 8)) {
      const name = p.display_name ?? '(unnamed)';
      const strength = typeof p.strength === 'number' ? ` (${(p.strength * 100).toFixed(0)}%)` : '';
      lines.push(`- ${name} — ${p.edge_type}${strength}`);
    }
    sections.push(lines.join('\n'));
  }

  // ---- RECENT THEMES (top 5 episodic hits) ------------------------------
  if (ep && Array.isArray(ep.hits) && ep.hits.length > 0) {
    const lines: string[] = ['## Recent conversations (top 5)'];
    for (const h of ep.hits.slice(0, 5)) {
      const date = h.occurred_at ? h.occurred_at.slice(0, 10) : '';
      const speaker = h.actor_id || 'user';
      lines.push(`- [${date}] (${speaker}) ${truncate(h.content || '', 140)}`);
    }
    sections.push(lines.join('\n'));
  }

  // ---- DON'T PITCH (governance dismissals) ------------------------------
  if (gov && Array.isArray(gov.dismissals) && gov.dismissals.length > 0) {
    const lines: string[] = ['## Do NOT pitch (recently dismissed)'];
    for (const d of gov.dismissals.slice(0, 10)) {
      lines.push(`- ${d.reason}: ${truncate(d.title || '', 100)} (${d.domain ?? 'general'})`);
    }
    sections.push(lines.join('\n'));
  }

  // Compose the final markdown, then truncate to max_chars.
  const maxChars = input.max_chars ?? 4000;
  let md = sections.join('\n\n');
  if (md.length > maxChars) {
    md = md.slice(0, maxChars - 32) + '\n\n_(profile truncated at limit)_';
  }

  return {
    ok: true,
    user_id: input.user_id,
    tenant_id: input.tenant_id,
    markdown: md,
    facets: {
      has_identity: !!id,
      has_recent_episode: !!(ep?.hits?.length),
      fact_count: sem?.facts?.length ?? 0,
      trajectory_days: traj?.days?.length ?? 0,
      network_people: net?.people?.length ?? 0,
      location_known: !!loc?.current,
      biometric_signals: (bio?.trends?.length ?? 0) + (bio?.events?.length ?? 0),
      diary_entries_14d: 0, // DIARY block not pulled by open_session intent
      governance_dismissals: gov?.dismissals?.length ?? 0,
    },
    pack_meta: pack.meta,
    generated_at: generatedAt,
  };
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
