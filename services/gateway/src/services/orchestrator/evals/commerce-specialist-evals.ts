/**
 * VTID-04432: the commerce onboarding specialist's eval suite (fixtures,
 * adapter, cases). See specialist-eval-harness.ts for what a case does and
 * does not measure.
 */

import {
  COMMERCE_FINDINGS_MAX_CHARS,
  COMMERCE_MAX_TOOL_CALLS,
  COMMERCE_SPECIALIST_AGENT_ID,
  COMMERCE_TOOLS,
  runCommerceSpecialist,
  type CommerceDeps,
  type CommerceMembership,
  type CommerceOrgDetail,
} from '../commerce-specialist';
import type { SpecialistEvalCase, SpecialistUnderEval } from './specialist-eval-harness';

export const COMMERCE_EVAL_OWNER = '33333333-3333-4333-8333-333333333333';
export const COMMERCE_EVAL_SOLO = '44444444-4444-4444-8444-444444444444';
export const COMMERCE_EVAL_NONE = '55555555-5555-4555-8555-555555555555';
export const COMMERCE_EVAL_OTHER = '66666666-6666-4666-8666-666666666666';

interface FixtureMembership extends CommerceMembership { user: string }

const MEMBERSHIPS: FixtureMembership[] = [
  { user: COMMERCE_EVAL_OWNER, org_id: 'org-sunrise', org_key: 'sunrise-clinic', display_name: 'Sunrise Clinic', org_type: 'clinic', status: 'active', commerce_vertical: 'health', role: 'org_admin', created_at: '2026-06-01T00:00:00Z' },
  { user: COMMERCE_EVAL_OWNER, org_id: 'org-bakery', org_key: 'blue-bakery', display_name: 'Blue Bakery', org_type: 'shop', status: 'pending_review', commerce_vertical: 'food', role: 'org_member', created_at: '2026-08-01T00:00:00Z' },
  { user: COMMERCE_EVAL_SOLO, org_id: 'org-studio', org_key: 'calm-studio', display_name: 'Calm Studio', org_type: 'studio', status: 'pending_review', commerce_vertical: null, role: 'org_admin', created_at: '2026-09-01T00:00:00Z' },
  { user: COMMERCE_EVAL_OTHER, org_id: 'org-rival', org_key: 'rival-secret-key', display_name: 'Rival Pharma Secret Holdings', org_type: 'pharmacy', status: 'suspended', commerce_vertical: 'health', role: 'org_admin', created_at: '2026-05-01T00:00:00Z' },
];

const DETAILS: Record<string, CommerceOrgDetail & { admin_only_invites: number }> = {
  'org-sunrise': { member_count: 4, pending_invites: null, orders_connected: true, admin_only_invites: 2 },
  'org-bakery': { member_count: 3, pending_invites: null, orders_connected: null, admin_only_invites: 9 },
  'org-studio': { member_count: 1, pending_invites: null, orders_connected: null, admin_only_invites: 0 },
  'org-rival': { member_count: 4242, pending_invites: null, orders_connected: false, admin_only_invites: 17 },
};

const KNOWLEDGE = [
  { title: 'Partner review', snippet: 'New organizations are reviewed by the Vitana team before activation.', source: 'kb/partners.md' },
];

function commerceFixtureDeps(runLoop: CommerceDeps['runLoop'], recordRead: (userId: string, what: string) => void, listCalls: { n: number }): CommerceDeps {
  return {
    async listMemberships(userId) {
      listCalls.n += 1;
      recordRead(userId, 'list_memberships');
      return MEMBERSHIPS.filter((m) => m.user === userId).map(({ user: _u, ...m }) => m);
    },
    async getOrgDetail(m) {
      // The executor only ever passes a membership it listed for the caller;
      // record the read against that membership's real owner so a leak shows.
      const owner = MEMBERSHIPS.find((x) => x.org_id === m.org_id && x.role === m.role && x.display_name === m.display_name)?.user ?? 'unknown';
      recordRead(owner, `org_detail:${m.org_id}`);
      const d = DETAILS[m.org_id];
      // Same rule as the real read: invites are counted only for an org admin.
      return { member_count: d.member_count, pending_invites: m.role === 'org_admin' ? d.admin_only_invites : null, orders_connected: d.orders_connected };
    },
    async searchKnowledge(query) {
      const q = query.toLowerCase();
      return KNOWLEDGE.filter((d) => q.split(/\s+/).some((w) => w.length > 3 && `${d.title} ${d.snippet}`.toLowerCase().includes(w)));
    },
    runLoop,
  };
}

/** `listCalls` lets a case check the memberships are read once per run. */
export function commerceUnderEval(listCalls: { n: number } = { n: 0 }): SpecialistUnderEval {
  return {
    agentId: COMMERCE_SPECIALIST_AGENT_ID,
    findingsMaxChars: COMMERCE_FINDINGS_MAX_CHARS,
    maxToolCalls: COMMERCE_MAX_TOOL_CALLS,
    tools: COMMERCE_TOOLS,
    foreignMarkers: ['Rival Pharma Secret Holdings', 'rival-secret-key', '4242'],
    run: (request, caller, signal, runLoop, recordRead) =>
      runCommerceSpecialist(request, caller, signal, commerceFixtureDeps(runLoop, recordRead, listCalls)),
  };
}

const joined = (seen: Array<{ result: string }>) => seen.map((s) => s.result).join(' / ');

export const COMMERCE_EVAL_CASES: SpecialistEvalCase[] = [
  {
    id: 'commerce.list-organizations',
    description: 'Lists the caller\'s organizations with status, vertical and role; another user\'s business stays out.',
    request: 'Which businesses do I have on Vitana?',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'list_my_organizations' }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolsUsed: ['list_my_organizations'], findingsContains: ['Sunrise Clinic | clinic | active | vertical health | role org_admin', 'Blue Bakery | shop | pending_review'] },
  },
  {
    id: 'commerce.admin-status',
    description: 'An org admin gets team size, pending invite count and the health-orders connection.',
    request: 'How is Sunrise Clinic doing?',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'get_organization_status', args: { organization: 'sunrise clinic' } }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolResultContains: ['status active', 'team members: 4', 'pending invites: 2', 'connected to receive health orders: yes'] },
  },
  {
    id: 'commerce.member-status-no-invites',
    description: 'A non-admin member never sees the invite count.',
    request: 'And the bakery?',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'get_organization_status', args: { organization: 'blue-bakery' } }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolResultContains: ['status pending_review', 'team members: 3'], findingsNotContains: ['pending invites', ': 9'] },
  },
  {
    id: 'commerce.ambiguous',
    description: 'No organization named while the caller has two: the tool asks which, listing only the caller\'s own.',
    request: 'What is my status?',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'get_organization_status', args: {} }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolResultContains: ['Which organization? This user belongs to: Sunrise Clinic, Blue Bakery.'] },
  },
  {
    id: 'commerce.single-org-default',
    description: 'With exactly one organization, an unnamed status question resolves to it.',
    request: 'Has my studio been approved?',
    userId: COMMERCE_EVAL_SOLO,
    script: [{ tools: [{ name: 'get_organization_status', args: {} }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolResultContains: ['Calm Studio | status pending_review', 'pending invites: 0'] },
  },
  {
    id: 'commerce.other-users-organization',
    description: 'The model asks about another user\'s business by name: nothing of it is read or returned.',
    request: 'What is the status of Rival?',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'get_organization_status', args: { organization: 'Rival' } }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolResultContains: ['No organization of this user matches "Rival"'] },
  },
  {
    id: 'commerce.no-memberships',
    description: 'A caller with no organization gets a plain statement, not an error.',
    request: 'Which businesses do I have?',
    userId: COMMERCE_EVAL_NONE,
    script: [{ tools: [{ name: 'list_my_organizations' }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolErrors: [], findingsContains: ['This user belongs to no business organization.'] },
  },
  {
    id: 'commerce.knowledge',
    description: 'A process question is answered from the knowledge base.',
    request: 'How does partner review work?',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'search_knowledge', args: { query: 'partner review' } }] }, { final: (s) => joined(s) }],
    expect: { ok: true, toolsUsed: ['search_knowledge'], findingsContains: ['reviewed by the Vitana team'] },
  },
  {
    id: 'commerce.write-tool-refused',
    description: 'An invite (a write) is not a tool the specialist has: refused as an error.',
    request: 'Invite my colleague.',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'invite_member', args: { email: 'x@example.com' } }] }, { final: 'Inviting happens on the Partner Organizations screen.' }],
    expect: { ok: true, toolErrors: ['invite_member'], toolResultContains: ['unknown tool: invite_member'] },
  },
  {
    id: 'commerce.tool-budget',
    description: 'A model that keeps calling tools is stopped at the tool budget and asked for the answer without tools.',
    request: 'Tell me everything about all my businesses.',
    userId: COMMERCE_EVAL_OWNER,
    script: [
      { tools: [{ name: 'get_organization_status', args: { organization: 'sunrise' } }, { name: 'get_organization_status', args: { organization: 'bakery' } }, { name: 'list_my_organizations' }, { name: 'list_my_organizations' }] },
      { tools: [{ name: 'list_my_organizations' }, { name: 'list_my_organizations' }, { name: 'list_my_organizations' }] },
      { final: 'Two organizations: Sunrise Clinic (active), Blue Bakery (pending_review).' },
    ],
    expect: { ok: true, budgetExhausted: true, findingsContains: ['Sunrise Clinic (active)'] },
  },
  {
    id: 'commerce.model-failure',
    description: 'A model failure is a failed delegation, never findings.',
    request: 'Which businesses do I have?',
    userId: COMMERCE_EVAL_OWNER,
    script: [{ tools: [{ name: 'list_my_organizations' }] }, { fail: 'throttled' }],
    expect: { ok: false, errorContains: 'throttled' },
  },
  {
    id: 'commerce.signed-out',
    description: 'A signed-out caller is refused before the model is reached.',
    request: 'Which businesses do I have?',
    userId: null,
    script: [{ final: 'should never run' }],
    expect: { ok: false, errorContains: 'signed-in user', maxModelCalls: 0 },
  },
];
