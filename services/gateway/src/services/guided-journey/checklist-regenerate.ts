/**
 * VTID-03288 — Guided Journey checklist AI regeneration engine.
 *
 * One engine, two surfaces:
 *   1. Bulk v1 build — drive regenerateSession() across all 90 sessions to
 *      auto-author the entire German first version.
 *   2. Ongoing supervisor edits — the Command Hub Checklist editor calls
 *      regenerateTopic()/regenerateSession() with freeform instructions to
 *      rewrite a single topic or a whole session.
 *
 * It writes ONLY the German teaching prose (vitana_voice_script + the four
 * explanation_* fields) via the existing audited updateTopic() path. The
 * practice-loop fields (guided_practice_target / practice_action_type /
 * completion_event) are grounding, set deterministically elsewhere, and are
 * never touched here — so regenerating prose can't break the practice loop.
 *
 * Grounding: the topic's mapped Maxina instruction-manual chapter (so prose
 * traces to real features, not hallucinations) + its session siblings (so a
 * session reads as one coherent lesson) + a fixed German term glossary.
 *
 * Provider: routed via the 'planner' stage (Vertex Gemini Pro on Cloud Run
 * ADC) — reliable server-side and strong at German. Structured output is
 * forced through a tool schema so the model can't drift from the contract.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callViaRouter } from '../llm-router';
import type { LLMStage } from '../../constants/llm-defaults';
import { getTopic, listTopics, updateTopic } from './checklist-service';
import type { ChecklistTopic } from '../../types/journey-checklist';

const STAGE: LLMStage = 'planner';
const CONTENT_FIELDS = ['whatItIs', 'userBenefit', 'whenToUse', 'tryThis', 'vitanaVoiceScript'] as const;

export interface RegenerateOpts {
  /** Freeform supervisor instructions appended to the base German contract. */
  instructions?: string;
  /** Output language. Only 'de' is authored today; reserved for the EN pass. */
  language?: string;
  curriculumVersion?: string;
}

export interface GeneratedContent {
  whatItIs: string;
  userBenefit: string;
  whenToUse: string;
  tryThis: string;
  vitanaVoiceScript: string;
}

// ---------------------------------------------------------------------------
// Style contract + glossary. Written in English (the model reads English
// instructions best — see CLAUDE.md §13b) but the OUTPUT must be German.
// ---------------------------------------------------------------------------

const GLOSSARY = `CANONICAL GERMAN TERMS — use these exact words, never translate or invent variants:
- Vitanaland (the ecosystem) — keep as "Vitanaland"
- Maxina Community — keep as "Maxina-Community"
- Vitana / die Assistentin Vitana (the assistant) — keep the name "Vitana"
- ORB — keep as "ORB" (the round voice button)
- Vitana Index — keep as "Vitana Index" (der Vitana Index)
- Lebenskompass (Life Compass)
- Meine Reise (My Journey)
- die fünf Säulen (the five pillars: Schlaf, Bewegung, Ernährung, mentale Stärke, Flüssigkeit)
- Autopilot — keep as "Autopilot"
- Erinnerungsgarten / Erinnerungen (Memory / Memory Garden)
- Tagebuch (Daily Diary)
Address the user informally with "du".`;

const STYLE = `You are Vitana, a warm, patient teacher introducing a brand-new user to the Vitana app
during onboarding. Explain like you are talking to a curious beginner who has never used
the app — simple words, short sentences, concrete, encouraging. No jargon, no marketing
fluff, no English. Output MUST be natural German (locale de).

Write content for ONE onboarding topic. Field rules (all German, all required):
- whatItIs: 1-2 short sentences. What this thing is, in plain words.
- userBenefit: 1-2 short sentences. Why it helps the user personally ("du").
- whenToUse: exactly 1 sentence. A real everyday moment when you'd use it.
- tryThis: exactly 1 sentence. A friendly call to action that leads the user INTO the
  practice screen for this topic (e.g. "Tippe auf … und probiere es gleich aus.").
- vitanaVoiceScript: 2-4 spoken sentences (~40-70 words). This is read ALOUD verbatim by
  Vitana's voice, so it must be clean, natural spoken German with no symbols, lists, or
  English. Warm teacher tone; end by inviting the user to try it on the screen.

Only describe features that appear in the provided manual context. If the manual context
is thin, stay general and accurate — never invent buttons, screens, or claims.`;

const TOOL = {
  name: 'journey_topic_content',
  description: 'Return the German onboarding teaching content for exactly one topic.',
  // NB: no `additionalProperties` — Gemini function-declaration schemas (an
  // OpenAPI subset) reject it with a 400 INVALID_ARGUMENT.
  inputSchema: {
    type: 'object',
    properties: {
      whatItIs: { type: 'string', description: 'German. 1-2 short sentences: what it is.' },
      userBenefit: { type: 'string', description: 'German. 1-2 short sentences: why it helps you.' },
      whenToUse: { type: 'string', description: 'German. Exactly 1 sentence: when to use it.' },
      tryThis: { type: 'string', description: 'German. Exactly 1 sentence CTA into the practice screen.' },
      vitanaVoiceScript: { type: 'string', description: 'German. 2-4 spoken sentences read aloud verbatim.' },
    },
    required: ['whatItIs', 'userBenefit', 'whenToUse', 'tryThis', 'vitanaVoiceScript'],
  },
};

// ---------------------------------------------------------------------------
// Manual grounding — locate + keyword-match a Maxina instruction-manual chapter.
// ---------------------------------------------------------------------------

interface ManualChapter {
  file: string;
  title: string;
  keywords: string;
  body: string;
  tokens: Set<string>;
}

let manualIndex: ManualChapter[] | null = null;

function resolveManualDir(): string | null {
  // Try dist (prod: build copies src/kb -> dist/kb) then src (dev/tests).
  const candidates = [
    path.join(__dirname, '../../kb/instruction-manual/maxina'), // dist/services/guided-journey -> dist/kb
    path.join(__dirname, '../../../kb/instruction-manual/maxina'),
    path.join(process.cwd(), 'dist/kb/instruction-manual/maxina'),
    path.join(process.cwd(), 'src/kb/instruction-manual/maxina'),
    path.join(__dirname, '../../../src/kb/instruction-manual/maxina'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function stripFrontmatter(raw: string): { title: string; keywords: string; body: string } {
  let title = '';
  let keywords = '';
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    const t = fm[1].match(/title:\s*(.+)/i);
    if (t) title = t[1].trim().replace(/^["']|["']$/g, '');
    const k = fm[1].match(/keywords:\s*(.+)/i);
    if (k) keywords = k[1].trim();
  }
  return { title, keywords, body };
}

function loadManualIndex(): ManualChapter[] {
  if (manualIndex) return manualIndex;
  const dir = resolveManualDir();
  const out: ManualChapter[] = [];
  if (dir) {
    let subdirs: string[] = [];
    try {
      subdirs = fs.readdirSync(dir);
    } catch {
      subdirs = [];
    }
    for (const sub of subdirs) {
      const subPath = path.join(dir, sub);
      let files: string[] = [];
      try {
        if (!fs.statSync(subPath).isDirectory()) continue;
        files = fs.readdirSync(subPath).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(subPath, f), 'utf-8');
          const { title, keywords, body } = stripFrontmatter(raw);
          const nameSlug = f.replace(/\.md$/, '').replace(/-/g, ' ');
          out.push({
            file: `${sub}/${f}`,
            title,
            keywords,
            body,
            tokens: new Set(tokenize(`${nameSlug} ${title} ${keywords}`)),
          });
        } catch {
          /* skip unreadable chapter */
        }
      }
    }
  }
  manualIndex = out;
  return out;
}

/** Best-matching manual chapter excerpt for a topic, or '' if none/thin. */
function manualGrounding(topic: ChecklistTopic): string {
  const index = loadManualIndex();
  if (!index.length) return '';
  const wanted = tokenize(`${topic.displayLabel} ${topic.shortDescription ?? ''}`);
  let best: ManualChapter | null = null;
  let bestScore = 0;
  for (const ch of index) {
    let score = 0;
    for (const w of wanted) if (ch.tokens.has(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = ch;
    }
  }
  if (!best || bestScore === 0) return '';
  const excerpt = best.body.replace(/\s+/g, ' ').trim().slice(0, 1600);
  return `MANUAL CONTEXT (source chapter "${best.file}"${best.title ? ` — ${best.title}` : ''}):\n${excerpt}`;
}

// ---------------------------------------------------------------------------
// Prompt assembly + generation.
// ---------------------------------------------------------------------------

function buildPrompt(
  topic: ChecklistTopic,
  siblings: ChecklistTopic[],
  manual: string,
  opts: RegenerateOpts,
): string {
  const parts: string[] = [];
  parts.push(GLOSSARY);
  parts.push('');
  parts.push(`TOPIC TO WRITE (call the journey_topic_content tool exactly once):`);
  parts.push(`- Session ${topic.session}, position ${topic.position} (chapter: ${topic.chapterId})`);
  parts.push(`- Label: "${topic.displayLabel}"`);
  if (topic.shortDescription) parts.push(`- Teaching purpose: ${topic.shortDescription}`);
  parts.push(`- Practice target key (where the user practices next): ${topic.guidedPracticeTarget ?? 'the related screen'}`);
  if (siblings.length) {
    parts.push('');
    parts.push(
      `OTHER TOPICS IN THIS SESSION (write so they read as one coherent lesson, no repetition): ${siblings
        .map((s) => `"${s.displayLabel}"`)
        .join(', ')}`,
    );
  }
  if (manual) {
    parts.push('');
    parts.push(manual);
  }
  if (opts.instructions && opts.instructions.trim()) {
    parts.push('');
    parts.push(`SUPERVISOR INSTRUCTIONS (highest priority — follow these): ${opts.instructions.trim()}`);
  }
  return parts.join('\n');
}

function coerceContent(args: Record<string, unknown>): GeneratedContent {
  const out: Record<string, string> = {};
  for (const k of CONTENT_FIELDS) {
    const v = args[k];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`regen_missing_field:${k}`);
    }
    out[k] = v.trim();
  }
  return out as unknown as GeneratedContent;
}

/** Generate German content for one topic and persist it (audited). */
export async function regenerateTopic(
  client: SupabaseClient,
  topicId: string,
  adminId: string,
  opts: RegenerateOpts = {},
): Promise<ChecklistTopic> {
  const topic = await getTopic(client, topicId);
  if (!topic) throw new Error('topic_not_found');

  const siblings = (
    await listTopics(client, { curriculumVersion: topic.curriculumVersion, session: topic.session })
  ).filter((t) => t.topicId !== topicId);

  const prompt = buildPrompt(topic, siblings, manualGrounding(topic), opts);
  const result = await callViaRouter(STAGE, prompt, {
    service: 'journey-checklist-regenerate',
    systemPrompt: STYLE,
    maxTokens: 1500,
    tools: [TOOL],
    forceTool: 0,
  });

  if (!result.ok || !result.toolCall?.arguments) {
    throw new Error(`regen_failed: ${result.error ?? 'no structured output'}`);
  }
  const content = coerceContent(result.toolCall.arguments);

  return updateTopic(
    client,
    topicId,
    {
      vitanaVoiceScript: content.vitanaVoiceScript,
      explanation: {
        whatItIs: content.whatItIs,
        userBenefit: content.userBenefit,
        whenToUse: content.whenToUse,
        tryThis: content.tryThis,
      },
    },
    adminId,
  );
}

export interface SessionRegenResult {
  session: number;
  topics: ChecklistTopic[];
  failures: { topicId: string; error: string }[];
}

/** Regenerate every topic in a session. Per-topic failures are collected, not fatal. */
export async function regenerateSession(
  client: SupabaseClient,
  session: number,
  adminId: string,
  opts: RegenerateOpts = {},
): Promise<SessionRegenResult> {
  const topics = await listTopics(client, {
    curriculumVersion: opts.curriculumVersion ?? 'v2',
    session,
  });
  const done: ChecklistTopic[] = [];
  const failures: { topicId: string; error: string }[] = [];
  for (const t of topics) {
    try {
      done.push(await regenerateTopic(client, t.topicId, adminId, opts));
    } catch (err) {
      failures.push({ topicId: t.topicId, error: (err as Error).message });
    }
  }
  return { session, topics: done, failures };
}
