/**
 * Schema-drift detection (Phase 5, brief Sec. 5 stage 16 / Sec. 15).
 *
 * Compares the CERTIFIED manifest against freshly re-discovered partner
 * schemas and classifies every change. Materiality drives the repair path:
 * non-material drift may be auto-repaired after sandbox tests; material
 * drift always produces a human approval requirement. Classification is
 * conservative — anything touching a MAPPED field, auth, an action, or a
 * sensitive field is material.
 */
import { ConnectorManifest, ManifestField } from './manifest';

export type DriftKind =
  | 'schema_added'
  | 'schema_removed'
  | 'field_added'
  | 'field_removed'
  | 'field_type_changed'
  | 'field_required_changed'
  | 'auth_mechanism_changed'
  | 'action_added'
  | 'action_removed';

export interface DriftChange {
  kind: DriftKind;
  schema?: string;
  field?: string;
  detail?: string;
  /** True when this single change forces the material path. */
  material: boolean;
}

export type Materiality = 'none' | 'non_material' | 'material';

export interface DriftReport {
  changes: DriftChange[];
  materiality: Materiality;
  reasons: string[];
}

export interface FreshDiscovery {
  sourceSchemas: Array<{ name: string; fields: ManifestField[]; hash: string }>;
  authMechanism?: ConnectorManifest['auth']['mechanism'];
  actionKeys?: string[];
}

export function detectDrift(certified: ConnectorManifest, fresh: FreshDiscovery): DriftReport {
  const changes: DriftChange[] = [];
  const mappedFields = new Set(
    certified.canonical_mappings.map((m) => `${m.source_schema}.${m.source_field}`),
  );
  const oldSchemas = new Map(certified.source_schemas.map((s) => [s.name, s]));
  const newSchemas = new Map(fresh.sourceSchemas.map((s) => [s.name, s]));

  for (const [name, oldSchema] of oldSchemas) {
    const fresh = newSchemas.get(name);
    if (!fresh) {
      changes.push({ kind: 'schema_removed', schema: name, material: true });
      continue;
    }
    if (fresh.hash === oldSchema.hash) continue; // unchanged — the cheap path
    const oldFields = new Map(oldSchema.fields.map((f) => [f.name, f]));
    const newFields = new Map(fresh.fields.map((f) => [f.name, f]));
    for (const [fname, oldField] of oldFields) {
      const nf = newFields.get(fname);
      const isMapped = mappedFields.has(`${name}.${fname}`);
      if (!nf) {
        changes.push({ kind: 'field_removed', schema: name, field: fname, material: isMapped });
        continue;
      }
      if (nf.type !== oldField.type) {
        changes.push({
          kind: 'field_type_changed',
          schema: name,
          field: fname,
          detail: `${oldField.type} → ${nf.type}`,
          material: isMapped,
        });
      }
      if (nf.required !== oldField.required) {
        // A field BECOMING required breaks writes; relaxing is harmless.
        changes.push({
          kind: 'field_required_changed',
          schema: name,
          field: fname,
          detail: nf.required ? 'now required' : 'now optional',
          material: nf.required,
        });
      }
    }
    for (const [fname, nf] of newFields) {
      if (!oldFields.has(fname)) {
        // New SENSITIVE fields are material: they may carry data classes the
        // business never approved exchanging.
        changes.push({ kind: 'field_added', schema: name, field: fname, material: nf.sensitive === true });
      }
    }
  }
  for (const name of newSchemas.keys()) {
    if (!oldSchemas.has(name)) changes.push({ kind: 'schema_added', schema: name, material: false });
  }

  if (fresh.authMechanism && fresh.authMechanism !== certified.auth.mechanism) {
    changes.push({
      kind: 'auth_mechanism_changed',
      detail: `${certified.auth.mechanism} → ${fresh.authMechanism}`,
      material: true, // auth changes are ALWAYS a human decision (never weaken security)
    });
  }
  if (fresh.actionKeys) {
    const oldActions = new Set(certified.actions.map((a) => a.key));
    const newActions = new Set(fresh.actionKeys);
    for (const key of oldActions) {
      if (!newActions.has(key)) changes.push({ kind: 'action_removed', detail: key, material: true });
    }
    for (const key of newActions) {
      if (!oldActions.has(key)) changes.push({ kind: 'action_added', detail: key, material: false });
    }
  }

  const materialChanges = changes.filter((c) => c.material);
  const materiality: Materiality =
    changes.length === 0 ? 'none' : materialChanges.length > 0 ? 'material' : 'non_material';
  return {
    changes,
    materiality,
    reasons: materialChanges.map((c) => `${c.kind}${c.schema ? ` ${c.schema}` : ''}${c.field ? `.${c.field}` : ''}${c.detail ? ` (${c.detail})` : ''}`),
  };
}
