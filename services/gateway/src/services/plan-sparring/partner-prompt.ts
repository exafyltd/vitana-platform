/**
 * VTID-04868 — Plan Sparring Gate: the partner's fixed adversarial system
 * prompt and its `submit_review` tool.
 *
 * Admin-facing, English by design (§13b): the output is read by the planner
 * and the owner in the Command Hub, never spoken to a member.
 *
 * The prompt is a constant — no caller can soften it per plan. The planner's
 * private reasoning never reaches the partner: it sees the plan text, the
 * planner's written responses and the code, nothing else.
 */

import type { LLMRouterTool } from '../llm-router';
import { PLAN_SPARRING_REPOS } from './github-tools';
import type {
  Acknowledgement,
  EvidenceRef,
  Finding,
  PartnerReview,
  PremiseCheck,
  ToolLogEntry,
} from './types';

export const ROUND1_MIN_VERIFIED_PREMISES = 3;

export const PARTNER_SYSTEM_PROMPT = `You are the Plan Sparring Partner for the Vitana platform: an independent, adversarial reviewer of implementation plans. A plan you pass will be given a VTID and implemented; a defect you miss ships. Your job is to find what is wrong, missing or unproven, not to be agreeable.

How you work:
- Treat every factual statement in the plan about the existing system (file X does Y, table Z has column W, route R is mounted at P, function F is called from G) as a PREMISE to verify. Verify premises by reading the code with read_file. list_dir helps you navigate; search is approximate (default branch only) and is never evidence on its own.
- Every finding and every premise check must cite at least one file you actually read with read_file in this review (repo + path, and the line range when relevant). Uncited claims are discarded.
- In the first round you must verify at least ${ROUND1_MIN_VERIFIED_PREMISES} distinct premises against the code, each citing a read_file result.
- Look specifically for: wrong assumptions about existing code; missing call sites or paths that bypass the change; security and auth gaps; data integrity, migration and rollback risks; governance violations (VTID, OASIS events, Bedrock-only LLM routing, no silent fallback, staging-first deploys, read-only staging tests, no test writes to production); missing tests or regression-suite scenarios; scope that exceeds the declared change class; tenant isolation.
- Severity: blocker = the plan as written would cause an incident, data loss, a security hole or a governance violation; major = a real defect or gap that must be fixed before implementation; minor = an improvement.
- Do not invent problems to look thorough. If a premise holds, say it holds. Do not restate the plan.
- From the second round on you also receive the planner's responses to your earlier findings. For every finding the planner REJECTED or DEFERRED, return an acknowledgement: "acknowledged" if the rationale is sound, "disputed" if it is not (explain why in the note). Check the revised plan for accepted findings that were not actually addressed and raise them again as new findings. Raise new findings the revision introduced.
- Finish by calling submit_review exactly once. Do not put the review in plain text.`;

const evidenceSchema = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    properties: {
      repo: { type: 'string', enum: [...PLAN_SPARRING_REPOS] },
      path: { type: 'string' },
      start_line: { type: 'integer' },
      end_line: { type: 'integer' },
      quote: { type: 'string' },
    },
    required: ['repo', 'path'],
    additionalProperties: false,
  },
};

export const SUBMIT_REVIEW_TOOL: LLMRouterTool = {
  name: 'submit_review',
  description: 'Submit your complete review for this round. Call exactly once, after you have gathered evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable id, e.g. R1-F1; reuse an earlier id only when re-raising that finding.' },
            severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
            claim: { type: 'string' },
            evidence: evidenceSchema,
            suggestion: { type: 'string' },
          },
          required: ['id', 'severity', 'claim', 'evidence', 'suggestion'],
          additionalProperties: false,
        },
      },
      premise_checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            premise: { type: 'string' },
            holds: { type: 'boolean' },
            evidence: evidenceSchema,
          },
          required: ['premise', 'holds', 'evidence'],
          additionalProperties: false,
        },
      },
      acknowledgements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            finding_id: { type: 'string' },
            status: { type: 'string', enum: ['acknowledged', 'disputed'] },
            note: { type: 'string' },
          },
          required: ['finding_id', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'findings', 'premise_checks', 'acknowledgements'],
    additionalProperties: false,
  },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseEvidence(v: unknown): EvidenceRef[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: EvidenceRef[] = [];
  for (const e of v) {
    if (!isObj(e) || typeof e.repo !== 'string' || typeof e.path !== 'string') return null;
    out.push(e as unknown as EvidenceRef);
  }
  return out;
}

/**
 * Shape-check a submit_review payload. On success the payload is returned
 * UNCHANGED (same object graph) — the store keeps findings verbatim.
 */
export function parsePartnerReview(raw: unknown): { ok: true; review: PartnerReview } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'review is not an object' };
  if (typeof raw.summary !== 'string') return { ok: false, error: 'summary missing' };
  if (!Array.isArray(raw.findings)) return { ok: false, error: 'findings must be an array' };
  if (!Array.isArray(raw.premise_checks)) return { ok: false, error: 'premise_checks must be an array' };
  const acks = raw.acknowledgements === undefined ? [] : raw.acknowledgements;
  if (!Array.isArray(acks)) return { ok: false, error: 'acknowledgements must be an array' };
  const ids = new Set<string>();
  for (const f of raw.findings) {
    if (!isObj(f)) return { ok: false, error: 'finding is not an object' };
    if (typeof f.id !== 'string' || f.id.length === 0) return { ok: false, error: 'finding id missing' };
    if (ids.has(f.id)) return { ok: false, error: `duplicate finding id ${f.id}` };
    ids.add(f.id);
    if (!['blocker', 'major', 'minor'].includes(f.severity as string)) return { ok: false, error: `finding ${f.id}: bad severity` };
    if (typeof f.claim !== 'string' || typeof f.suggestion !== 'string') return { ok: false, error: `finding ${f.id}: claim/suggestion missing` };
    if (!parseEvidence(f.evidence)) return { ok: false, error: `finding ${f.id}: evidence must cite at least one read file` };
  }
  for (const p of raw.premise_checks) {
    if (!isObj(p) || typeof p.premise !== 'string' || typeof p.holds !== 'boolean' || !parseEvidence(p.evidence)) {
      return { ok: false, error: 'premise check malformed (premise, holds, evidence required)' };
    }
  }
  for (const a of acks) {
    if (!isObj(a) || typeof a.finding_id !== 'string' || !['acknowledged', 'disputed'].includes(a.status as string)) {
      return { ok: false, error: 'acknowledgement malformed' };
    }
  }
  return {
    ok: true,
    review: {
      summary: raw.summary,
      findings: raw.findings as unknown as Finding[],
      premise_checks: raw.premise_checks as unknown as PremiseCheck[],
      acknowledgements: acks as unknown as Acknowledgement[],
    },
  };
}

/** True when the cited file was successfully read with read_file this session. */
export function citesReadFile(e: EvidenceRef, reads: ToolLogEntry[]): boolean {
  return reads.some((r) => r.name === 'read_file' && r.ok && r.repo === e.repo && r.path === e.path);
}

/**
 * Evidence checks the store enforces on a review (it never edits the review):
 *  - every finding cites ≥1 file actually read via read_file this session;
 *  - every premise check cites ≥1 such file;
 *  - round 1: ≥ ROUND1_MIN_VERIFIED_PREMISES premise checks qualify.
 */
export function checkEvidence(
  review: PartnerReview,
  reads: ToolLogEntry[],
  round: number,
): { ok: boolean; problems: string[]; verifiedPremises: number } {
  const problems: string[] = [];
  for (const f of review.findings) {
    if (!f.evidence.some((e) => citesReadFile(e, reads))) {
      problems.push(`finding ${f.id} cites no file you read with read_file`);
    }
  }
  const verifiedPremises = review.premise_checks.filter((p) => p.evidence.some((e) => citesReadFile(e, reads))).length;
  if (verifiedPremises < review.premise_checks.length) {
    problems.push('every premise check must cite a file you read with read_file');
  }
  if (round === 1 && verifiedPremises < ROUND1_MIN_VERIFIED_PREMISES) {
    problems.push(
      `round 1 needs at least ${ROUND1_MIN_VERIFIED_PREMISES} premise checks citing read_file results (have ${verifiedPremises})`,
    );
  }
  return { ok: problems.length === 0, problems, verifiedPremises };
}
