/** Phase 5 — transform registry + mapping proposer seam. */
import { applyTransform, proposeTransform } from '../../src/factory/transforms';
import { DeterministicMappingProposer, MockLlmMappingProposer } from '../../src/factory/proposer';
import { normalizeEvent } from '../../src/workflows/normalizer';
import { ingestOpenApi } from '../../src/factory/openapi-ingest';
import spec from './fixtures/sandbox-supplier-openapi.json';

describe('transforms', () => {
  test('registry applies named transforms and fails loudly on unknown names', () => {
    expect(applyTransform('cents_to_decimal', 1990)).toBe('19.90');
    expect(applyTransform('to_number', '42')).toBe(42);
    expect(applyTransform('uppercase_currency', 'eur')).toBe('EUR');
    expect(applyTransform('epoch_seconds_to_iso', 0)).toBe('1970-01-01T00:00:00.000Z');
    expect(() => applyTransform('evil_eval', 'x')).toThrow(/Unknown transform/);
    expect(() => applyTransform('cents_to_decimal', 'not-a-number')).toThrow(/non-numeric/);
  });

  test('proposeTransform pairs minor-unit and epoch fields with canonical targets', () => {
    expect(proposeTransform('price_cents', 'total_amount')).toBe('cents_to_decimal');
    expect(proposeTransform('created_ts', 'created_at')).toBe('epoch_seconds_to_iso');
    expect(proposeTransform('title', 'title')).toBeUndefined();
  });

  test('normalizer applies manifest transforms to canonical values', () => {
    const manifest = ingestOpenApi(spec as never, {
      connectorId: 'sandbox-supplier',
      partnerTenantId: 'tenant-a',
      providerId: 'sandbox_supplier',
    }).draft;
    // Attach a transform to the certified mapping (as a repair/human would).
    const totalMapping = manifest.canonical_mappings.find(
      (m) => m.source_schema === 'Order' && m.source_field === 'total_amount',
    )!;
    totalMapping.transform = 'to_number';
    const event = normalizeEvent(manifest, {
      eventKey: 'order.updated',
      schemaName: 'Order',
      nativeId: 'ord-9',
      payload: { id: 'ord-9', status: 'confirmed', total_amount: '19.90' },
    });
    expect(event.canonical.total_amount).toBe(19.9);
  });
});

describe('mapping proposer seam', () => {
  test('deterministic proposer emits ai-decided candidates with transforms attached', async () => {
    const proposer = new DeterministicMappingProposer();
    const result = await proposer.propose('Order', [
      { name: 'id', type: 'string' },
      { name: 'total_amount', type: 'number' },
      { name: 'currency', type: 'string' },
    ]);
    expect(result.entity).toBe('order');
    const currency = result.mappings.find((m) => m.source_field === 'currency');
    expect(currency?.transform).toBe('uppercase_currency');
    expect(result.mappings.every((m) => m.decided_by === 'ai')).toBe(true);
  });

  test('LLM-proposer mock is clamped to the contract: ai-decided, confidence within [0,1]', async () => {
    const proposer = new MockLlmMappingProposer({
      Order: {
        entity: 'order',
        mappings: [
          {
            source_schema: 'Order',
            source_field: 'grand_total',
            canonical_entity: 'order',
            canonical_field: 'total_amount',
            confidence: 7, // hallucinated over-confidence — must be clamped
            decided_by: 'human', // must be forced back to 'ai'
            sensitive: false,
          },
        ],
      },
    });
    const result = await proposer.propose('Order');
    expect(result.mappings[0].confidence).toBe(1);
    expect(result.mappings[0].decided_by).toBe('ai');
  });
});
