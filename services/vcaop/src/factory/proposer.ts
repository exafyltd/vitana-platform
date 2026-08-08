/**
 * Semantic mapping proposer seam (Phase 5).
 *
 * "AI plans; deterministic systems execute" (ADR-005) applied to mapping:
 * a proposer only ever emits CANDIDATES (decided_by:'ai', confidence-scored);
 * every candidate flows through the SAME certification gates — sensitive or
 * low-confidence candidates cannot activate without a human MappingDecision,
 * whoever proposed them.
 *
 * The deterministic proposer is the default and the certification pipeline's
 * only hard dependency. The LLM proposer is mock-first behind the interface
 * (runbook Sec. 0.8): the real implementation must route through the
 * gateway's llm-router (provider/model/latency telemetry for free) and needs
 * runtime credentials this environment does not hold — building it here
 * would mean inventing an LLM call path that cannot be verified.
 */
import { CanonicalEntityType } from '../canonical/model';
import { ManifestMapping } from './manifest';
import { guessEntity, proposeMapping } from './openapi-ingest';
import { proposeTransform } from './transforms';

export interface SchemaFieldInput {
  name: string;
  type: string;
}

export interface MappingProposer {
  /** Candidate mappings for one source schema. Never decides — only proposes. */
  propose(
    schemaName: string,
    fields: SchemaFieldInput[],
  ): Promise<{ entity: CanonicalEntityType | null; mappings: ManifestMapping[] }>;
}

export class DeterministicMappingProposer implements MappingProposer {
  async propose(
    schemaName: string,
    fields: SchemaFieldInput[],
  ): Promise<{ entity: CanonicalEntityType | null; mappings: ManifestMapping[] }> {
    const entity = guessEntity(schemaName, fields.map((f) => f.name));
    if (!entity) return { entity: null, mappings: [] };
    const mappings: ManifestMapping[] = [];
    for (const f of fields) {
      const m = proposeMapping(schemaName, f.name, entity);
      if (m) {
        const transform = proposeTransform(f.name, m.canonical_field);
        mappings.push(transform ? { ...m, transform } : m);
      }
    }
    return { entity, mappings };
  }
}

/**
 * Fixture-driven stand-in for an LLM proposer. Output shape and gating are
 * identical to what the real one must produce: decided_by 'ai', bounded
 * confidence, sensitive flags preserved. Swapping in the real implementation
 * changes proposal QUALITY, never the certification rules.
 */
export class MockLlmMappingProposer implements MappingProposer {
  constructor(
    private readonly fixtures: Record<
      string,
      { entity: CanonicalEntityType; mappings: ManifestMapping[] }
    >,
  ) {}

  async propose(
    schemaName: string,
  ): Promise<{ entity: CanonicalEntityType | null; mappings: ManifestMapping[] }> {
    const fx = this.fixtures[schemaName];
    if (!fx) return { entity: null, mappings: [] };
    // Whatever the "model" says, the output is clamped to the contract:
    // ai-decided, confidence within [0,1]. Gates do the rest.
    return {
      entity: fx.entity,
      mappings: fx.mappings.map((m) => ({
        ...m,
        decided_by: 'ai',
        confidence: Math.max(0, Math.min(1, m.confidence)),
      })),
    };
  }
}
