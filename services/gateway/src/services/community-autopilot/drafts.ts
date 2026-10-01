/**
 * VTID-04504 (Community Autopilot CA-4): "create with me" and "connect" drafts.
 *
 * Some suggestions carry text the member publishes or sends: a news-feed post,
 * a Media Hub caption, a message to a contact. Vitanaland drafts that text so
 * the member only has to look at it and agree. The draft is written by Claude
 * on Bedrock (the `memory` routing stage, Bedrock-primary) from an English
 * INTENT, in the member's own language, and stored on the suggestion's action
 * so the app preview, the voice read-back and the execution all see the same
 * words.
 *
 * Owner decision 1 (2026-09-24) decides where each draft may be sent from:
 *   - post_to_feed: public, so ONLY from the app preview. A voice "yes" never
 *     publishes a post; the draft waits in the app.
 *   - send_chat_message: by voice only after Vitana read the draft back and the
 *     member confirmed; from the app after the preview.
 *   - media_upload: the member picks the file in the app; the caption is a draft.
 * The diary stays in the member's own words and is never drafted here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RecommendationAction } from './action-registry';

export const DRAFTABLE_KINDS = new Set(['post_to_feed', 'send_chat_message', 'media_upload']);

/** Where each kind keeps its text inside `action.params`. */
export function draftFieldFor(kind: string): 'draft' | 'body' | 'caption' | null {
  if (kind === 'post_to_feed') return 'draft';
  if (kind === 'send_chat_message') return 'body';
  if (kind === 'media_upload') return 'caption';
  return null;
}

export const DRAFT_MAX_CHARS: Record<string, number> = {
  post_to_feed: 1000,
  send_chat_message: 600,
  media_upload: 300,
};

export function currentDraft(action: RecommendationAction): string {
  const field = draftFieldFor(action.kind);
  if (!field) return '';
  const v = action.params?.[field];
  return typeof v === 'string' ? v.trim() : '';
}

/** A copy of the action with the member's (or the model's) text in place. */
export function withDraft(action: RecommendationAction, text: string): RecommendationAction {
  const field = draftFieldFor(action.kind);
  if (!field) return action;
  return { ...action, params: { ...(action.params ?? {}), [field]: text } };
}

/**
 * Clean model or member text: no wrapping quotes, no markdown fences, no
 * leading label ("Post:"), bounded length.
 */
export function sanitizeDraft(kind: string, raw: string): string {
  let t = (raw ?? '').replace(/```[a-z]*\n?|```/gi, '').trim();
  t = t.replace(/^(draft|post|message|caption|nachricht|beitrag)\s*:\s*/i, '');
  const q = t.match(/^["“„«'](.*)["”«»']$/s);
  if (q) t = q[1].trim();
  const max = DRAFT_MAX_CHARS[kind] ?? 600;
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
  }
  return t;
}

export interface DraftSubject {
  title: string;
  summary: string | null;
  action: RecommendationAction;
}

/**
 * The English intent the model writes from (NEVER-rule 41: we state the
 * intent, the model composes the words). Facts the suggestion carries are
 * passed as data, never as finished sentences to repeat.
 */
export function buildDraftIntent(s: DraftSubject): string {
  const p = s.action.params ?? {};
  const facts = [
    `Suggestion title: ${s.title}`,
    s.summary ? `Suggestion summary: ${s.summary}` : '',
    typeof p.topic === 'string' && p.topic ? `Topic: ${p.topic}` : '',
    typeof p.recipient_label === 'string' && p.recipient_label ? `Recipient: ${p.recipient_label}` : '',
    typeof p.context === 'string' && p.context ? `Context: ${p.context}` : '',
  ].filter(Boolean).join('\n');

  const task =
    s.action.kind === 'post_to_feed'
      ? 'Write a short community news-feed post the member could publish about this. First person, warm and genuine, 2-4 sentences, at most one emoji, no hashtags spam (at most two), no health claims, no promises about results.'
      : s.action.kind === 'send_chat_message'
        ? 'Write a short, friendly personal message the member could send to the recipient about this. First person, 1-3 sentences, addressed to the recipient by first name if known, no pressure, no sales tone.'
        : 'Write a short caption for a photo or video the member is about to share about this. First person, one or two sentences, at most one emoji.';

  return `${task}
Write only the text itself: no quotes around it, no label, no explanation, no alternatives.
Do not invent facts that are not in the data below.

${facts}`;
}

export interface GenerateDraftResult {
  ok: boolean;
  text?: string;
  error?: string;
  provider?: string;
  model?: string;
}

/** Ask the router for a draft in the member's language. Never throws. */
export async function generateDraft(
  sb: SupabaseClient,
  userId: string,
  subject: DraftSubject,
): Promise<GenerateDraftResult> {
  try {
    const [{ getUserLocale }, { buildLocalizedSystemPrompt }, { callViaRouter }] = await Promise.all([
      import('../../i18n/server-locale'),
      import('../../i18n/llm-locale'),
      import('../llm-router'),
    ]);
    const locale = await getUserLocale(sb, userId);
    const systemPrompt = buildLocalizedSystemPrompt(
      'You help a member of the Vitanaland longevity community write short texts in their own voice. Keep it natural and personal.',
      locale,
    );
    const r = await callViaRouter('memory', buildDraftIntent(subject), {
      service: 'community-autopilot-draft',
      systemPrompt,
      maxTokens: 400,
    });
    if (!r.ok || !r.text) return { ok: false, error: r.error || 'empty draft' };
    const text = sanitizeDraft(subject.action.kind, r.text);
    if (!text) return { ok: false, error: 'empty draft' };
    return { ok: true, text, provider: r.provider, model: (r as { model?: string }).model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
