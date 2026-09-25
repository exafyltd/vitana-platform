/**
 * VTID-04473: the Jev decision registry.
 *
 * A decision is a typed classification with a fixed question set — never a
 * free prompt. Callers send an input object; the decision validates it,
 * builds an English state (Jev is strongest in English), and declares which
 * question carries the verdict, the confidence threshold under which the
 * answer is treated as an abstention, the PII policy and which internal roles
 * may use it. Wave 1 = internal roles only (docs/JEV-INTEGRATION-PLAN.md §8).
 *
 * Adding a decision: add it here with a test; no route, flag or DB change.
 */

import { z } from 'zod';
import type { JevQuestions } from './jev-types';
import type { JevPiiPolicy } from './jev-pii';

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).optional();

export interface JevDecisionDef<I = any> {
  name: string;
  description: string;
  /** Internal roles that may call it (exafy_admin/system always may). */
  roles: readonly string[];
  input: z.ZodType<I>;
  questions: JevQuestions;
  /** The question whose answer is the decision. */
  primary: string;
  /** Below this confidence the decision abstains and the caller keeps its own path. */
  threshold: number;
  pii: JevPiiPolicy;
  buildState: (input: I) => Record<string, unknown>;
}

const ENGINEERING = ['developer', 'admin', 'infra'] as const;
const BACKOFFICE = ['backoffice', 'admin'] as const;
const SUPPORT = ['staff', 'admin', 'developer', 'backoffice'] as const;

const defs: JevDecisionDef[] = [
  {
    name: 'support_ticket_triage',
    description: 'Category and urgency of a member support ticket.',
    roles: SUPPORT,
    input: z.object({ subject: optText(300), body: text(6000), surface: optText(80) }),
    questions: {
      category: {
        type: 'choice',
        instructions: 'Which category best describes this support ticket?',
        criteria: {
          bug: 'Something in the app is broken or behaves wrongly.',
          account: 'Login, profile, membership or access problem.',
          billing: 'Payment, wallet, subscription or refund question.',
          feature_request: 'A wish for something the app does not do yet.',
          question: 'A how-to or information question, nothing broken.',
          abuse: 'Harassment, spam, safety or content report about another member.',
        },
      },
      urgency: {
        type: 'score',
        instructions: 'How urgent is this ticket for the member?',
        criteria: ['Can wait', 'Normal', 'Blocks the member from using a feature', 'Safety, money or data at risk'],
      },
    },
    primary: 'category',
    threshold: 0.7,
    pii: 'redact',
    buildState: (i) => ({ ticket: { subject: i.subject ?? null, body: i.body, surface: i.surface ?? null } }),
  },
  {
    name: 'ops_error_triage',
    description: 'Root-cause class of an operational error event and whether a human is needed.',
    roles: ENGINEERING,
    input: z.object({ service: optText(120), topic: optText(200), message: text(4000), context: optText(6000) }),
    questions: {
      cause: {
        type: 'choice',
        instructions: 'What is the most likely cause class of this error?',
        criteria: {
          transient: 'A timeout, throttle or blip that resolves by itself.',
          configuration: 'A missing or wrong env var, secret, permission or flag.',
          code_defect: 'A bug in our code.',
          dependency: 'An external provider or service is failing.',
          data: 'Unexpected or malformed data in the database or request.',
        },
      },
      needs_human: { type: 'noul', instructions: 'Does this need a human to act now?' },
    },
    primary: 'cause',
    threshold: 0.7,
    pii: 'redact',
    buildState: (i) => ({ error_event: { service: i.service ?? null, topic: i.topic ?? null, message: i.message, context: i.context ?? null } }),
  },
  {
    name: 'ci_failure_bucket',
    description: 'Which kind of CI failure a failing check is.',
    roles: ENGINEERING,
    input: z.object({ check_name: text(200), log_excerpt: text(8000) }),
    questions: {
      bucket: {
        type: 'choice',
        instructions: 'Which kind of CI failure is this?',
        criteria: {
          test_failure: 'An assertion in a test failed.',
          type_error: 'TypeScript or another compiler rejected the code.',
          lint: 'A lint, format or static rule failed.',
          governance_gate: 'A repository governance gate failed (VTID, evidence pack, scope, markers).',
          dependency: 'Installing or resolving a dependency failed.',
          infrastructure: 'The runner, network or an external service failed before the code was judged.',
        },
      },
    },
    primary: 'bucket',
    threshold: 0.7,
    pii: 'redact',
    buildState: (i) => ({ ci_check: { name: i.check_name, log_excerpt: i.log_excerpt } }),
  },
  {
    name: 'finding_duplicate',
    description: 'Whether a new autopilot finding duplicates an existing one.',
    roles: ENGINEERING,
    input: z.object({ finding: text(4000), candidate: text(4000) }),
    questions: {
      duplicate: { type: 'noul', instructions: 'Do the new finding and the existing finding describe the same underlying problem?' },
    },
    primary: 'duplicate',
    threshold: 0.75,
    pii: 'redact',
    buildState: (i) => ({ new_finding: i.finding, existing_finding: i.candidate }),
  },
  {
    name: 'document_relevance',
    description: 'Whether a document is relevant to a back-office search, and how strongly.',
    roles: ['backoffice', 'admin', 'staff'],
    input: z.object({ query: text(1000), title: optText(300), text: text(8000) }),
    questions: {
      relevant: { type: 'noul', instructions: 'Is this document relevant to the search request?' },
      strength: {
        type: 'score',
        instructions: 'How strongly does the document match the search request?',
        criteria: ['Unrelated', 'Mentions the topic in passing', 'Clearly about the topic', 'Exactly what was asked for'],
      },
    },
    primary: 'relevant',
    threshold: 0.7,
    pii: 'redact',
    buildState: (i) => ({ search_request: i.query, document: { title: i.title ?? null, text: i.text } }),
  },
  {
    name: 'account_classification',
    description: 'What kind of business account a record is.',
    roles: BACKOFFICE,
    input: z.object({ name: text(300), notes: optText(4000) }),
    questions: {
      kind: {
        type: 'choice',
        instructions: 'What kind of account is this for our business?',
        criteria: {
          customer: 'Buys from us.',
          supplier: 'We buy from them.',
          partner: 'Works with us (affiliate, clinic, merchant, practitioner).',
          prospect: 'A possible customer or partner, no deal yet.',
          other: 'None of the above.',
        },
      },
    },
    primary: 'kind',
    threshold: 0.7,
    pii: 'redact',
    buildState: (i) => ({ account: { name: i.name, notes: i.notes ?? null } }),
  },
  {
    name: 'contract_clause_flag',
    description: 'Whether a contract excerpt contains a given kind of clause, and its risk.',
    roles: BACKOFFICE,
    input: z.object({ clause_type: text(200), excerpt: text(8000) }),
    questions: {
      present: { type: 'noul', instructions: 'Does the excerpt contain a clause of the named type?' },
      risk: {
        type: 'score',
        instructions: 'How risky is this excerpt for us?',
        criteria: ['No risk', 'Standard terms', 'Unusual, worth a look', 'Needs legal review'],
      },
    },
    primary: 'present',
    threshold: 0.7,
    pii: 'redact',
    buildState: (i) => ({ clause_type: i.clause_type, contract_excerpt: i.excerpt }),
  },
  {
    name: 'lead_score',
    description: 'How well a lead fits what we sell.',
    roles: ['backoffice', 'admin', 'staff', 'professional'],
    input: z.object({ lead: text(4000), offering: optText(2000) }),
    questions: {
      fit: {
        type: 'score',
        instructions: 'How well does this lead fit our offering?',
        criteria: ['No fit', 'Weak fit', 'Good fit', 'Strong fit, contact now'],
      },
    },
    primary: 'fit',
    threshold: 0.6,
    pii: 'redact',
    buildState: (i) => ({ lead: i.lead, offering: i.offering ?? 'Vitanaland longevity community, health services and products' }),
  },
  {
    name: 'moderation_severity',
    description: 'Category and severity of reported community content, for a human moderator.',
    roles: ['admin', 'staff'],
    input: z.object({ content: text(6000), report_reason: optText(500) }),
    questions: {
      category: {
        type: 'choice',
        instructions: 'What kind of problem, if any, does this content have?',
        criteria: {
          none: 'Nothing wrong.',
          spam: 'Advertising, scams or repeated junk.',
          harassment: 'Insults, threats or targeting a person.',
          medical_misinformation: 'Dangerous or false health claims.',
          explicit: 'Sexual or graphic content.',
          other: 'Another policy problem.',
        },
      },
      severity: {
        type: 'score',
        instructions: 'How severe is it?',
        criteria: ['None', 'Low', 'Medium', 'High', 'Remove immediately'],
      },
    },
    primary: 'category',
    threshold: 0.75,
    pii: 'redact',
    buildState: (i) => ({ reported_content: i.content, report_reason: i.report_reason ?? null }),
  },
  {
    name: 'professional_lead_fit',
    description: 'How well a client request fits a professional\'s services.',
    roles: ['professional', 'staff', 'admin'],
    input: z.object({ request: text(4000), services: text(3000) }),
    questions: {
      fit: {
        type: 'score',
        instructions: 'How well do these services match the client request?',
        criteria: ['Not a match', 'Partial match', 'Good match', 'Ideal match'],
      },
    },
    primary: 'fit',
    threshold: 0.6,
    pii: 'redact',
    buildState: (i) => ({ client_request: i.request, professional_services: i.services }),
  },
];

export const JEV_DECISIONS: ReadonlyMap<string, JevDecisionDef> = new Map(defs.map((d) => [d.name, d]));

export function getJevDecision(name: string): JevDecisionDef | undefined {
  return JEV_DECISIONS.get(name);
}

export function listJevDecisions(): JevDecisionDef[] {
  return [...JEV_DECISIONS.values()];
}
