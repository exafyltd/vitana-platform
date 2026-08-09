/**
 * Connector certification pipeline (brief Sec. 5 stages 10-15).
 *
 * Gates, in order — ALL must pass before a manifest may be activated:
 *  1. Every generated contract test passes against the sandbox transport.
 *  2. No AI-decided mapping below the confidence threshold without an
 *     explicit human MappingDecision approving it.
 *  3. Sensitive mappings ALWAYS require a human decision, whatever their
 *     confidence — "low-confidence mappings must never be silently
 *     activated" plus data-classification caution.
 *
 * Activation is a separate, final step: `activateConnector` refuses any
 * manifest whose certification did not end 'certified'. Self-healing may
 * roll BACK to a previously certified version but may never promote an
 * uncertified one (brief Sec. 15).
 */
import { PolicyEngine } from '../guardrails/policy-engine';
import { CompiledConnector, GeneratedTransport } from './factory';
import { assertTransition, ConnectionState } from './manifest';

export interface MappingDecision {
  source_schema: string;
  source_field: string;
  decision: 'approve' | 'reject';
  decided_by: string; // human reviewer id
}

export interface CertificationOptions {
  minConfidence?: number; // default 0.7
  approvals?: MappingDecision[];
}

export interface CertificationResult {
  status: Extract<ConnectionState, 'certified' | 'approval_required' | 'failed'>;
  testResults: Array<{ name: string; passed: boolean; detail?: string }>;
  pendingMappings: Array<{ source_schema: string; source_field: string; reason: string; confidence: number }>;
  reasons: string[];
}

export async function runCertification(
  compiled: CompiledConnector,
  transport: GeneratedTransport,
  policyEngine: PolicyEngine,
  opts: CertificationOptions = {},
): Promise<CertificationResult> {
  const minConfidence = opts.minConfidence ?? 0.7;
  const approvals = opts.approvals ?? [];
  const reasons: string[] = [];

  // Gate 1 — contract tests in the sandbox.
  const testResults: CertificationResult['testResults'] = [];
  for (const test of compiled.contractTests) {
    try {
      const res = await test.run(transport, policyEngine);
      testResults.push({ name: test.name, ...res });
    } catch (err) {
      testResults.push({ name: test.name, passed: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const failed = testResults.filter((t) => !t.passed);
  if (failed.length > 0) {
    reasons.push(`${failed.length} contract test(s) failed`);
    return { status: 'failed', testResults, pendingMappings: [], reasons };
  }

  // Gates 2+3 — mapping confidence + sensitivity.
  const approved = (schema: string, field: string) =>
    approvals.some(
      (d) => d.source_schema === schema && d.source_field === field && d.decision === 'approve' && d.decided_by,
    );

  const pendingMappings: CertificationResult['pendingMappings'] = [];
  for (const m of compiled.manifest.canonical_mappings) {
    if (m.sensitive && !(m.decided_by === 'human' || approved(m.source_schema, m.source_field))) {
      pendingMappings.push({
        source_schema: m.source_schema,
        source_field: m.source_field,
        reason: 'sensitive field requires human decision',
        confidence: m.confidence,
      });
      continue;
    }
    if (m.decided_by === 'ai' && m.confidence < minConfidence && !approved(m.source_schema, m.source_field)) {
      pendingMappings.push({
        source_schema: m.source_schema,
        source_field: m.source_field,
        reason: `confidence ${m.confidence} below threshold ${minConfidence}`,
        confidence: m.confidence,
      });
    }
  }
  if (pendingMappings.length > 0) {
    reasons.push(`${pendingMappings.length} mapping(s) need human approval`);
    return { status: 'approval_required', testResults, pendingMappings, reasons };
  }

  return { status: 'certified', testResults, pendingMappings: [], reasons: [] };
}

export interface ActivatedConnector {
  connectorId: string;
  version: string;
  state: 'active';
  build: ReturnType<CompiledConnector['buildConnector']>;
}

/**
 * The one-approval activation step. Refuses anything not certified — there is
 * no flag or override that activates an uncertified manifest.
 */
export function activateConnector(
  compiled: CompiledConnector,
  certification: CertificationResult,
  policyEngine: PolicyEngine,
  transport: GeneratedTransport,
): ActivatedConnector {
  if (certification.status !== 'certified') {
    throw new Error(
      `Refusing activation: certification status is '${certification.status}' (${certification.reasons.join('; ') || 'no reasons recorded'})`,
    );
  }
  // Enforce the legal state walk: testing → certified → active.
  assertTransition('testing', 'certified');
  assertTransition('certified', 'active');
  return {
    connectorId: compiled.manifest.connector_id,
    version: compiled.manifest.version,
    state: 'active',
    build: compiled.buildConnector(policyEngine, transport),
  };
}
