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
import type { JevPlane } from './jev-access';
import type { JevDataClass } from './jev-policy';

export type JevCommunityClass = 'A' | 'B' | 'C';

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
  /** VTID-04754: planes this decision may run on (jev-policy.ts). */
  planes: readonly JevPlane[];
  /** VTID-04754: the class of data the state carries to TypeSafe. */
  data: JevDataClass;
  /**
   * VTID-04872: community cost class, for calls counted as member spend
   * (approved 2026-10-03). A = always-on community use, no per-member quota;
   * B = per-member daily quota (ranking, personalisation); C = off on the
   * member plane. Unset on a member-spend call counts as B.
   */
  community_class?: JevCommunityClass;
  /** VTID-04872: a safety decision (moderation, abuse, crisis) — never quota-limited. */
  safety?: boolean;
  buildState: (input: I) => Record<string, unknown>;
}

const ENGINEERING = ['developer', 'admin', 'infra'] as const;

// VTID-04883: shared shapes for the community ranking decisions (D gates).
/** Flat, small fields only: ids are never names, numbers are bands or scores. */
const rankingFields = z.record(z.union([z.string().max(120), z.number(), z.boolean(), z.null()]));
const rankingInput = z.object({ context: rankingFields, candidates: z.array(rankingFields).min(1).max(8) });
export const RANKING_SLOTS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const;
const SLOT_CRITERIA: Record<string, string> = Object.fromEntries(
  RANKING_SLOTS.map((s, i) => [s, `Candidate ${s} (number ${i + 1} in the list). Only choose a slot that is in the list.`]),
);
const RANKING_DECISIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['community_calendar_priority', 'Which upcoming calendar event matters most for this member now (D1, shadow of the calendar prioritizer).', 'Which listed calendar event should be this member\'s top priority right now?'],
  ['community_next_action', 'Which next action Vitana should offer this member (D2, shadow of the next-action composer).', 'Which listed next action is the most useful one for Vitana to offer this member now?'],
  ['community_match_rerank', 'Which Find-a-Match candidate fits the member\'s request best (D3, shadow re-rank check of the SQL ranking).', 'Which listed candidate intent fits the member\'s request best?'],
  ['community_suggestion_pick', 'Which Autopilot suggestion should come first for this member (D5, shadow of the pillar-weighted ranking).', 'Which listed suggestion should this member see first?'],
  ['community_feed_pick', 'Which Discover product should lead this member\'s feed (D7, shadow of the feed ranker; sampled).', 'Which listed product should be first in this member\'s feed?'],
  ['community_member_tiebreak', 'Which community member to suggest when the search found no signal (D8, shadow of the query-hash fallback).', 'No listed member matched the search on any signal. Which one is the most sensible suggestion for this search?'],
];
const BACKOFFICE = ['backoffice', 'admin'] as const;
const SUPPORT = ['staff', 'admin', 'developer', 'backoffice'] as const;

// VTID-04754 planes. Telemetry decisions may also run for Community Autopilot.
const INTERNAL: readonly JevPlane[] = ['internal'];
const INTERNAL_AND_AUTOPILOT: readonly JevPlane[] = ['internal', 'system_autopilot'];

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
    planes: INTERNAL,
    // a member's message addressed to the business, handled by staff; PII redacted
    data: 'business',
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
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
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
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
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
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
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
    planes: INTERNAL,
    data: 'business',
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
    planes: INTERNAL,
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({ account: { name: i.name, notes: i.notes ?? null } }),
  },
  {
    // VTID-04810 (P2 E5): a company/customer was just created — is it the
    // same business as one that already exists? Companies only, business
    // fields only (people's names wait for the DPA).
    name: 'account_duplicate',
    description: 'Whether a newly created business account is the same company as an existing one.',
    roles: BACKOFFICE,
    input: z.object({ new_name: text(300), new_details: optText(1500), existing_name: text(300), existing_details: optText(1500) }),
    questions: {
      same: {
        type: 'noul',
        instructions: 'Are these two records the same company (the same legal entity or the same business under a variant name), so the new one is a duplicate?',
      },
    },
    primary: 'same',
    threshold: 0.7,
    planes: INTERNAL,
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({ new_account: { name: i.new_name, details: i.new_details ?? null }, existing_account: { name: i.existing_name, details: i.existing_details ?? null } }),
  },
  {
    // VTID-04819 (P3 E8): a payment was allocated to an invoice — does it
    // really belong to it? Amounts, currencies, dates, references and whether
    // the two parties are the same; never a party's name.
    name: 'payment_invoice_match',
    description: 'Whether a payment allocated to an invoice actually matches it.',
    roles: BACKOFFICE,
    input: z.object({
      payment_amount: z.number().nullable(),
      payment_currency: optText(10),
      payment_date: optText(20),
      payment_reference: optText(140),
      allocated_amount: z.number().nullable(),
      invoice_total: z.number().nullable(),
      invoice_outstanding_before: z.number().nullable(),
      invoice_currency: optText(10),
      invoice_due_date: optText(20),
      invoice_number: optText(140),
      same_party: z.boolean().nullable(),
      reference_mentions_invoice: z.boolean(),
    }),
    questions: {
      matches: { type: 'noul', instructions: 'Does this payment belong to this invoice, so the allocation is right?' },
      issue: {
        type: 'choice',
        instructions: 'What is the main problem, if any?',
        criteria: {
          none: 'It matches.',
          amount_mismatch: 'The amounts do not fit (not the total, the outstanding amount or a plausible part payment).',
          party_mismatch: 'The payment comes from a different party than the invoice is for.',
          currency_mismatch: 'Different currencies without a conversion.',
          already_settled: 'The invoice was already paid or the payment already used.',
          unclear: 'Not enough information to tell.',
        },
      },
    },
    primary: 'matches',
    threshold: 0.7,
    planes: INTERNAL,
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({
      payment: { amount: i.payment_amount, currency: i.payment_currency ?? null, date: i.payment_date ?? null, reference: i.payment_reference ?? null, allocated: i.allocated_amount },
      invoice: { total: i.invoice_total, outstanding_before: i.invoice_outstanding_before, currency: i.invoice_currency ?? null, due_date: i.invoice_due_date ?? null, number: i.invoice_number ?? null },
      same_party: i.same_party,
      reference_mentions_invoice: i.reference_mentions_invoice,
    }),
  },
  {
    // VTID-04821 (P3 E1): an Exafy staff member searched the company drives
    // (Exafy Google Drive / OneDrive). Which result best answers the search,
    // judged from file names, kinds and dates only — never file contents.
    name: 'company_doc_relevance',
    description: 'Which company document found by a search best answers it.',
    roles: ['admin', 'developer', 'backoffice'],
    input: z.object({
      query: text(300),
      candidates: z.array(z.object({ n: z.number().int().min(1).max(10), name: text(300), kind: text(40), modified: optText(10), source: text(20) })).min(1).max(10),
    }),
    questions: {
      best: {
        type: 'choice',
        instructions: 'Which numbered document best answers the search? Answer none if no document fits.',
        criteria: {
          d1: 'Document 1.', d2: 'Document 2.', d3: 'Document 3.', d4: 'Document 4.', d5: 'Document 5.',
          d6: 'Document 6.', d7: 'Document 7.', d8: 'Document 8.', d9: 'Document 9.', d10: 'Document 10.',
          none: 'None of the documents answers the search.',
        },
      },
    },
    primary: 'best',
    threshold: 0.6,
    planes: INTERNAL,
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({ search: i.query, documents: i.candidates }),
  },
  {
    // VTID-04825 (P3 F, second slice): a Dev Autopilot execution ended badly.
    // Its root-cause class, from status, stage and the failure texts (cut,
    // redacted) — never plan bodies or diffs. Counted weekly.
    name: 'execution_root_cause',
    description: 'The root-cause class of a Dev Autopilot execution that failed, was reverted, escalated or cancelled.',
    roles: ENGINEERING,
    input: z.object({
      status: text(30),
      failure_stage: optText(30),
      error: optText(400),
      gate_reason: optText(200),
      bridge_reason: optText(200),
      deploy_error: optText(200),
      failed_checks: z.array(text(80)).max(10),
      fix_mode: z.boolean(),
      cancelled_by_human: z.boolean(),
    }),
    questions: {
      cause: {
        type: 'choice',
        instructions: 'What is the root cause this execution ended badly?',
        criteria: {
          llm_quota_or_outage: 'The model provider failed: a quota, rate limit or outage.',
          scope_violation: 'The change touched files outside its allowed scope.',
          ci_test_failure: 'Tests or checks failed in CI.',
          merge_conflict: 'The branch could not merge (conflict, dirty state).',
          deploy_failure: 'The deploy failed.',
          verification_regression: 'The deployed change caused errors and was rolled back.',
          plan_too_broad: 'The task was too broad or vague to finish.',
          agent_turn_cap: 'The agent ran out of turns without finishing.',
          cancelled_by_human: 'A person cancelled or rejected it.',
          unknown: 'Not enough information to tell.',
        },
      },
    },
    primary: 'cause',
    threshold: 0.6,
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    pii: 'redact',
    buildState: (i) => ({ execution: i }),
  },
  {
    // VTID-04822 (P3 E2): a company document found by E1 arrives untyped.
    // Its type decides where it goes next (clause review, payment match,
    // knowledge base). From name, kind and source only — never contents.
    name: 'document_type',
    description: 'What kind of company document this is, so it can be routed.',
    roles: ['admin', 'developer', 'backoffice'],
    input: z.object({ name: text(300), kind: text(40), source: text(20) }),
    questions: {
      type: {
        type: 'choice',
        instructions: 'From the file name and kind, what type of company document is this?',
        criteria: {
          contract: 'A contract, agreement, NDA or terms signed between parties.',
          invoice: 'An invoice, receipt or credit note.',
          quote_or_order: 'A quote, offer or purchase order.',
          policy: 'An internal policy, guideline or procedure.',
          specification: 'A product or technical specification or requirements.',
          presentation: 'A slide deck or pitch.',
          report: 'A report or analysis.',
          legal_corporate: 'A company-law record: articles, register extract, shareholder or power-of-attorney document.',
          hr: 'A personnel document: CV, payroll, employment record.',
          marketing: 'Marketing material: brochure, flyer, campaign, newsletter.',
          other: 'None of these, or not enough to tell.',
        },
      },
    },
    primary: 'type',
    threshold: 0.6,
    planes: INTERNAL,
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({ document: { name: i.name, kind: i.kind, source: i.source } }),
  },
  {
    // VTID-04820 (P3 E10): a partner submitted its onboarding. Advisory triage
    // for the reviewer from business facts and the checklist — never the
    // people behind it. Approval stays with the rules and a human.
    name: 'partner_onboarding_triage',
    description: 'Whether a submitted partner onboarding looks ready to go live, and the main concern.',
    roles: BACKOFFICE,
    input: z.object({
      partner_type: text(40),
      commerce_vertical: optText(60),
      legal_name: optText(200),
      country: optText(2),
      website_host: optText(200),
      has_vat_id: z.boolean(),
      verification_level_required: z.number().int().min(0).max(2),
      steps: z.array(z.object({ key: text(60), required: z.boolean(), status: text(20), missing: z.array(text(60)).max(10) })).max(20),
      rules_outcome: text(20),
    }),
    questions: {
      ready: { type: 'noul', instructions: 'From these facts and checklist results, does this partner look ready to go live?' },
      concern: {
        type: 'choice',
        instructions: 'What is the main concern for the reviewer, if any?',
        criteria: {
          none: 'Nothing stands out.',
          verification_gap: 'A required verification is missing or failed.',
          identity_mismatch: 'The legal name, website and country do not fit together.',
          category_risk: 'The partner type or vertical needs extra care (health claims, regulated products).',
          incomplete_setup: 'Catalogue, terms or connections are not really in place.',
          unclear: 'Not enough information to tell.',
        },
      },
    },
    primary: 'ready',
    threshold: 0.7,
    planes: INTERNAL,
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({ partner: { type: i.partner_type, vertical: i.commerce_vertical ?? null, legal_name: i.legal_name ?? null, country: i.country ?? null, website: i.website_host ?? null, has_vat_id: i.has_vat_id }, verification_level_required: i.verification_level_required, checklist: i.steps, rules_outcome: i.rules_outcome }),
  },
  {
    // VTID-04811 (P2 E7): a High-risk Backoffice command is waiting for a
    // second person. A risk hint for the approver, from the command's own
    // business fields — never who requested it or any person's data.
    name: 'approval_risk',
    description: 'How risky a queued High-risk Backoffice command is, as a hint for the approver.',
    roles: BACKOFFICE,
    input: z.object({
      command_type: text(120),
      action: text(120),
      escalations: z.array(z.string().trim().max(80)).max(10),
      fields: text(2000),
      payload_keys: z.array(z.string().trim().max(60)).max(60),
    }),
    questions: {
      risk: {
        type: 'score',
        instructions: 'How risky is it to approve this command as it stands (money or records lost, wrong counterparty, irreversible effect, unusual for this kind of command)?',
        criteria: ['Routine, approve', 'Some risk, check the details', 'High risk, check carefully', 'Looks wrong, do not approve as is'],
      },
    },
    primary: 'risk',
    threshold: 0.6,
    planes: INTERNAL,
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({ command: { type: i.command_type, action: i.action, escalations: i.escalations, fields: i.fields, payload_keys: i.payload_keys } }),
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
    planes: INTERNAL,
    data: 'business',
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
    planes: INTERNAL,
    data: 'business',
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
    planes: INTERNAL_AND_AUTOPILOT,
    // content a member posted for other members: member rules apply
    data: 'member_content',
    // VTID-04872: moderation protects members — never stopped by a quota
    community_class: 'B',
    safety: true,
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
    planes: INTERNAL,
    // a client request addressed to the professional's business; PII redacted
    data: 'business',
    pii: 'redact',
    buildState: (i) => ({ client_request: i.request, professional_services: i.services }),
  },
  {
    // VTID-04764 (Jev P1 A1): mid-run progress check for the Dev Autopilot
    // coding agent, asked every N turns in shadow mode. Telemetry only: the
    // task summary and the agent's own tool activity, never member data.
    name: 'agent_progress_check',
    description: 'Is a Dev Autopilot coding run converging, and what should it do next?',
    roles: ENGINEERING,
    input: z.object({
      task: text(2000),
      turn: z.number().int().min(1).max(500),
      max_turns: z.number().int().min(1).max(500),
      tool_calls: z.number().int().min(0).max(5000),
      has_edited: z.boolean(),
      idle_turns: z.number().int().min(0).max(500),
      failed_checks: z.number().int().min(0).max(500),
      passed_checks: z.number().int().min(0).max(500),
      recent_activity: z.array(z.string().trim().max(160)).max(40),
    }),
    questions: {
      next_step: {
        type: 'choice',
        instructions: 'Given the task and the agent activity so far, what should this coding run do next?',
        criteria: {
          continue: 'It is making real progress toward the task (new files read with purpose, edits landing, checks moving towards green); keep going.',
          commit: 'It already has a usable change for the task; it should run its checks and finish now instead of exploring further.',
          handoff: 'It is going in circles or blocked on something it cannot resolve itself (unclear task, missing access, repeated identical failures); stop and hand off its findings.',
          stop: 'The task cannot be completed with these tools in the remaining turns; further turns only spend tokens.',
        },
      },
      will_finish: {
        type: 'noul',
        instructions: 'Will this run finish the task with a passing change before it runs out of turns?',
      },
    },
    primary: 'next_step',
    threshold: 0.6,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({
      task: i.task,
      progress: {
        turn: i.turn,
        max_turns: i.max_turns,
        turns_remaining: Math.max(0, i.max_turns - i.turn),
        tool_calls: i.tool_calls,
        has_edited: i.has_edited,
        idle_turns: i.idle_turns,
        failed_checks: i.failed_checks,
        passed_checks: i.passed_checks,
      },
      recent_activity: i.recent_activity,
    }),
  },
  {
    // VTID-04774 (Jev P1 A2): before a Dev Autopilot execution is dispatched,
    // can the agent's tools finish it in one PR? Telemetry only: the
    // finding's title, plan excerpt and file paths — never file contents.
    name: 'execution_feasibility',
    description: 'Can the Dev Autopilot agent finish this execution with its tools, and if not, what blocks it?',
    roles: ENGINEERING,
    input: z.object({
      title: text(300),
      plan: text(3000),
      files: z.array(z.string().trim().max(200)).max(40),
      fix_mode: z.boolean(),
      prior_failure: optText(800),
      risk_class: optText(40),
      source_type: optText(60),
    }),
    questions: {
      feasibility: {
        type: 'choice',
        instructions: 'Can a coding agent that can only read, search and edit repository files and run tsc/jest finish this task in one pull request?',
        criteria: {
          feasible: 'Yes: the change is in code the agent can reach and the task says clearly what to change.',
          needs_human: 'It needs a human decision, product choice, approval, credentials or data the agent cannot reach.',
          needs_infra: 'It needs a change outside the repository: AWS/console, secrets, CI settings, DNS, a provider account or billing.',
          too_large: 'It is a multi-PR or open-ended effort, far beyond one focused change.',
          unclear: 'The task is too vague or contradictory to know what to change.',
        },
      },
      will_succeed: {
        type: 'noul',
        instructions: 'Will the agent open a correct pull request for this task?',
      },
    },
    primary: 'feasibility',
    threshold: 0.6,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({
      task: { title: i.title, plan: i.plan, files: i.files, fix_mode: i.fix_mode, prior_failure: i.prior_failure ?? null },
      context: { risk_class: i.risk_class ?? null, source_type: i.source_type ?? null },
    }),
  },
  {
    // VTID-04804 (Jev P2 C2): a day's worth of one voice backstop firing —
    // a product defect worth a finding, or the safety net doing its job?
    // Counts and session metrics only, never what anyone said.
    name: 'backstop_cluster_defect',
    description: 'Whether a cluster of voice backstop firings is a defect worth a Dev Autopilot finding.',
    roles: ENGINEERING,
    input: z.object({
      stage: text(80),
      sub_cause: optText(80),
      firings: z.number().int().min(0),
      sessions: z.number().int().min(0),
      window_hours: z.number().min(0).max(168),
      avg_turns: z.number().min(0).optional(),
      what_it_means: text(600),
    }),
    questions: {
      defect: {
        type: 'noul',
        instructions: 'Is this a recurring product defect someone should fix (a prompt, a tool contract, a detection), rather than the safety net working as intended?',
      },
      kind: {
        type: 'choice',
        instructions: 'What kind of problem is it most likely?',
        criteria: {
          prompt_instruction: 'The model is not told clearly enough what to do.',
          tool_contract: 'A tool is missing, mis-described or returns something the model misreads.',
          model_limitation: 'The model cannot reliably do this; the backstop is the right long-term answer.',
          expected_safety_net: 'Rare, expected cases the backstop exists for.',
          detection_false_positive: 'The backstop fires when nothing was actually wrong.',
        },
      },
    },
    primary: 'defect',
    threshold: 0.7,
    pii: 'forbid',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ cluster: i }),
  },
  {
    // VTID-04803 (Jev P2 B6): after a fix deployed and the verification window
    // closed — is the original problem actually resolved? Finding text, changed
    // paths and the rules' window summary only.
    name: 'fix_verification',
    description: 'Whether a deployed Dev Autopilot fix resolved the problem its finding described.',
    roles: ENGINEERING,
    input: z.object({
      finding: text(3000),
      changed_files: z.array(z.string().max(300)).max(60),
      verification: text(2000),
      source_type: optText(60),
    }),
    questions: {
      resolved: { type: 'noul', instructions: 'Is the problem the finding describes resolved by this change, given the verification evidence?' },
      evidence_sufficient: { type: 'noul', instructions: 'Is the verification evidence enough to tell whether the original problem is gone?' },
    },
    primary: 'resolved',
    threshold: 0.7,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ finding: { text: i.finding, source: i.source_type ?? null }, change: { files: i.changed_files }, verification: i.verification }),
  },
  {
    // VTID-04802 (Jev P2 B4): could this commit, from the last deploy, have
    // caused this error? Commit subject and file paths only — never a diff.
    name: 'commit_cause_score',
    description: 'How likely a recently deployed commit caused an operational error.',
    roles: ENGINEERING,
    input: z.object({
      error: text(4000),
      endpoint: optText(200),
      commit_message: text(300),
      files: z.array(z.string().max(300)).max(60),
    }),
    questions: {
      likelihood: {
        type: 'score',
        instructions: 'How likely is it that this commit caused the error?',
        criteria: ['Unrelated', 'Possible', 'Likely', 'Almost certainly the cause'],
      },
    },
    primary: 'likelihood',
    threshold: 0.5,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ error_event: { message: i.error, endpoint: i.endpoint ?? null }, commit: { subject: i.commit_message, files: i.files } }),
  },
  {
    // VTID-04801 (Jev P2 A4): a new attempt at a finding whose last attempt
    // failed — is it the same approach again? Plans and the failure text
    // only (paths, never code).
    name: 'execution_repeat',
    description: 'Whether a new Dev Autopilot attempt repeats the approach of an attempt that already failed.',
    roles: ENGINEERING,
    input: z.object({
      title: optText(300),
      previous_plan: text(6000),
      previous_failure: text(2000),
      new_plan: text(6000),
      fix_mode: z.boolean(),
    }),
    questions: {
      repeat: {
        type: 'noul',
        instructions: 'Does the new plan take materially the same approach as the previous plan, with nothing that addresses why the previous attempt failed?',
      },
      will_succeed: { type: 'noul', instructions: 'Will the new attempt succeed (open its pull request)?' },
    },
    primary: 'repeat',
    threshold: 0.7,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({
      task: i.title ?? null,
      previous_attempt: { plan: i.previous_plan, failure: i.previous_failure },
      new_attempt: { plan: i.new_plan, fix_mode: i.fix_mode },
    }),
  },
  {
    // VTID-04775 (Jev P1 C1): how did an ORB voice session end? Post-session,
    // counters and close reasons only — never what anyone said.
    name: 'voice_session_outcome',
    description: 'Outcome class of an ORB voice session from its own telemetry (post-session).',
    roles: ENGINEERING,
    input: z.object({
      stop_reason: optText(80),
      provider: optText(40),
      lang: optText(16),
      duration_s: z.number().min(0).max(86_400),
      turns: z.number().int().min(0).max(5000),
      user_turns: z.number().int().min(0).max(5000).optional(),
      model_turns: z.number().int().min(0).max(5000).optional(),
      audio_in_chunks: z.number().int().min(0),
      audio_in_forwarded: z.number().int().min(0).optional(),
      audio_out_chunks: z.number().int().min(0),
      greeting_sent: z.boolean().optional(),
      reconnects: z.number().int().min(0).max(1000).optional(),
      watchdog_reason: optText(80),
      tool_call_streak: z.number().int().min(0).max(1000).optional(),
      connection_failed: z.boolean().optional(),
      rule_class: optText(60),
    }),
    questions: {
      outcome: {
        type: 'choice',
        instructions: 'From these voice-session counters, how did the session end?',
        criteria: {
          completed: 'A real conversation took place (several turns both ways) and ended normally.',
          user_left_early: 'The member left within the first seconds or after the greeting, with no sign of a fault.',
          no_engagement: 'The member spoke but the assistant never really engaged (no or almost no model turns).',
          one_way_audio: 'Audio flowed only one way: the assistant was heard but the member was not, or the reverse.',
          connection_dropped: 'The connection broke or was reconnected mid-session; the session did not end by choice.',
          model_stalled: 'The assistant stopped responding mid-session (watchdog fired, long silence).',
          looping: 'The assistant got stuck in a loop of tool calls or repeated turns.',
          failed_to_start: 'The session never really started (connection failed, no greeting, no audio out).',
        },
      },
      needs_fix: {
        type: 'noul',
        instructions: 'Is this a product or engineering failure someone should fix, rather than normal member behaviour?',
      },
    },
    primary: 'outcome',
    threshold: 0.6,
    pii: 'forbid',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ session: i }),
  },
  {
    // VTID-04805 (P2 C3): a voice session stalled (the watchdog fired). From
    // the session's own counters and timings, what most likely made it slow?
    // Telemetry only, never what anyone said.
    name: 'slow_session_cause',
    description: 'The most likely cause of a stalled ORB voice session, from its telemetry.',
    roles: ENGINEERING,
    input: z.object({
      stall_reason: text(60),
      timeout_ms: z.number().int().min(0).optional(),
      provider: optText(60),
      lang: optText(16),
      turn_count: z.number().int().min(0).optional(),
      audio_in_chunks: z.number().int().min(0).optional(),
      audio_out_chunks: z.number().int().min(0).optional(),
      greeting_sent: z.boolean().optional(),
      prewarm_missed: z.boolean(),
      context_build_ms: z.number().min(0).optional(),
      context_chars: z.number().int().min(0).optional(),
      tool_catalog_bytes: z.number().int().min(0).optional(),
      tool_calls: z.number().int().min(0),
      tool_failures: z.number().int().min(0),
      upstream_close_reason: optText(60),
      reconnects: z.number().int().min(0),
    }),
    questions: {
      cause: {
        type: 'choice',
        instructions: 'From these voice-session counters and timings, what most likely made the session stall?',
        criteria: {
          upstream_connection: 'The voice model stream was not ready or dropped (no prewarmed stream, upstream closed, no acknowledgement of forwarded audio).',
          upstream_model: 'The stream was up but the model was slow or silent (no greeting or reply in time) with nothing else unusual.',
          context_build: 'Building the session context or instruction took long enough to delay the model.',
          tool_call: 'A tool call was slow or failed and the reply waited on it.',
          prompt_size: 'The instruction or tool catalog was so large it slowed or confused the model.',
          client_audio: 'Audio from the member stopped or never arrived; the client or network side.',
          unknown: 'The counters do not point to a cause.',
        },
      },
      fixable: {
        type: 'noul',
        instructions: 'Is this something the product could fix, rather than a one-off network or provider blip?',
      },
    },
    primary: 'cause',
    threshold: 0.6,
    pii: 'forbid',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ session: i }),
  },
  {
    // VTID-04806 (P2 A3): before the planner spends a session on a Dev
    // Autopilot finding — is it concrete enough to plan at all?
    name: 'finding_plannable',
    description: 'Whether a Dev Autopilot finding is specific and bounded enough for the planner to produce a working plan.',
    roles: ENGINEERING,
    input: z.object({
      title: text(300),
      summary: text(3000),
      domain: optText(80),
      risk_class: optText(20),
      signal_type: optText(80),
      suggested_action: optText(1000),
      files: z.array(z.string().trim().max(300)).max(20),
    }),
    questions: {
      plannable: {
        type: 'noul',
        instructions: 'Is this finding specific and bounded enough that an engineer could write a concrete, file-level change plan for it without asking anyone first?',
      },
      blocker: {
        type: 'choice',
        instructions: 'What most stands in the way of planning it?',
        criteria: {
          none: 'Nothing; the problem, the place and the expected change are clear.',
          too_vague: 'The problem or the expected change is not stated clearly enough.',
          too_broad: 'It spans so much of the codebase that one plan cannot cover it.',
          needs_human_decision: 'It needs a product or design decision before anyone can plan it.',
          missing_location: 'It does not say where in the code the problem is.',
        },
      },
    },
    primary: 'plannable',
    threshold: 0.7,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ finding: i }),
  },
  {
    // VTID-04807 (P2 A5): the agent runner re-runs only the name-paired test
    // suites before opening a PR. Should this other suite — one that imports
    // a changed module — run too?
    name: 'test_suite_relevance',
    description: 'Whether an existing test suite that imports changed code is likely to catch a regression from this change.',
    roles: ENGINEERING,
    input: z.object({
      change_title: text(300),
      changed_files: z.array(z.string().trim().max(300)).max(20),
      test_path: text(300),
      imports_changed: z.array(z.string().trim().max(120)).max(10),
      test_titles: z.array(z.string().trim().max(160)).max(30),
    }),
    questions: {
      run: {
        type: 'noul',
        instructions: 'Would running this test suite be likely to catch a regression introduced by this change, judging from what the suite tests and which changed modules it imports?',
      },
    },
    primary: 'run',
    threshold: 0.7,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ change: { title: i.change_title, files: i.changed_files }, suite: { path: i.test_path, imports: i.imports_changed, titles: i.test_titles } }),
  },
  {
    // VTID-04808 (P2 A7): two Dev Autopilot PRs are green at the same time.
    // If the first merges now, will the second conflict or break?
    name: 'pr_clash',
    description: 'Whether merging one green Dev Autopilot change now is likely to make another open one conflict or break.',
    roles: ENGINEERING,
    input: z.object({
      merging_title: text(300),
      merging_files: z.array(z.string().trim().max(300)).max(40),
      other_title: text(300),
      other_files: z.array(z.string().trim().max(300)).max(40),
      shared_files: z.array(z.string().trim().max(300)).max(40),
      shared_dirs: z.array(z.string().trim().max(300)).max(20),
    }),
    questions: {
      clash: {
        type: 'noul',
        instructions: 'If the first change is merged now, is the second change likely to hit a merge conflict or break (its tests or its behaviour) because of it?',
      },
    },
    primary: 'clash',
    threshold: 0.7,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({
      merging: { title: i.merging_title, files: i.merging_files },
      other: { title: i.other_title, files: i.other_files },
      overlap: { files: i.shared_files, directories: i.shared_dirs },
    }),
  },
  {
    // VTID-04815 (P3 A9): how risky is this Dev Autopilot diff to land, as an
    // advisory for the reviewer? The finding's risk_class is set before any
    // code exists; this reads the change itself.
    name: 'change_risk',
    description: 'How risky a Dev Autopilot change is to merge and deploy, judged from its diff.',
    roles: ENGINEERING,
    input: z.object({
      finding_title: text(300),
      finding_risk_class: optText(20),
      files: z.array(z.string().trim().max(300)).max(60),
      diff_stat: text(4000),
      patch_excerpt: text(8000),
      tests_in_diff: z.number().int().min(0),
      fix_rounds: z.number().int().min(0),
    }),
    questions: {
      risk: {
        type: 'score',
        instructions: 'How likely is this change to break CI, production behaviour or other code once merged and deployed?',
        criteria: ['Low: small, contained, covered by tests', 'Moderate: a careful look is enough', 'High: shared or central code, thin coverage', 'Very high: likely to break something'],
      },
    },
    primary: 'risk',
    threshold: 0.6,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({
      finding: { title: i.finding_title, risk_class: i.finding_risk_class ?? null },
      change: { files: i.files, stat: i.diff_stat, patch_excerpt: i.patch_excerpt, tests_in_diff: i.tests_in_diff, fix_rounds: i.fix_rounds },
    }),
  },
  {
    // VTID-04816 (P3 A10): which lane does an Operator Console message belong
    // to? Every turn today sends the model the whole tool catalog (~60 tools).
    name: 'operator_route',
    description: 'Which kind of work an Operator Console message asks for.',
    roles: ENGINEERING,
    input: z.object({ message: text(4000), developer_tools: z.boolean() }),
    questions: {
      lane: {
        type: 'choice',
        instructions: 'What does this Operator Console message ask the assistant to do?',
        criteria: {
          answer_only: 'Answer or explain from what it already knows; no lookup or action needed.',
          task_management: 'Create, run, check, approve or reject tasks, specs, executions or recommendations.',
          code_lookup: 'Look into the codebase: search, read files, code structure, risk of a file.',
          ops_diagnostics: 'Check live systems: services, logs, database, events, deploy and CI health, a failure.',
          delivery: 'Open or merge a pull request, or deploy a service.',
          community: 'Community and member features: people, events, groups, marketplace, messages, wearables.',
        },
      },
    },
    primary: 'lane',
    threshold: 0.6,
    pii: 'redact',
    planes: INTERNAL,
    data: 'telemetry',
    buildState: (i) => ({ message: i.message, developer_tools_available: i.developer_tools }),
  },
  {
    // VTID-04817 (P3 C4): a voice opener (how Vitana starts the session and
    // which next step it offers), over a week: is it working? Counts only.
    name: 'opener_effectiveness',
    description: 'Whether a voice-session opener leads members into a conversation, and what to do about it.',
    roles: ENGINEERING,
    input: z.object({
      wake_opener: text(80),
      candidate_kind: text(80),
      sessions: z.number().int().min(0),
      finalized: z.number().int().min(0),
      engaged_pct: z.number().min(0).max(100),
      avg_user_turns: z.number().min(0),
      avg_duration_s: z.number().min(0),
      overall_engaged_pct: z.number().min(0).max(100),
      window_days: z.number().int().min(1).max(30),
    }),
    questions: {
      working: {
        type: 'noul',
        instructions: 'Is this opener working — do members who hear it go on to talk with Vitana, compared with sessions overall?',
      },
      next_step: {
        type: 'choice',
        instructions: 'What should be done with this opener?',
        criteria: {
          keep: 'It works; keep it as is.',
          reword: 'The idea is right but the wording or length puts members off.',
          reposition: 'It fits some situations but is used in the wrong ones (time of day, route, returning member).',
          drop: 'It does not engage members; replace it.',
          too_little_data: 'Too few sessions or too few finalized sessions to tell.',
        },
      },
    },
    primary: 'working',
    threshold: 0.7,
    pii: 'forbid',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ opener: i }),
  },
  {
    // VTID-04818 (P3 F): a lesson about to be written to dev_agent_memory —
    // is it new and durable, or a repeat / a one-off?
    name: 'lesson_novelty',
    description: 'Whether an engineering lesson is new and durable enough to keep, next to the most similar lessons already stored.',
    roles: ENGINEERING,
    input: z.object({
      category: text(40),
      title: text(300),
      content: text(1500),
      existing: z.array(z.object({ category: text(40), title: text(300), content: text(600), similarity: z.number().min(0).max(1), age_days: z.number().min(0) })).max(3),
    }),
    questions: {
      new_and_durable: {
        type: 'noul',
        instructions: 'Is this a new lesson that will still be true and useful in later work, rather than a repeat of a stored one or a one-off detail of this run?',
      },
      kind: {
        type: 'choice',
        instructions: 'Compared with the stored lessons, what is it?',
        criteria: {
          new: 'A lesson not stored yet.',
          duplicate: 'Says the same as a stored lesson.',
          update: 'Changes or corrects a stored lesson (it should replace it).',
          too_specific: 'True only for this run or this one task.',
          not_a_lesson: 'A status note or narration, not something to remember.',
        },
      },
    },
    primary: 'new_and_durable',
    threshold: 0.7,
    pii: 'redact',
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'telemetry',
    buildState: (i) => ({ candidate: { category: i.category, title: i.title, content: i.content }, stored: i.existing }),
  },
  // VTID-04879: community Class A decisions (docs/JEV-INTEGRATION-PLAN.md §8.3 C1, C3, C10, C19).
  // Member content run by a system caller on the system_autopilot plane: member rules apply,
  // spend counts as member, no per-member quota (Class A). Shadow only beside the existing logic.
  {
    name: 'community_intent_kind',
    description: 'What a member wants to post or find, for the intent matcher (shadow of classifyIntentKind).',
    roles: ENGINEERING,
    input: z.object({ utterance: text(1000) }),
    questions: {
      kind: {
        type: 'choice',
        instructions: 'What is the member asking for?',
        criteria: {
          commercial_buy: 'They want to buy something.',
          commercial_sell: 'They want to sell something.',
          activity_seek: 'They want a partner or group for an activity.',
          partner_seek: 'They are looking for a romantic or life partner.',
          social_seek: 'They want to meet people or make friends.',
          mutual_aid: 'They want to borrow, lend or exchange help.',
          learning_seek: 'They want to learn something or find a teacher.',
          mentor_seek: 'They want a mentor or want to mentor someone.',
          none: 'None of these; the request is unclear or something else.',
        },
      },
    },
    primary: 'kind',
    threshold: 0.7,
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'member_content',
    community_class: 'A',
    pii: 'redact',
    buildState: (i) => ({ member_utterance: i.utterance }),
  },
  {
    name: 'community_marketplace_intent',
    description: 'Which part of the marketplace a member need belongs to (shadow of the classify_marketplace_intent heuristic).',
    roles: ENGINEERING,
    input: z.object({ need: text(1000) }),
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Which kind of marketplace offer would meet this need?',
        criteria: {
          product: 'A physical or digital product to buy.',
          service: 'A service, course, class, session or treatment.',
          practitioner: 'A doctor, coach, therapist or other practitioner.',
          diagnostic_test: 'A lab or diagnostic test.',
          combination: 'A diagnostic test together with a practitioner or service.',
        },
      },
    },
    primary: 'intent',
    threshold: 0.6,
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'member_content',
    community_class: 'A',
    pii: 'redact',
    buildState: (i) => ({ member_need: i.need }),
  },
  {
    name: 'community_worth_remembering',
    description: 'Whether a conversation stretch holds a durable personal fact, before the memory extractor runs (shadow).',
    roles: ENGINEERING,
    input: z.object({ conversation: text(2000) }),
    questions: {
      worth: {
        type: 'noul',
        instructions:
          'Does this conversation contain a durable personal fact about the member (a name, preference, relationship, plan, routine) worth remembering in a later, unrelated session?',
      },
    },
    primary: 'worth',
    threshold: 0.7,
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'member_content',
    community_class: 'A',
    pii: 'redact',
    buildState: (i) => ({ conversation: i.conversation }),
  },
  {
    name: 'community_ticket_triage',
    description: 'Whether a member report needs a ticket or an inline answer, and its kind (shadow of pick_specialist_for_text).',
    roles: ENGINEERING,
    input: z.object({ summary: text(1500) }),
    questions: {
      route: {
        type: 'choice',
        instructions: 'Does this need a support ticket, or can it be answered right away in the conversation?',
        criteria: {
          answer_inline: 'A question that can be answered now; nothing is broken and nobody needs to act.',
          file_ticket: 'Something is broken, blocked or needs a person to act.',
        },
      },
      kind: {
        type: 'choice',
        instructions: 'If a ticket were filed, which kind would it be?',
        criteria: {
          bug: 'Something in the app is broken or behaves wrongly.',
          support_question: 'A question or request for help.',
          marketplace_claim: 'A problem with a marketplace order, product or seller.',
          account_issue: 'Login, profile, membership or access problem.',
        },
      },
    },
    primary: 'route',
    threshold: 0.7,
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'member_content',
    community_class: 'A',
    pii: 'redact',
    buildState: (i) => ({ member_report: i.summary }),
  },
  // VTID-04883: community ranking decisions D1–D3, D5–D8 (docs/JEV-INTEGRATION-PLAN.md §10.4 D), shadow only.
  // One call per request: a choice over fixed slots c1…c8 (questions are fixed per decision), candidates in
  // the state in the existing order. Class B (per-member quota). State is derived in code: no names, no
  // health values, no other member's personal data.
  ...RANKING_DECISIONS.map(
    ([name, description, instructions]): JevDecisionDef => ({
      name,
      description,
      roles: ENGINEERING,
      input: rankingInput,
      questions: { pick: { type: 'choice', instructions, criteria: SLOT_CRITERIA } },
      primary: 'pick',
      threshold: 0.5,
      planes: INTERNAL_AND_AUTOPILOT,
      data: 'member_content',
      community_class: 'B',
      pii: 'redact',
      buildState: (i) => ({ member_context: i.context, candidates: i.candidates }),
    }),
  ),
  {
    name: 'community_notification_worth',
    description: 'Whether a notification just sent was worth sending to this member now (D6, shadow; sampled).',
    roles: ENGINEERING,
    input: z.object({ notification: rankingFields, context: rankingFields }),
    questions: {
      worth: {
        type: 'noul',
        instructions:
          'Was this notification worth interrupting this member for, now, given its type, priority and how many notifications they already received today?',
      },
    },
    primary: 'worth',
    threshold: 0.6,
    planes: INTERNAL_AND_AUTOPILOT,
    data: 'member_content',
    community_class: 'B',
    pii: 'redact',
    buildState: (i) => ({ notification: i.notification, member_context: i.context }),
  },
];

export const JEV_DECISIONS: ReadonlyMap<string, JevDecisionDef> = new Map(defs.map((d) => [d.name, d]));

export function getJevDecision(name: string): JevDecisionDef | undefined {
  return JEV_DECISIONS.get(name);
}

export function listJevDecisions(): JevDecisionDef[] {
  return [...JEV_DECISIONS.values()];
}
