/**
 * VTID-02047: LLM-backed resolver agents (Sage / Devon / Mira / Atlas)
 *
 * Replaces the placeholder draft markdown that draft-answer / draft-spec /
 * draft-resolution previously emitted with real LLM-generated content via
 * the gateway's existing llm-router (callViaRouter). The router handles
 * provider selection (Anthropic / Vertex / OpenAI / Deepseek) per the
 * configured policy, fallback, observability, and cost telemetry — same
 * path Devon-the-dev-autopilot already uses.
 *
 * Each resolver:
 *   - Reads the ticket's transcript + structured_fields + classifier_meta
 *   - Builds a persona-specific system prompt (Sage / Devon / Mira / Atlas)
 *   - Calls callViaRouter('triage', userPrompt, { systemPrompt }) — triage
 *     stage is the right size for short structured drafting (not full
 *     planner reasoning).
 *   - Returns the draft markdown text. Caller persists it to the ticket
 *     (draft_answer_md / spec_md / resolution_md).
 *
 * If the router fails or returns empty, we fall back to a clearly-labelled
 * placeholder so the supervisor inbox still moves forward — never silently
 * drop the action.
 */

import type { LLMStage } from '../constants/llm-defaults';

const STAGE: LLMStage = 'triage';
const SERVICE_TAG = 'feedback-llm-resolvers';
const MAX_TOKENS = 1500;

interface FeedbackTicketSnapshot {
  id: string;
  ticket_number: string | null;
  kind: string;
  raw_transcript: string | null;
  intake_messages: Array<{ agent?: string; role: string; content: string }> | null;
  structured_fields: Record<string, unknown> | null;
  classifier_meta: Record<string, unknown> | null;
  screen_path: string | null;
  app_version: string | null;
  vitana_id: string | null;
  priority: string | null;
}

function summarizeIntake(t: FeedbackTicketSnapshot): string {
  const lines: string[] = [];
  if (t.raw_transcript) lines.push(`Raw transcript:\n${t.raw_transcript}`);
  if (t.intake_messages && t.intake_messages.length > 0) {
    lines.push('Intake conversation:');
    for (const m of t.intake_messages) {
      const who = m.agent ?? m.role;
      lines.push(`  [${who}] ${m.content}`);
    }
  }
  if (t.structured_fields && Object.keys(t.structured_fields).length > 0) {
    lines.push(`Structured fields:\n${JSON.stringify(t.structured_fields, null, 2)}`);
  }
  if (t.classifier_meta && Object.keys(t.classifier_meta).length > 0) {
    lines.push(`Classifier metadata:\n${JSON.stringify(t.classifier_meta, null, 2)}`);
  }
  const ctx: string[] = [];
  if (t.screen_path) ctx.push(`screen=${t.screen_path}`);
  if (t.app_version) ctx.push(`app=${t.app_version}`);
  if (t.vitana_id) ctx.push(`reporter=${t.vitana_id}`);
  if (t.priority) ctx.push(`priority=${t.priority}`);
  if (ctx.length) lines.push(`Context: ${ctx.join(', ')}`);
  return lines.join('\n\n');
}

async function callRouter(
  systemPrompt: string,
  userPrompt: string,
  vtid: string | null,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const { callViaRouter } = await import('./llm-router');
    // Router takes a single `prompt` string. Synthesize a system+user
    // markdown by prefixing with the system role hints; the router's
    // provider adapters split this back appropriately for each model.
    const composed = `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userPrompt}`;
    const r = await callViaRouter(STAGE, composed, {
      vtid: vtid ?? null,
      service: SERVICE_TAG,
      allowFallback: true,
      maxTokens: MAX_TOKENS,
    });
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.text || !r.text.trim()) return { ok: false, error: 'empty response' };
    return { ok: true, text: r.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

function fallbackPlaceholder(persona: 'sage'|'devon'|'mira'|'atlas', t: FeedbackTicketSnapshot): string {
  const personaLabel = persona.charAt(0).toUpperCase() + persona.slice(1);
  return `**${personaLabel} draft (LLM unavailable, placeholder)**\n\n` +
    `_Router returned no text — supervisor: please draft manually._\n\n` +
    `User report:\n> ${(t.raw_transcript ?? '(no transcript)').slice(0, 1000)}\n`;
}

// ---------------------------------------------------------------------------
// Sage — KB Answerer for support_question
// ---------------------------------------------------------------------------

const SAGE_SYSTEM = `You are Sage, the Vitana customer-support specialist. Your job is to draft a concise, friendly answer to a user's "how do I" / "where is" / general support question.

Guidelines:
- Address the user directly (you / your), warm but professional.
- Keep answers ≤ 200 words. Use simple paragraphs (no headings unless multi-step).
- If the question genuinely requires information you don't have (account-specific data, server state), say "I'll need to check this with the team — leaving this for a human review" and stop. Don't invent.
- If multi-step, use a short numbered list.
- Don't apologize for things outside the question.
- Sign off with "— Sage".

Output: just the answer markdown. No preamble, no JSON wrappers, no system commentary.`;

export async function llmDraftSageAnswer(t: FeedbackTicketSnapshot): Promise<{ markdown: string; provider: 'llm' | 'fallback' }> {
  const userPrompt = `User support ticket ${t.ticket_number ?? '(pending)'}:\n\n${summarizeIntake(t)}\n\nDraft your answer now.`;
  const r = await callRouter(SAGE_SYSTEM, userPrompt, t.ticket_number);
  if (!r.ok || !r.text) return { markdown: fallbackPlaceholder('sage', t), provider: 'fallback' };
  return { markdown: r.text.trim() + '\n', provider: 'llm' };
}

// ---------------------------------------------------------------------------
// Devon — Spec Writer for bug / ux_issue
// ---------------------------------------------------------------------------

const DEVON_SYSTEM = `You are Devon, the Vitana tech-support specialist. Your job is to write a one-page bug-fix spec for the engineering team based on a user's report.

Output a markdown document with EXACTLY these sections in this order, no others:

# <ticket_number> — <one-line problem statement>

## Root cause hypothesis
A short paragraph naming what code is most likely at fault. If insufficient evidence, write a hypothesis explicitly labelled "best-guess".

## Repro steps
A numbered list. Use the user's words where possible. If steps weren't given, propose the most likely flow.

## Expected vs actual
Two short paragraphs.

## Files to touch (best guess)
A bullet list of likely files / modules. Mark uncertain ones with "(probably)".

## Risk + rollback
One short paragraph: blast radius, which feature flag if any, how to revert.

## Test plan
Bulleted checklist for verification.

Style: terse, factual, engineering English. No marketing copy. No reassurance to the user. Sign off with "— Devon".`;

export async function llmDraftDevonSpec(t: FeedbackTicketSnapshot): Promise<{ markdown: string; provider: 'llm' | 'fallback' }> {
  const userPrompt = `Ticket ${t.ticket_number ?? '(pending)'} (kind=${t.kind}):\n\n${summarizeIntake(t)}\n\nWrite the spec now.`;
  const r = await callRouter(DEVON_SYSTEM, userPrompt, t.ticket_number);
  if (!r.ok || !r.text) return { markdown: fallbackPlaceholder('devon', t), provider: 'fallback' };
  return { markdown: r.text.trim() + '\n', provider: 'llm' };
}

// ---------------------------------------------------------------------------
// Mira — Account-issue resolution drafter
// ---------------------------------------------------------------------------

const MIRA_SYSTEM = `You are Mira, the Vitana account-support specialist. Your job is to draft a resolution plan for a user's account problem (login, role, profile, password, email verification, data correction).

Output markdown with EXACTLY these sections:

# Account resolution — <ticket_number>

## What the user reported
One short paragraph paraphrasing the user's issue.

## Proposed action
A numbered list (3–6 items max) of concrete steps a human operator would take to resolve this. Use known runbooks where they apply: password reset, email resend, role correction, profile field edit. Reference the operator runbook by name where applicable.

## Verification
How the operator confirms the fix worked.

## Risk
One short paragraph. Note if any step touches sensitive data or another user's account.

## User-facing message
A short paragraph (≤80 words) Mira will speak when the fix is confirmed. Calm and reassuring.

Sign off with "— Mira".`;

export async function llmDraftMiraResolution(t: FeedbackTicketSnapshot): Promise<{ markdown: string; provider: 'llm' | 'fallback' }> {
  const userPrompt = `Ticket ${t.ticket_number ?? '(pending)'}:\n\n${summarizeIntake(t)}\n\nWrite the resolution plan now.`;
  const r = await callRouter(MIRA_SYSTEM, userPrompt, t.ticket_number);
  if (!r.ok || !r.text) return { markdown: fallbackPlaceholder('mira', t), provider: 'fallback' };
  return { markdown: r.text.trim() + '\n', provider: 'llm' };
}

// ---------------------------------------------------------------------------
// Atlas — Marketplace / finance claim drafter
// ---------------------------------------------------------------------------

const ATLAS_SYSTEM = `You are Atlas, the Vitana finance / marketplace-claims specialist. Your job is to draft a resolution for a user's commerce-side claim — refund request, undelivered order, wrong item, dispute with seller, payment problem.

Output markdown with EXACTLY these sections:

# Marketplace claim — <ticket_number>

## Claim summary
One paragraph. Include any order_id, counterparty, amount, and desired_outcome the user gave (refund / replace / mediate).

## Eligibility check
Bulleted: what evidence the operator needs (proof of purchase, photos, screenshots, etc.).

## Proposed resolution
A numbered list of steps. Include monetary impact (refund $X / partial $Y / no refund + replacement). Cap auto-approval at $20 — anything higher needs human approval (call this out explicitly).

## Risk + fraud signals
One short paragraph. Note any red flags (high-value claim, repeated reports from same user, counterparty pattern).

## User-facing message
≤80 words. Professional, neutral. Don't promise a refund until approved.

Sign off with "— Atlas".`;

export async function llmDraftAtlasResolution(t: FeedbackTicketSnapshot): Promise<{ markdown: string; provider: 'llm' | 'fallback' }> {
  const userPrompt = `Ticket ${t.ticket_number ?? '(pending)'}:\n\n${summarizeIntake(t)}\n\nWrite the resolution now.`;
  const r = await callRouter(ATLAS_SYSTEM, userPrompt, t.ticket_number);
  if (!r.ok || !r.text) return { markdown: fallbackPlaceholder('atlas', t), provider: 'fallback' };
  return { markdown: r.text.trim() + '\n', provider: 'llm' };
}

export type { FeedbackTicketSnapshot };
