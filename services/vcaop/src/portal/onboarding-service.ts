/**
 * Partner Portal — connect-business workflow (Commerce Mesh Phase 3, brief Sec. 8).
 *
 * Orchestrates: discover → mapping (preview + human decisions) → sandbox
 * testing → one-approval activation → active, plus pause / resume /
 * reauthorize / revoke. Built entirely on the Phase 2 factory +
 * certification pipeline — this service adds ORCHESTRATION and STATE, never
 * a second gate: activation still goes through `activateConnector`, which
 * refuses anything uncertified, and every transition is checked against
 * STATE_TRANSITIONS.
 *
 * Persistence is behind `ConnectionRepository` (in-memory for tests/dev;
 * the Prisma implementation binds to the Phase 2 tables when the gateway
 * mounts this — BLK-001). Every real transition emits an OASIS-style event
 * through the injected sink; PII and secrets never enter events or views.
 */
import * as crypto from 'crypto';
import {
  assertTransition,
  ConnectionState,
  ConnectorManifest,
  validateManifest,
} from '../factory/manifest';
import { ingestOpenApi, OpenApiDocument } from '../factory/openapi-ingest';
import { CompiledConnector, ConnectorFactory, GeneratedTransport } from '../factory/factory';
import {
  activateConnector,
  CertificationResult,
  MappingDecision,
  runCertification,
} from '../factory/certification';
import { PolicyEngine } from '../guardrails/policy-engine';

export interface ConnectionRecord {
  id: string;
  tenantId: string;
  name: string;
  state: ConnectionState;
  connectorId: string;
  providerId: string;
  manifest?: ConnectorManifest;
  warnings: string[];
  decisions: MappingDecision[];
  certification?: CertificationResult;
  /** Who gave the single activation approval, when. */
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionRepository {
  create(rec: ConnectionRecord): Promise<void>;
  get(id: string): Promise<ConnectionRecord | null>;
  update(rec: ConnectionRecord): Promise<void>;
  listByTenant(tenantId: string): Promise<ConnectionRecord[]>;
}

export class InMemoryConnectionRepository implements ConnectionRepository {
  private rows = new Map<string, ConnectionRecord>();
  async create(rec: ConnectionRecord): Promise<void> {
    this.rows.set(rec.id, rec);
  }
  async get(id: string): Promise<ConnectionRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async update(rec: ConnectionRecord): Promise<void> {
    if (!this.rows.has(rec.id)) throw new Error(`unknown connection ${rec.id}`);
    this.rows.set(rec.id, rec);
  }
  async listByTenant(tenantId: string): Promise<ConnectionRecord[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }
}

export interface PortalEvent {
  topic: string; // e.g. mesh.connection.activated
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  payload: Record<string, unknown>; // ids + states only — never PII/secrets
}
export type PortalEventSink = (event: PortalEvent) => void;

export interface OnboardingDeps {
  repo: ConnectionRepository;
  policyEngine: PolicyEngine;
  emit: PortalEventSink;
  /** Sandbox transport factory per connection (real HTTP transport arrives with dev env). */
  transportFor: (rec: ConnectionRecord) => GeneratedTransport;
  now?: () => Date;
  idFor?: () => string;
}

export class PartnerOnboardingService {
  constructor(private readonly deps: OnboardingDeps) {}

  private now(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString();
  }

  private emitTransition(rec: ConnectionRecord, from: ConnectionState, detail?: string): void {
    this.deps.emit({
      topic: `mesh.connection.${rec.state}`,
      status: rec.state === 'failed' ? 'error' : 'info',
      message: `connection ${rec.id} ${from} → ${rec.state}${detail ? ` (${detail})` : ''}`,
      payload: { connection_id: rec.id, tenant_id: rec.tenantId, from, to: rec.state },
    });
  }

  private transition(rec: ConnectionRecord, to: ConnectionState, detail?: string): void {
    const from = rec.state;
    assertTransition(from, to);
    rec.state = to;
    rec.updatedAt = this.now();
    this.emitTransition(rec, from, detail);
  }

  /** Step 1-2: business selects "Connect business" and supplies an endpoint/spec. */
  async startConnection(input: {
    tenantId: string;
    name: string;
    connectorId: string;
    providerId: string;
    /** Phase 3 supports OpenAPI ingestion; other endpoint types are recorded and parked. */
    openApiDocument?: OpenApiDocument;
    jurisdiction?: string;
  }): Promise<ConnectionRecord> {
    const rec: ConnectionRecord = {
      id: this.deps.idFor ? this.deps.idFor() : `conn-${crypto.randomUUID()}`,
      tenantId: input.tenantId,
      name: input.name,
      state: 'discovered',
      connectorId: input.connectorId,
      providerId: input.providerId,
      warnings: [],
      decisions: [],
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.deps.repo.create(rec);
    this.deps.emit({
      topic: 'mesh.connection.discovered',
      status: 'info',
      message: `connection ${rec.id} created for tenant ${rec.tenantId}`,
      payload: { connection_id: rec.id, tenant_id: rec.tenantId, connector_id: rec.connectorId },
    });

    if (input.openApiDocument) {
      const { draft, warnings } = ingestOpenApi(input.openApiDocument, {
        connectorId: input.connectorId,
        partnerTenantId: input.tenantId,
        providerId: input.providerId,
        jurisdiction: input.jurisdiction,
      });
      const validated = validateManifest(draft);
      if (!validated.ok || !validated.manifest) {
        this.transition(rec, 'failed', `draft manifest invalid: ${validated.errors[0] ?? ''}`);
        await this.deps.repo.update(rec);
        return rec;
      }
      rec.manifest = validated.manifest;
      rec.warnings = warnings;
      this.transition(rec, 'mapping', 'OpenAPI ingested');
    } else {
      // No machine-readable spec yet — the business must authorize/supply one.
      this.transition(rec, 'authorization_required', 'no machine-readable spec supplied');
    }
    await this.deps.repo.update(rec);
    return rec;
  }

  /** A human mapping decision (approve/reject a proposed mapping). */
  async submitMappingDecision(connectionId: string, decision: MappingDecision): Promise<ConnectionRecord> {
    const rec = await this.mustGet(connectionId);
    if (rec.state !== 'mapping' && rec.state !== 'approval_required') {
      throw new Error(`Mapping decisions only in mapping/approval_required (state ${rec.state})`);
    }
    if (!decision.decided_by) throw new Error('MappingDecision requires a human decided_by');
    rec.decisions.push(decision);
    rec.updatedAt = this.now();
    this.deps.emit({
      topic: 'mesh.connection.mapping_decision',
      status: 'info',
      message: `mapping ${decision.source_schema}.${decision.source_field} ${decision.decision} by ${decision.decided_by}`,
      payload: { connection_id: rec.id, tenant_id: rec.tenantId, decision: decision.decision },
    });
    await this.deps.repo.update(rec);
    return rec;
  }

  /** Step 6: run the certification pipeline in the sandbox. */
  async runSandboxTests(connectionId: string): Promise<ConnectionRecord> {
    const rec = await this.mustGet(connectionId);
    if (!rec.manifest) throw new Error('No manifest — supply a spec first');
    if (rec.state === 'mapping' || rec.state === 'approval_required') {
      if (rec.state === 'approval_required') this.transition(rec, 'mapping', 're-testing after review');
      this.transition(rec, 'testing');
    } else if (rec.state !== 'testing') {
      throw new Error(`Sandbox tests only from mapping/testing (state ${rec.state})`);
    }

    const compiled = ConnectorFactory.compile(rec.manifest);
    rec.certification = await runCertification(compiled, this.deps.transportFor(rec), this.deps.policyEngine, {
      approvals: rec.decisions,
    });
    if (rec.certification.status === 'failed') this.transition(rec, 'failed', rec.certification.reasons.join('; '));
    else if (rec.certification.status === 'approval_required') this.transition(rec, 'approval_required');
    else this.transition(rec, 'certified');
    await this.deps.repo.update(rec);
    return rec;
  }

  /**
   * Step 8: THE one activation approval. Requires a certified run; the
   * approval is recorded (who/when) and the connector becomes active.
   */
  async approveActivation(connectionId: string, approvedBy: string): Promise<ConnectionRecord> {
    const rec = await this.mustGet(connectionId);
    if (!approvedBy) throw new Error('approveActivation requires a human approver id');
    if (!rec.manifest || !rec.certification) throw new Error('Nothing to activate — run sandbox tests first');
    const compiled: CompiledConnector = ConnectorFactory.compile(rec.manifest);
    // activateConnector throws unless certification.status === 'certified'.
    activateConnector(compiled, rec.certification, this.deps.policyEngine, this.deps.transportFor(rec));
    rec.approvedBy = approvedBy;
    rec.approvedAt = this.now();
    this.transition(rec, 'active', `approved by ${approvedBy}`);
    await this.deps.repo.update(rec);
    return rec;
  }

  async pause(connectionId: string, by: string): Promise<ConnectionRecord> {
    return this.simpleTransition(connectionId, 'suspended', `paused by ${by}`);
  }
  async resume(connectionId: string, by: string): Promise<ConnectionRecord> {
    return this.simpleTransition(connectionId, 'active', `resumed by ${by}`);
  }
  async revoke(connectionId: string, by: string): Promise<ConnectionRecord> {
    return this.simpleTransition(connectionId, 'revoked', `revoked by ${by}`);
  }
  /** Reauthorize: active/degraded → authorization_required is not a legal walk, so model it as degraded→suspended? No: reauth keeps the connection but requires fresh credentials. */
  async reauthorize(connectionId: string, by: string): Promise<ConnectionRecord> {
    const rec = await this.mustGet(connectionId);
    if (rec.state !== 'active' && rec.state !== 'degraded' && rec.state !== 'suspended') {
      throw new Error(`Reauthorize only from active/degraded/suspended (state ${rec.state})`);
    }
    // Reauth is credential refresh, not a manifest change: suspend until the
    // business completes the new OAuth/credential flow, then resume.
    if (rec.state !== 'suspended') this.transition(rec, 'suspended', `reauthorization requested by ${by}`);
    this.deps.emit({
      topic: 'mesh.connection.reauthorization_required',
      status: 'warning',
      message: `connection ${rec.id} requires reauthorization`,
      payload: { connection_id: rec.id, tenant_id: rec.tenantId },
    });
    await this.deps.repo.update(rec);
    return rec;
  }

  private async simpleTransition(connectionId: string, to: ConnectionState, detail: string): Promise<ConnectionRecord> {
    const rec = await this.mustGet(connectionId);
    this.transition(rec, to, detail);
    await this.deps.repo.update(rec);
    return rec;
  }

  private async mustGet(id: string): Promise<ConnectionRecord> {
    const rec = await this.deps.repo.get(id);
    if (!rec) throw new Error(`unknown connection ${id}`);
    return rec;
  }

  // ---- Tenant-scoped reads for the portal API --------------------------------
  async listConnections(tenantId: string): Promise<ConnectionRecord[]> {
    return this.deps.repo.listByTenant(tenantId);
  }

  /** Cross-tenant ids read as nonexistent — existence is never revealed. */
  async getConnection(tenantId: string, id: string): Promise<ConnectionRecord | null> {
    const rec = await this.deps.repo.get(id);
    return rec && rec.tenantId === tenantId ? rec : null;
  }
}
