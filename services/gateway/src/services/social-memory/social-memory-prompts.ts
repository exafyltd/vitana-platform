/**
 * BOOTSTRAP-SOCIAL-MEMORY — intent detection + prompt formatting.
 *
 * detectSocialIntent(): cheap keyword classifier (same style as the
 * retrieval-router) deciding whether a message needs the Social Context
 * Pack, which sections matter, and whether a specific person was named.
 *
 * formatSocialContextForPrompt(): renders the pack as a <social_context>
 * section for the USER MEMORY CONTEXT block. Written to ENRICH the
 * existing conversation flow: facts + explainable reasons, no directives
 * that compete with the proactive-guide layer.
 */

import {
  SocialContextPack,
  SocialIntentDecision,
  SocialIntentKind,
} from './social-memory-types';

// EN + DE trigger sets (community is German-first).
const TRIGGERS: Array<{ kind: SocialIntentKind; patterns: RegExp }> = [
  { kind: 'follows', patterns: /\b(who (do|am) i follow|wem folge ich|folge ich|my follows|following list)\b/i },
  { kind: 'followers', patterns: /\b(follows? me|my followers|wer folgt mir|meine follower)\b/i },
  { kind: 'messages', patterns: /\b(message[ds]?|nachricht(en)?|geschrieben|chat(ted)?|angeschrieben|texted)\b/i },
  { kind: 'group_chats', patterns: /\b(group ?chats?|gruppenchats?|gruppen(unterhaltung)?|which groups am i)\b/i },
  { kind: 'matches', patterns: /\b(match(es)?|match-?score|kompatibel|good match|passt zu mir)\b/i },
  { kind: 'interesting_posts', patterns: /\b(posts?|beitr(a|ä)g(e|en)?|feed|what.?s new|neuigkeiten)\b/i },
  { kind: 'interesting_events', patterns: /\b(events?|veranstaltung(en)?|meetups?|which events|welche events)\b/i },
  { kind: 'who_to_contact', patterns: /\b(who should i (contact|message|talk|invite|meet)|wen soll(te)? ich (kontaktieren|anschreiben|einladen|treffen))\b/i },
  { kind: 'community_changes', patterns: /\b(what changed|since yesterday|was hat sich (getan|geändert)|was ist passiert|what did i miss)\b/i },
  { kind: 'person_activity', patterns: /\b(latest activit|recent activit|what (did|has) .{2,40} (do|done|been up to)|zuletzt gemacht|letzte[nr]? aktivit)\b/i },
  { kind: 'general_social', patterns: /\b(community|maxina|freund(e|in)?|friends?|people|leute|wichtige personen|important people|network|netzwerk|mission)\b/i },
];

// Words that must never be mistaken for a person name.
const NAME_STOPWORDS = new Set([
  'Vitana', 'Vitanaland', 'Maxina', 'Community', 'Ich', 'Was', 'Wer', 'Wie',
  'The', 'What', 'Who', 'How', 'Tell', 'About', 'Erzähl', 'Über', 'Meine',
  'My', 'Life', 'Compass', 'Index', 'Event', 'Events', 'Match', 'Matches',
  'Group', 'Groups', 'Gruppe', 'Gruppen', 'Post', 'Posts', 'Heute', 'Today',
  'Morgen', 'Deutschland', 'Berlin',
]);

/**
 * Extract a candidate person name: sequences of 2+ capitalized words
 * (e.g. "Mariia Maksina"), or a single capitalized word right after
 * "about/über/von/an/mit/tell me about".
 */
export function extractPersonHint(question: string): string | null {
  if (!question) return null;

  // Multi-word capitalized sequence (most reliable — full names).
  const multi = question.match(/\b([A-ZÄÖÜ][a-zà-üäöüß]+(?:\s+[A-ZÄÖÜ][a-zà-üäöüß]+)+)\b/g);
  if (multi) {
    for (const candidate of multi) {
      const words = candidate.split(/\s+/);
      if (words.every((w) => NAME_STOPWORDS.has(w))) continue;
      const filtered = words.filter((w) => !NAME_STOPWORDS.has(w));
      if (filtered.length >= 2) return filtered.join(' ');
      if (filtered.length === 1 && words.length >= 2) return candidate;
    }
  }

  // Single name after a preposition ("tell me about Mariia", "über Mariia").
  // NOTE: no leading \b — JS word boundaries are ASCII-only and fail
  // before umlauts ("über"), so anchor on whitespace/start instead.
  const single = question.match(
    /(?:^|\s)(?:about|über|ueber|von|mit|an|erzähl(?:e)? mir (?:etwas )?(?:über|von))\s+([A-ZÄÖÜ][a-zà-üäöüß]{2,})/,
  );
  if (single && !NAME_STOPWORDS.has(single[1])) return single[1];

  return null;
}

export function detectSocialIntent(question: string): SocialIntentDecision {
  const kinds: SocialIntentKind[] = [];
  for (const t of TRIGGERS) {
    if (t.patterns.test(question)) kinds.push(t.kind);
  }
  const personHint = extractPersonHint(question);
  if (personHint && !kinds.includes('person_query')) kinds.push('person_query');

  return {
    is_social: kinds.length > 0,
    kinds,
    person_hint: personHint,
  };
}

// =============================================================================
// Prompt formatting
// =============================================================================

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/**
 * Render the Social Context Pack as a prompt section. Placed INSIDE the
 * USER MEMORY CONTEXT block by the memory orchestrator, so the mandatory
 * memory self-check rules already govern how it is used.
 */
export function formatSocialContextForPrompt(pack: SocialContextPack): string {
  let s = `<social_context>\n`;
  s += `Live Maxina Community context for this user (already privacy-filtered — blocked/muted/hidden content is excluded; do not speculate about anything not listed):\n\n`;

  const rel = pack.relationships;
  if (rel.following_count > 0 || rel.followers_count > 0) {
    const followingNames = rel.following.slice(0, 10).map((f) => f.person.display_name || f.person.handle).filter(Boolean);
    const followerNames = rel.followers.slice(0, 10).map((f) => f.person.display_name || f.person.handle).filter(Boolean);
    s += `Follows (${rel.following_count}): ${followingNames.join(', ') || '—'}\n`;
    s += `Followers (${rel.followers_count}): ${followerNames.join(', ') || '—'}\n`;
  } else {
    s += `Follows: none yet. Followers: none yet.\n`;
  }

  if (pack.matches.length > 0) {
    s += `\nMatches (best first):\n`;
    for (const m of pack.matches.slice(0, 6)) {
      const name = m.person.display_name || m.person.handle || 'A member';
      s += `- ${name}${m.score != null ? ` (score ${m.score})` : ''}${m.reasons.length ? ` — ${m.reasons.slice(0, 2).join('; ')}` : ''}${m.conversation_started ? ' [chatting]' : ''}${m.action ? ` [${m.action}]` : ''}\n`;
    }
  }

  if (pack.messages.length > 0) {
    s += `\nRecent chat contacts (last 30 days):\n`;
    for (const c of pack.messages.slice(0, 6)) {
      const name = c.person.display_name || c.person.handle || 'A member';
      s += `- ${name} — last ${c.last_direction} ${fmtDate(c.last_message_at)}, ${c.messages_30d} msg(s)\n`;
    }
  }

  if (pack.group_chats.length > 0) {
    s += `\nGroup chats: ${pack.group_chats
      .map((g) => `${g.name || 'Unnamed'}${g.member_count ? ` (${g.member_count})` : ''}`)
      .join(', ')}\n`;
  }

  if (pack.interesting_posts.length > 0) {
    s += `\nInteresting posts for this user:\n`;
    for (const p of pack.interesting_posts.slice(0, 5)) {
      const author = p.author.display_name || p.author.handle || 'A member';
      s += `- [${p.score}] ${author}: "${p.snippet}" — ${p.reason.slice(0, 2).join('; ')}\n`;
    }
  }

  if (pack.interesting_events.length > 0) {
    s += `\nInteresting events for this user:\n`;
    for (const e of pack.interesting_events.slice(0, 5)) {
      s += `- [${e.score}] ${e.title} (${fmtDate(e.start_time)}${e.location ? `, ${e.location}` : ''}) — ${e.reason.slice(0, 2).join('; ')}${e.url ? `\n  Link: ${e.url}` : ''}\n`;
    }
  }

  if (pack.person_context) {
    const pc = pack.person_context;
    const name = pc.person.display_name || pc.person.handle || 'This member';
    s += `\nPerson in focus — ${name}:\n`;
    s += `- ${pc.relevance_summary}\n`;
    if (pc.privacy_limited) {
      s += `- PRIVACY: profile is private and the user has no connection — share only the name; do NOT speculate about details.\n`;
    } else {
      if (pc.shared_interests.length) s += `- Shared interests: ${pc.shared_interests.join(', ')}\n`;
      if (pc.shared_groups.length) s += `- Shared groups: ${pc.shared_groups.join(', ')}\n`;
      if (pc.shared_events.length) s += `- Shared events: ${pc.shared_events.join(', ')}\n`;
      for (const post of pc.latest_posts.slice(0, 3)) {
        s += `- Recent post (${fmtDate(post.created_at)}): "${post.snippet}"\n`;
      }
      if (pc.last_chat_at) s += `- Last chat with the user: ${fmtDate(pc.last_chat_at)}\n`;
    }
  }

  if (pack.activity_context && pack.activity_context.items.length > 0) {
    const label = pack.activity_context.person
      ? `Recent activity of ${pack.activity_context.person.display_name || 'this member'}`
      : `Recent activity in the user's network (last ${pack.activity_context.window_days} day(s))`;
    s += `\n${label}:\n`;
    for (const item of pack.activity_context.items.slice(0, 8)) {
      s += `- ${fmtDate(item.at)}: ${item.summary}\n`;
    }
  }

  if (pack.recommended_actions.length > 0) {
    s += `\nRecommended next actions (offer at most ONE, woven naturally):\n`;
    for (const a of pack.recommended_actions.slice(0, 3)) {
      s += `- ${a.action} — ${a.reason}\n`;
    }
  }

  if (pack.assistant_system_hints.length > 0) {
    s += `\nGuidance:\n`;
    for (const h of pack.assistant_system_hints) s += `- ${h}\n`;
  }

  s += `</social_context>\n\n`;
  return s;
}

/** Standing hints attached to every social pack. */
export function buildAssistantSystemHints(pack: {
  person_context: SocialContextPack['person_context'];
  matches: SocialContextPack['matches'];
}): string[] {
  const hints: string[] = [
    'Answer social questions ONLY from this social context — never invent people, posts, matches, or events.',
    'When you recommend a post, event, or person, state the reason from the context ("because you follow…", "because it matches…").',
    'Respect privacy: never reveal message contents of other people, and treat privacy-limited profiles as name-only.',
  ];
  if (pack.person_context?.privacy_limited) {
    hints.push('The person in focus has a private profile — politely say details are limited.');
  }
  if (pack.matches.length === 0) {
    hints.push('The user has no active matches — if asked, say so honestly and suggest exploring the community.');
  }
  return hints;
}
