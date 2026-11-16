/**
 * MR review verdict: the structured output of the Bedrock reviewer for one
 * exact GitLab MR head SHA. Validation is strict: a verdict that does not name
 * the head it reviewed, or that contradicts itself, is rejected.
 */

export type ReviewDecision = 'ACCEPT' | 'CHANGES_REQUESTED';
export type FindingSeverity = 'blocking' | 'major' | 'minor';

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  claim: string;
  evidence: string;
}

export interface ReviewVerdict {
  decision: ReviewDecision;
  head_sha: string;
  findings: ReviewFinding[];
}

export type VerdictCheck = { ok: true; verdict: ReviewVerdict } | { ok: false; errors: string[] };

const SHA40 = /^[0-9a-f]{40}$/;
const SEVERITIES: ReadonlySet<string> = new Set(['blocking', 'major', 'minor']);
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['decision', 'head_sha', 'findings']);
const FINDING_KEYS: ReadonlySet<string> = new Set(['id', 'severity', 'file', 'line', 'claim', 'evidence']);

export function validateVerdict(raw: unknown, expectedHeadSha: string): VerdictCheck {
  const errors: string[] = [];
  if (!SHA40.test(expectedHeadSha)) return { ok: false, errors: ['expectedHeadSha must be a full 40-hex SHA'] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['verdict must be an object'] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) errors.push(`unknown field: ${k}`);

  if (o.head_sha !== expectedHeadSha) errors.push(`head_sha ${JSON.stringify(o.head_sha)} is not the reviewed head ${expectedHeadSha}`);
  if (o.decision !== 'ACCEPT' && o.decision !== 'CHANGES_REQUESTED') errors.push('decision must be ACCEPT or CHANGES_REQUESTED');
  if (!Array.isArray(o.findings)) errors.push('findings must be an array');

  const findings: ReviewFinding[] = [];
  if (Array.isArray(o.findings)) {
    o.findings.forEach((f, i) => {
      if (typeof f !== 'object' || f === null || Array.isArray(f)) { errors.push(`findings[${i}] must be an object`); return; }
      const x = f as Record<string, unknown>;
      for (const k of Object.keys(x)) if (!FINDING_KEYS.has(k)) errors.push(`findings[${i}] unknown field: ${k}`);
      if (typeof x.id !== 'string' || x.id.length === 0) errors.push(`findings[${i}].id is required`);
      if (typeof x.severity !== 'string' || !SEVERITIES.has(x.severity)) errors.push(`findings[${i}].severity must be blocking, major or minor`);
      if (typeof x.file !== 'string' || x.file.length === 0) errors.push(`findings[${i}].file is required`);
      if (!Number.isInteger(x.line) || (x.line as number) < 1) errors.push(`findings[${i}].line must be a positive integer`);
      if (typeof x.claim !== 'string' || x.claim.trim().length === 0) errors.push(`findings[${i}].claim is required`);
      if (typeof x.evidence !== 'string' || x.evidence.trim().length === 0) errors.push(`findings[${i}].evidence is required`);
      findings.push(x as unknown as ReviewFinding);
    });
    const ids = findings.map((f) => f.id);
    if (new Set(ids).size !== ids.length) errors.push('finding ids must be unique');
  }

  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  if (o.decision === 'ACCEPT' && findings.some((f) => f.severity === 'blocking')) errors.push('ACCEPT cannot carry blocking findings');
  if (o.decision === 'CHANGES_REQUESTED' && findings.length === 0) errors.push('CHANGES_REQUESTED needs at least one finding');
  if (o.decision === 'CHANGES_REQUESTED' && blocking === 0 && findings.length > 0 && findings.every((f) => f.severity === 'minor')) {
    errors.push('CHANGES_REQUESTED needs a blocking or major finding');
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, verdict: { decision: o.decision as ReviewDecision, head_sha: expectedHeadSha, findings } };
}
