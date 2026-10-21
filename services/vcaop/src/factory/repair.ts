/**
 * Repair pipeline (Phase 5, brief Sec. 5 stages 17-18 / Sec. 15 limits).
 *
 * propose → sandbox-test → apply, with the healing limits enforced in code:
 *  - a repair may NEVER expand OAuth scopes, change the auth mechanism, or
 *    weaken security — those surface as material and keep the OLD values;
 *  - non-material repairs may auto-apply ONLY after passing the full
 *    certification pipeline in the sandbox;
 *  - material repairs additionally require an explicit human approval;
 *  - low-confidence / sensitive re-mappings still hit the certification
 *    gates — a repair cannot activate what onboarding could not;
 *  - the certified prior version is never mutated (rollback = reactivate it).
 */
import * as crypto from 'crypto';
import { ConnectorManifest, validateManifest } from './manifest';
import { CompiledConnector, ConnectorFactory, GeneratedTransport } from './factory';
import { CertificationResult, MappingDecision, runCertification } from './certification';
import { detectDrift, DriftReport, FreshDiscovery } from './drift';
import { MappingProposer } from './proposer';
import { PolicyEngine } from '../guardrails/policy-engine';

export interface RepairProposal {
  connectorId: string;
  fromVersion: string;
  toVersion: string;
  drift: DriftReport;
  requiresApproval: boolean;
  proposedManifest: ConnectorManifest;
  notes: string[];
}

function bumpVersion(v: string, part: 'patch' | 'minor'): string {
  const [maj, min, pat] = v.split('.').map(Number);
  return part === 'patch' ? `${maj}.${min}.${pat + 1}` : `${maj}.${min + 1}.0`;
}

/**
 * Build a repair proposal from a certified manifest + fresh discovery.
 * Returns null when there is no drift (nothing to repair).
 */
export async function proposeRepair(
  certified: ConnectorManifest,
  fresh: FreshDiscovery,
  proposer: MappingProposer,
): Promise<RepairProposal | null> {
  const drift = detectDrift(certified, fresh);
  if (drift.materiality === 'none') return null;
  const notes: string[] = [];

  // Rebuild source schemas from the fresh discovery.
  const sourceSchemas = fresh.sourceSchemas.map((s) => ({
    name: s.name,
    fields: s.fields,
    hash: s.hash.length >= 8 ? s.hash : crypto.createHash('sha256').update(JSON.stringify(s.fields)).digest('hex').slice(0, 16),
  }));
  const freshSchemaNames = new Set(sourceSchemas.map((s) => s.name));

  // Keep mappings whose source field survived; re-propose for changed schemas.
  const survivingMappings = certified.canonical_mappings.filter((m) => {
    const schema = sourceSchemas.find((s) => s.name === m.source_schema);
    return schema?.fields.some((f) => f.name === m.source_field) ?? false;
  });
  const dropped = certified.canonical_mappings.length - survivingMappings.length;
  if (dropped > 0) notes.push(`${dropped} mapping(s) dropped — source fields no longer exist`);

  const mappedKeys = new Set(survivingMappings.map((m) => `${m.source_schema}.${m.source_field}`));
  const rebuilt = [...survivingMappings];
  for (const schema of sourceSchemas) {
    const proposal = await proposer.propose(
      schema.name,
      schema.fields.map((f) => ({ name: f.name, type: f.type })),
    );
    for (const m of proposal.mappings) {
      if (!mappedKeys.has(`${m.source_schema}.${m.source_field}`)) {
        rebuilt.push(m); // NEW ai-decided candidate — certification gates apply
        notes.push(`new mapping candidate ${m.source_schema}.${m.source_field} → ${m.canonical_entity}.${m.canonical_field} (${m.confidence})`);
      }
    }
  }

  // HEALING LIMITS enforced structurally:
  // - auth mechanism + scopes are copied from the CERTIFIED manifest, never
  //   from discovery — a repair cannot expand scope or swap auth. A detected
  //   auth change is material and lands as a note for the human.
  // - actions: removed partner actions are dropped (they no longer exist);
  //   NEW actions are NOT auto-added — adding capability is an onboarding
  //   decision, not a repair.
  const survivingActionKeys = fresh.actionKeys ? new Set(fresh.actionKeys) : null;
  const actions = survivingActionKeys
    ? certified.actions.filter((a) => survivingActionKeys.has(a.key))
    : certified.actions;
  if (actions.length !== certified.actions.length) {
    notes.push(`${certified.actions.length - actions.length} action(s) removed by the partner`);
  }
  if (fresh.authMechanism && fresh.authMechanism !== certified.auth.mechanism) {
    notes.push(
      `partner auth changed to ${fresh.authMechanism} — kept certified '${certified.auth.mechanism}'; a human must re-authorize deliberately`,
    );
  }

  const healthOk = actions.some((a) => a.key === certified.health_check.action_key);
  const proposedManifest: ConnectorManifest = {
    ...certified,
    version: bumpVersion(certified.version, drift.materiality === 'material' ? 'minor' : 'patch'),
    source_schemas: sourceSchemas,
    canonical_mappings: rebuilt.filter((m) => freshSchemaNames.has(m.source_schema)),
    actions,
    health_check: healthOk ? certified.health_check : { action_key: actions.find((a) => a.kind === 'read')?.key ?? actions[0]?.key ?? 'none' },
    certification: { status: 'testing' },
  };

  const validated = validateManifest(proposedManifest);
  if (!validated.ok) {
    // A proposal that cannot even validate is not a proposal — escalate.
    return {
      connectorId: certified.connector_id,
      fromVersion: certified.version,
      toVersion: proposedManifest.version,
      drift,
      requiresApproval: true,
      proposedManifest,
      notes: [...notes, ...validated.errors.map((e) => `invalid: ${e}`)],
    };
  }

  return {
    connectorId: certified.connector_id,
    fromVersion: certified.version,
    toVersion: proposedManifest.version,
    drift,
    requiresApproval: drift.materiality === 'material',
    proposedManifest,
    notes,
  };
}

export interface RepairTestResult {
  compiled: CompiledConnector;
  certification: CertificationResult;
}

/** Sandbox-test a repair with the full certification pipeline (no shortcuts). */
export async function testRepair(
  proposal: RepairProposal,
  transport: GeneratedTransport,
  policyEngine: PolicyEngine,
  approvals: MappingDecision[] = [],
): Promise<RepairTestResult> {
  const compiled = ConnectorFactory.compile(proposal.proposedManifest);
  const certification = await runCertification(compiled, transport, policyEngine, { approvals });
  return { compiled, certification };
}

export interface RepairApproval {
  approvedBy: string; // human — required for material repairs
  reason: string;
}

export interface AppliedRepair {
  manifest: ConnectorManifest; // the new certified version
  priorVersion: string; // rollback target — prior certified version, untouched
}

/**
 * Apply a tested repair. Refuses: uncertified results, and material repairs
 * without a human approval. Never mutates the prior manifest.
 */
export function applyRepair(
  certified: ConnectorManifest,
  proposal: RepairProposal,
  test: RepairTestResult,
  approval?: RepairApproval,
): AppliedRepair {
  if (test.certification.status !== 'certified') {
    throw new Error(
      `Refusing repair: sandbox certification is '${test.certification.status}' (${test.certification.reasons.join('; ')})`,
    );
  }
  if (proposal.requiresApproval && !approval?.approvedBy) {
    throw new Error('Refusing repair: material drift requires an explicit human approval');
  }
  return {
    manifest: {
      ...proposal.proposedManifest,
      certification: {
        status: 'certified',
        certified_at: new Date().toISOString(),
        certified_by: approval?.approvedBy ?? 'auto-repair (non-material, sandbox-certified)',
      },
    },
    priorVersion: certified.version,
  };
}

// ---------------------------------------------------------------------------

export interface HealerEvent {
  topic: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  payload: Record<string, unknown>;
}

export interface DriftHealerDeps {
  proposer: MappingProposer;
  policyEngine: PolicyEngine;
  transport: GeneratedTransport;
  emit: (e: HealerEvent) => void;
  /** Human-task sink for material repairs (routes into the existing human_task queue). */
  emitHumanTask: (task: { type: string; payload: Record<string, unknown> }) => void;
}

export type HealOutcome =
  | { outcome: 'no_drift' }
  | { outcome: 'auto_repaired'; applied: AppliedRepair }
  | { outcome: 'approval_required'; proposal: RepairProposal }
  | { outcome: 'failed'; reason: string };

/**
 * The Sec. 15 ladder for connector drift: detect → propose → sandbox-test →
 * auto-apply (non-material only) | open a human task. Guardrail semantics
 * follow the existing healing orchestrator: nothing material is ever
 * auto-healed, and a failed repair escalates instead of retrying blindly.
 */
export async function healConnectorDrift(
  certified: ConnectorManifest,
  fresh: FreshDiscovery,
  deps: DriftHealerDeps,
): Promise<HealOutcome> {
  const proposal = await proposeRepair(certified, fresh, deps.proposer);
  if (!proposal) return { outcome: 'no_drift' };

  deps.emit({
    topic: 'mesh.connector.drift_detected',
    status: proposal.drift.materiality === 'material' ? 'warning' : 'info',
    message: `${certified.connector_id}: ${proposal.drift.materiality} drift (${proposal.drift.changes.length} change(s))`,
    payload: { connector_id: certified.connector_id, materiality: proposal.drift.materiality },
  });

  if (proposal.requiresApproval) {
    deps.emitHumanTask({
      type: 'CONNECTOR_REPAIR_APPROVAL',
      payload: {
        connector_id: certified.connector_id,
        from_version: proposal.fromVersion,
        to_version: proposal.toVersion,
        reasons: proposal.drift.reasons,
        notes: proposal.notes,
      },
    });
    return { outcome: 'approval_required', proposal };
  }

  const test = await testRepair(proposal, deps.transport, deps.policyEngine);
  if (test.certification.status !== 'certified') {
    // Non-material but the sandbox disagrees → escalate, never force.
    deps.emitHumanTask({
      type: 'CONNECTOR_REPAIR_APPROVAL',
      payload: {
        connector_id: certified.connector_id,
        from_version: proposal.fromVersion,
        to_version: proposal.toVersion,
        reasons: [...proposal.drift.reasons, ...test.certification.reasons],
        notes: proposal.notes,
      },
    });
    return { outcome: 'failed', reason: test.certification.reasons.join('; ') || 'sandbox certification failed' };
  }

  const applied = applyRepair(certified, proposal, test);
  deps.emit({
    topic: 'mesh.connector.auto_repaired',
    status: 'success',
    message: `${certified.connector_id} ${proposal.fromVersion} → ${proposal.toVersion} (non-material, sandbox-certified)`,
    payload: { connector_id: certified.connector_id, from: proposal.fromVersion, to: proposal.toVersion },
  });
  return { outcome: 'auto_repaired', applied };
}
