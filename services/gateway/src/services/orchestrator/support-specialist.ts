/**
 * VTID-04397 (Orchestrator v2, P3): the support specialist — the second
 * `delegate_to_agent` target and the first one on the member ORB
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.4 pattern 2 "specialist as a tool",
 * §5 P3 "first specialists as agent-as-tool: support/account (community)").
 *
 * Agent-as-tool, not a hand-off: Vitana keeps the conversation and the
 * persona; the specialist gathers facts and RETURNS FINDINGS that the front
 * agent speaks in the user's language. It never composes the sentence the
 * user hears (NEVER-rule 41) and it never writes anything — filing a ticket
 * stays with `report_to_specialist` / `submit_support_ticket`, which already
 * carry their own contracts (VTID-04332).
 *
 * Read-only, and every read is scoped to the CALLER's own user id:
 *   list_my_tickets()               — the caller's open tickets;
 *   get_my_ticket(ticket_number)    — one of the caller's tickets, with the
 *                                     published resolution once resolved. The
 *                                     unapproved draft answer and the dev spec
 *                                     are never read (not the member's yet);
 *   search_knowledge(query)         — the knowledge base (documents only; no
 *                                     second LLM call).
 *
 * Findings are internal English for the front agent, like a system
 * instruction (§13b "what does NOT need translation"); the front agent
 * answers in the user's language.
 *
 * Off by default: ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED must be exactly
 * 'true' (same activation convention as the other opt-in agents). Deploying
 * this changes nothing until the flag is set.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LLMRouterTool, LLMStage } from '../llm-router';
import { runStageToolLoop, type StageToolLoopResult, type StageToolOutcome } from '../llm-stage-tool-loop';
import type { DelegationCaller, DelegationOutcome, DelegationTarget } from './dispatcher';

export const SUPPORT_SPECIALIST_ENABLED_ENV = 'ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED';
export const SUPPORT_SPECIALIST_AGENT_ID = 'support';
export const SUPPORT_SPECIALIST_SERVICE = 'support-specialist';
/** The routing-policy stage the specialist runs on (Bedrock primary under v17). */
export const SUPPORT_SPECIALIST_STAGE: LLMStage = 'triage';

export const SUPPORT_MAX_TURNS = 4;
export const SUPPORT_MAX_TOOL_CALLS = 6;
/** Voice acks in 1.5 s regardless; this bounds the job itself. */
export const SUPPORT_DEADLINE_MS = 45_000;
export const SUPPORT_FINDINGS_MAX_CHARS = 1_500;
const TICKET_TEXT_MAX_CHARS = 1_200;
const KNOWLEDGE_SNIPPET_MAX_CHARS = 400;

export const CLOSED_TICKET_STATUSES = ['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate'] as const;

export function isSupportSpecialistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUPPORT_SPECIALIST_ENABLED_ENV] === 'true';
}

export const SUPPORT_TOOLS: LLMRouterTool[] = [
  {
    name: 'list_my_tickets',
    description: "The member's own open support tickets and bug reports: number, kind, status, filed date. Newest first, at most 8.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_my_ticket',
    description: "One of the member's own tickets by its number (e.g. FB-2026-07-000137, or just 137): kind, status, dates, and the published resolution once it is resolved.",
    inputSchema: {
      type: 'object',
      properties: { ticket_number: { type: 'string', description: 'The ticket number, e.g. FB-2026-07-000137, or the trailing number the member says.' } },
      required: ['ticket_number'],
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search the Vitana knowledge base (how features work, account and settings help). Returns matching document titles and snippets.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look up, in a few words.' } },
      required: ['query'],
    },
  },
];

export const SUPPORT_SYSTEM_PROMPT = [
  'You are the Vitana support specialist. The member\'s assistant (Vitana) asked you a support or account question on the member\'s behalf.',
  'Gather the facts with your tools, then reply with FINDINGS for Vitana — not a message to the member. Vitana decides how to say it, in the member\'s language.',
  'Rules:',
  '- Use only what the tools return. If the tools do not answer the question, say what is missing; never invent a status, date, fix or policy.',
  '- You can only see this member\'s own tickets. Never speculate about other members.',
  '- You cannot change anything. If the member needs something done (file a report, change a setting), name the action Vitana should offer.',
  '- Keep it short: at most 6 lines. Name ticket numbers and statuses exactly as the tools give them.',
].join('\n');

interface TicketListRow { ticket_number: string | null; kind: string; status: string; created_at: string }
interface TicketDetailRow extends TicketListRow {
  resolved_at: string | null;
  resolution_md: string | null;
  linked_vtid: string | null;
}
interface KnowledgeDocLike { title: string; snippet: string; source: string }

export interface SupportDeps {
  listOpenTickets: (userId: string) => Promise<TicketListRow[]>;
  getOwnTicket: (userId: string, ticketNumber: string) => Promise<TicketDetailRow | null>;
  searchKnowledge: (query: string) => Promise<KnowledgeDocLike[]>;
  runLoop: typeof runStageToolLoop;
}

let cachedClient: SupabaseClient | null = null;
async function serviceClient(): Promise<SupabaseClient> {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('Supabase is not configured');
  const { createClient } = await import('@supabase/supabase-js');
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export const defaultSupportDeps: SupportDeps = {
  async listOpenTickets(userId) {
    const repo = await import('../orb-tools/feedback-settings-tools-repository');
    const { data, error } = await repo.fetchOpenFeedbackTickets(await serviceClient(), userId, [...CLOSED_TICKET_STATUSES]);
    if (error) throw new Error(error.message);
    return (data ?? []) as TicketListRow[];
  },
  async getOwnTicket(userId, ticketNumber) {
    const repo = await import('../orb-tools/feedback-settings-tools-repository');
    const { data, error } = await repo.fetchOwnFeedbackTicketByNumber(await serviceClient(), userId, ticketNumber);
    if (error) throw new Error(error.message);
    return (data ?? null) as TicketDetailRow | null;
  },
  async searchKnowledge(query) {
    const { searchKnowledgeDocs } = await import('../knowledge-hub');
    return searchKnowledgeDocs(query, 5);
  },
  runLoop: runStageToolLoop,
};

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Normalises a spoken ticket reference to the stored shape
 * `FB-YYYY-MM-NNNNNN` ("fb 2026 07 137" → FB-2026-07-000137). A bare number
 * ("137") stays digits-only and is matched against the member's own tickets
 * by suffix.
 */
export function normalizeTicketNumber(raw: unknown): string {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s_]+/g, '-');
  const full = s.match(/^FB-?(\d{4})-?(\d{2})-?(\d{1,6})$/);
  if (full) return `FB-${full[1]}-${full[2]}-${full[3].padStart(6, '0')}`;
  const bare = s.match(/^#?(\d{1,6})$/);
  if (bare) return String(Number(bare[1]));
  return s;
}

/** The specialist's `execute`. Every read is pinned to `userId`; never throws. */
export function buildSupportExecutor(userId: string, deps: SupportDeps, signal?: AbortSignal) {
  return async (name: string, args: Record<string, unknown>): Promise<StageToolOutcome> => {
    if (signal?.aborted) return { result: 'cancelled', isError: true };
    try {
      switch (name) {
        case 'list_my_tickets': {
          const rows = await deps.listOpenTickets(userId);
          if (rows.length === 0) return { result: 'No open tickets.' };
          return {
            result: rows.map((t) => `${t.ticket_number ?? '(number pending)'} | ${t.kind} | ${t.status} | filed ${String(t.created_at ?? '').slice(0, 10)}`).join('\n'),
          };
        }
        case 'get_my_ticket': {
          const number = normalizeTicketNumber(args.ticket_number);
          if (!number) return { result: 'ticket_number is required', isError: true };
          const t = await deps.getOwnTicket(userId, number);
          if (!t) return { result: `No ticket ${number} belongs to this member.` };
          const lines = [
            `${t.ticket_number} | ${t.kind} | ${t.status}`,
            `filed ${String(t.created_at ?? '').slice(0, 10)}${t.resolved_at ? `, resolved ${String(t.resolved_at).slice(0, 10)}` : ''}`,
          ];
          if (t.linked_vtid) lines.push(`fix tracked as ${t.linked_vtid}`);
          if (t.resolution_md) lines.push(`resolution: ${clip(t.resolution_md, TICKET_TEXT_MAX_CHARS)}`);
          return { result: lines.join('\n') };
        }
        case 'search_knowledge': {
          const q = typeof args.query === 'string' ? args.query.trim() : '';
          if (!q) return { result: 'query is required', isError: true };
          const docs = await deps.searchKnowledge(q.slice(0, 200));
          if (docs.length === 0) return { result: 'No knowledge base documents matched.' };
          return { result: docs.map((d) => `# ${d.title}\n${clip(d.snippet ?? '', KNOWLEDGE_SNIPPET_MAX_CHARS)}`).join('\n\n') };
        }
        default:
          return { result: `unknown tool: ${name} (available: ${SUPPORT_TOOLS.map((t) => t.name).join(', ')})`, isError: true };
      }
    } catch (e) {
      return { result: `${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  };
}

export async function runSupportSpecialist(
  request: string,
  caller: DelegationCaller,
  signal: AbortSignal,
  deps: SupportDeps = defaultSupportDeps,
): Promise<DelegationOutcome> {
  if (!caller.user_id) return { ok: false, result: null, error: 'the support specialist needs a signed-in member' };
  const loop: StageToolLoopResult = await deps.runLoop({
    stage: SUPPORT_SPECIALIST_STAGE,
    service: SUPPORT_SPECIALIST_SERVICE,
    systemPrompt: SUPPORT_SYSTEM_PROMPT,
    prompt: `Member's question (as relayed by Vitana): ${request}`,
    tools: SUPPORT_TOOLS,
    execute: buildSupportExecutor(caller.user_id, deps, signal),
    maxTurns: SUPPORT_MAX_TURNS,
    maxToolCalls: SUPPORT_MAX_TOOL_CALLS,
    deadlineMs: SUPPORT_DEADLINE_MS,
  });
  if (!loop.ok || !loop.text) return { ok: false, result: null, error: loop.error ?? 'the support specialist returned no findings' };
  return {
    ok: true,
    result: {
      findings: clip(loop.text.trim(), SUPPORT_FINDINGS_MAX_CHARS),
      tools_used: loop.toolNames,
      note: 'Findings for you, not a script: answer the member in their language, in your own words.',
    },
  };
}

export const SUPPORT_TARGET: DelegationTarget = {
  agent_id: SUPPORT_SPECIALIST_AGENT_ID,
  description: "Support specialist: looks up the member's own tickets and the knowledge base and returns findings. Read-only.",
  surfaces: ['vitanaland'],
  domain: 'community',
  tier: 'read',
  run: (request, caller, signal) => runSupportSpecialist(request, caller, signal),
};
