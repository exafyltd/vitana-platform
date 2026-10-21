/**
 * VTID-04400 (Orchestrator v2, P3): the commerce onboarding specialist — the
 * third `delegate_to_agent` target and the first on the business ORB
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5 P3 "commerce onboarding (new
 * `commerce` surface)", §3.4 pattern 2 "specialist as a tool").
 *
 * Agent-as-tool, like the support specialist (VTID-04397): Vitana keeps the
 * conversation, the specialist gathers facts and RETURNS FINDINGS that the
 * front agent speaks in the user's language. It never composes the sentence
 * the user hears (NEVER-rule 41) and it never writes — registering, inviting
 * and activating stay on the Partner Organizations screens and routes.
 *
 * Read-only, and every read is scoped to the CALLER's own memberships:
 *   list_my_organizations()          — the business(es) the caller belongs
 *                                       to, their status and the caller's role;
 *   get_organization_status(org)     — one of THOSE: review status, team size,
 *                                       pending invites (org_admin only, count
 *                                       only), and whether a health-vertical org
 *                                       is connected for orders;
 *   search_knowledge(query)          — the knowledge base (documents only).
 * Never read: business_details, member or invitee identities, invite tokens.
 *
 * Commerce authority comes from organization membership, never the platform
 * role (policy.ts roleCeiling): the caller's memberships are loaded before
 * delegating and a caller with none is refused by the dispatcher's policy.
 *
 * Off by default: ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED must be exactly
 * 'true'. Deploying this changes nothing until the flag is set.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LLMRouterTool, LLMStage } from '../llm-router';
import { runStageToolLoop, type StageToolLoopResult, type StageToolOutcome } from '../llm-stage-tool-loop';
import type { AgentOrgContext } from './context';
import type { DelegationCaller, DelegationOutcome, DelegationTarget } from './dispatcher';

export const COMMERCE_SPECIALIST_ENABLED_ENV = 'ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED';
export const COMMERCE_SPECIALIST_AGENT_ID = 'commerce';
export const COMMERCE_SPECIALIST_SERVICE = 'commerce-specialist';
/** Same stage as the support specialist (Bedrock primary under v17). */
export const COMMERCE_SPECIALIST_STAGE: LLMStage = 'triage';

export const COMMERCE_MAX_TURNS = 4;
export const COMMERCE_MAX_TOOL_CALLS = 6;
export const COMMERCE_DEADLINE_MS = 45_000;
export const COMMERCE_FINDINGS_MAX_CHARS = 1_500;
const KNOWLEDGE_SNIPPET_MAX_CHARS = 400;
const MAX_ORGS = 10;

export function isCommerceSpecialistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[COMMERCE_SPECIALIST_ENABLED_ENV] === 'true';
}

export const COMMERCE_TOOLS: LLMRouterTool[] = [
  {
    name: 'list_my_organizations',
    description: "The business organizations this user belongs to: name, type, review status (pending_review, active, suspended, rejected), vertical and the user's role in each.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_organization_status',
    description: "Onboarding status of one of the user's own organizations: review status, team size, pending invites (only for an org admin), and whether a health organization is connected to receive orders.",
    inputSchema: {
      type: 'object',
      properties: { organization: { type: 'string', description: 'The organization name or key as the user said it; omit when the user belongs to only one.' } },
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search the Vitana knowledge base (how partner onboarding, review, team invites and orders work). Returns matching document titles and snippets.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look up, in a few words.' } },
      required: ['query'],
    },
  },
];

export const COMMERCE_SYSTEM_PROMPT = [
  "You are the Vitana commerce onboarding specialist. The user's assistant (Vitana) asked you a question about the user's business on Vitana on their behalf.",
  "Gather the facts with your tools, then reply with FINDINGS for Vitana — not a message to the user. Vitana decides how to say it, in the user's language.",
  'Rules:',
  '- Use only what the tools return. If they do not answer the question, say what is missing; never invent a status, date, requirement or timeline.',
  "- You can only see this user's own organizations. Never speculate about other businesses.",
  '- You cannot change anything. If the user needs something done (register, invite someone, finish a step), name the screen or action Vitana should point them to.',
  '- Review and activation are decided by the Vitana team; never promise when it will happen.',
  '- Keep it short: at most 6 lines. Name statuses exactly as the tools give them.',
].join('\n');

export interface CommerceMembership {
  org_id: string;
  org_key: string | null;
  display_name: string;
  org_type: string | null;
  status: string;
  commerce_vertical: string | null;
  role: string;
  created_at: string | null;
}

export interface CommerceOrgDetail {
  member_count: number | null;
  /** Null when not read (the caller is not the org's admin) or unavailable. */
  pending_invites: number | null;
  /** Null when not applicable (not a health-vertical organization). */
  orders_connected: boolean | null;
}

interface KnowledgeDocLike { title: string; snippet: string; source: string }

export interface CommerceDeps {
  listMemberships: (userId: string) => Promise<CommerceMembership[]>;
  getOrgDetail: (membership: CommerceMembership) => Promise<CommerceOrgDetail>;
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

type OrgEmbed = {
  id: string; org_key: string | null; display_name: string; org_type: string | null;
  status: string; commerce_vertical: string | null; created_at: string | null;
};

export const defaultCommerceDeps: CommerceDeps = {
  async listMemberships(userId) {
    const sb = await serviceClient();
    const { data, error } = await sb
      .from('partner_organization_members')
      .select('role, partner_organization_id, partner_organizations(id, org_key, display_name, org_type, status, commerce_vertical, created_at)')
      .eq('user_id', userId)
      .limit(MAX_ORGS);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<{ role: string; partner_organization_id: string; partner_organizations: OrgEmbed | OrgEmbed[] | null }>)
      .map((row) => {
        const org = Array.isArray(row.partner_organizations) ? row.partner_organizations[0] : row.partner_organizations;
        if (!org) return null;
        return {
          org_id: String(org.id ?? row.partner_organization_id),
          org_key: org.org_key ?? null,
          display_name: org.display_name,
          org_type: org.org_type ?? null,
          status: org.status,
          commerce_vertical: org.commerce_vertical ?? null,
          role: String(row.role),
          created_at: org.created_at ?? null,
        } as CommerceMembership;
      })
      .filter((m): m is CommerceMembership => m !== null);
  },
  async getOrgDetail(m) {
    const sb = await serviceClient();
    const members = await sb
      .from('partner_organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('partner_organization_id', m.org_id);
    let pending: number | null = null;
    if (m.role === 'org_admin') {
      const inv = await sb
        .from('partner_organization_invites')
        .select('id', { count: 'exact', head: true })
        .eq('partner_organization_id', m.org_id)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString());
      pending = inv.error ? null : (inv.count ?? 0);
    }
    let ordersConnected: boolean | null = null;
    if (m.commerce_vertical === 'health') {
      const reg = await sb
        .from('partner_registry')
        .select('id', { count: 'exact', head: true })
        .eq('partner_organization_id', m.org_id);
      ordersConnected = reg.error ? null : (reg.count ?? 0) > 0;
    }
    return { member_count: members.error ? null : (members.count ?? 0), pending_invites: pending, orders_connected: ordersConnected };
  },
  async searchKnowledge(query) {
    const { searchKnowledgeDocs } = await import('../knowledge-hub');
    return searchKnowledgeDocs(query, 5);
  },
  runLoop: runStageToolLoop,
};

/** The caller's memberships in the shape the policy reads (context.ts). */
export function membershipsToOrgContext(rows: CommerceMembership[]): AgentOrgContext[] {
  return rows.map((m) => ({ org_id: m.org_id, org_key: m.org_key, org_role: m.role, commerce_vertical: m.commerce_vertical }));
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Picks one of the caller's own memberships by name or key. An empty
 * reference resolves only when there is exactly one membership.
 */
export function pickMembership(rows: CommerceMembership[], ref: unknown): { membership: CommerceMembership | null; error?: string } {
  if (rows.length === 0) return { membership: null, error: 'This user belongs to no business organization.' };
  const want = norm(ref);
  if (!want) {
    if (rows.length === 1) return { membership: rows[0] };
    return { membership: null, error: `Which organization? This user belongs to: ${rows.map((r) => r.display_name).join(', ')}.` };
  }
  const exact = rows.filter((r) => norm(r.display_name) === want || norm(r.org_key) === want);
  if (exact.length === 1) return { membership: exact[0] };
  const partial = rows.filter((r) => norm(r.display_name).includes(want) || norm(r.org_key).includes(want));
  if (partial.length === 1) return { membership: partial[0] };
  if (partial.length > 1) return { membership: null, error: `More than one organization matches: ${partial.map((r) => r.display_name).join(', ')}.` };
  return { membership: null, error: `No organization of this user matches "${String(ref)}". Theirs: ${rows.map((r) => r.display_name).join(', ')}.` };
}

/** The specialist's `execute`. Every read is pinned to `userId`; never throws. */
export function buildCommerceExecutor(userId: string, deps: CommerceDeps, signal?: AbortSignal) {
  let memberships: CommerceMembership[] | null = null;
  const own = async () => (memberships ??= await deps.listMemberships(userId));
  return async (name: string, args: Record<string, unknown>): Promise<StageToolOutcome> => {
    if (signal?.aborted) return { result: 'cancelled', isError: true };
    try {
      switch (name) {
        case 'list_my_organizations': {
          const rows = await own();
          if (rows.length === 0) return { result: 'This user belongs to no business organization.' };
          return {
            result: rows.map((m) => `${m.display_name} | ${m.org_type ?? 'type unknown'} | ${m.status} | vertical ${m.commerce_vertical ?? 'unset'} | role ${m.role} | registered ${String(m.created_at ?? '').slice(0, 10)}`).join('\n'),
          };
        }
        case 'get_organization_status': {
          const picked = pickMembership(await own(), args.organization);
          if (!picked.membership) return { result: picked.error ?? 'organization not found' };
          const m = picked.membership;
          const d = await deps.getOrgDetail(m);
          const lines = [
            `${m.display_name} | status ${m.status} | vertical ${m.commerce_vertical ?? 'unset'} | your role ${m.role}`,
            `team members: ${d.member_count ?? 'unknown'}`,
          ];
          if (m.role === 'org_admin') lines.push(`pending invites: ${d.pending_invites ?? 'unknown'}`);
          if (d.orders_connected !== null) lines.push(`connected to receive health orders: ${d.orders_connected ? 'yes' : 'no'}`);
          return { result: lines.join('\n') };
        }
        case 'search_knowledge': {
          const q = typeof args.query === 'string' ? args.query.trim() : '';
          if (!q) return { result: 'query is required', isError: true };
          const docs = await deps.searchKnowledge(q.slice(0, 200));
          if (docs.length === 0) return { result: 'No knowledge base documents matched.' };
          return { result: docs.map((doc) => `# ${doc.title}\n${clip(doc.snippet ?? '', KNOWLEDGE_SNIPPET_MAX_CHARS)}`).join('\n\n') };
        }
        default:
          return { result: `unknown tool: ${name} (available: ${COMMERCE_TOOLS.map((t) => t.name).join(', ')})`, isError: true };
      }
    } catch (e) {
      return { result: `${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  };
}

export async function runCommerceSpecialist(
  request: string,
  caller: DelegationCaller,
  signal: AbortSignal,
  deps: CommerceDeps = defaultCommerceDeps,
): Promise<DelegationOutcome> {
  if (!caller.user_id) return { ok: false, result: null, error: 'the commerce specialist needs a signed-in user' };
  const loop: StageToolLoopResult = await deps.runLoop({
    stage: COMMERCE_SPECIALIST_STAGE,
    service: COMMERCE_SPECIALIST_SERVICE,
    systemPrompt: COMMERCE_SYSTEM_PROMPT,
    prompt: `User's question about their business (as relayed by Vitana): ${request}`,
    tools: COMMERCE_TOOLS,
    execute: buildCommerceExecutor(caller.user_id, deps, signal),
    maxTurns: COMMERCE_MAX_TURNS,
    maxToolCalls: COMMERCE_MAX_TOOL_CALLS,
    deadlineMs: COMMERCE_DEADLINE_MS,
  });
  if (!loop.ok || !loop.text) return { ok: false, result: null, error: loop.error ?? 'the commerce specialist returned no findings' };
  return {
    ok: true,
    result: {
      findings: clip(loop.text.trim(), COMMERCE_FINDINGS_MAX_CHARS),
      tools_used: loop.toolNames,
      note: 'Findings for you, not a script: answer the user in their language, in your own words.',
    },
  };
}

export const COMMERCE_TARGET: DelegationTarget = {
  agent_id: COMMERCE_SPECIALIST_AGENT_ID,
  description: "Commerce onboarding specialist: looks up the user's own business organizations, their review status and team, and the knowledge base; returns findings. Read-only.",
  surfaces: ['commerce'],
  domain: 'commerce',
  tier: 'read',
  run: (request, caller, signal) => runCommerceSpecialist(request, caller, signal),
};
