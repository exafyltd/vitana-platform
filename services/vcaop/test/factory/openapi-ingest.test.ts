import { fieldSimilarity, guessEntity, ingestOpenApi } from '../../src/factory/openapi-ingest';
import spec from './fixtures/sandbox-supplier-openapi.json';

const ingest = () =>
  ingestOpenApi(spec as never, {
    connectorId: 'sandbox-supplier',
    partnerTenantId: 'tenant-a',
    providerId: 'sandbox_supplier',
  });

describe('OpenAPI ingestion', () => {
  test('extracts schemas, actions, events and auth from the document', () => {
    const { draft } = ingest();
    expect(draft.source_schemas.map((s) => s.name).sort()).toEqual(['Order', 'OrderRequest', 'Product', 'ProductList']);
    expect(draft.actions.map((a) => a.key).sort()).toEqual(['cancelOrder', 'createOrder', 'getProduct', 'listProducts']);
    expect(draft.auth.mechanism).toBe('api_key');
    expect(draft.auth.secret_refs[0]).toMatch(/^vault:/);
    expect(draft.events).toEqual([{ key: 'order.updated', source: 'webhook' }]);
  });

  test('reads are reads; writes get idempotency keys; DELETE is destructive + human-gated', () => {
    const { draft } = ingest();
    const byKey = Object.fromEntries(draft.actions.map((a) => [a.key, a]));
    expect(byKey.listProducts.kind).toBe('read');
    expect(byKey.createOrder.idempotency).toBe('idempotency_key');
    expect(byKey.cancelOrder.destructive).toBe(true);
    expect(byKey.cancelOrder.human_gated).toBe(true);
  });

  test('proposes exact-name canonical mappings at confidence 1.0', () => {
    const { draft } = ingest();
    const exact = draft.canonical_mappings.find(
      (m) => m.source_schema === 'Product' && m.source_field === 'price_amount',
    );
    expect(exact).toMatchObject({ canonical_entity: 'product', canonical_field: 'price_amount', confidence: 1, decided_by: 'ai' });
  });

  test('flags sensitive fields on mapping proposals', () => {
    const { draft } = ingest();
    const email = draft.canonical_mappings.find((m) => m.source_field === 'customer_email');
    expect(email?.sensitive).toBe(true);
    expect(email!.confidence).toBeLessThan(1);
  });

  test('unmappable fields become warnings, never silent guesses', () => {
    const { warnings } = ingest();
    expect(warnings.join(' ')).toContain('stock_qty');
  });

  test('fieldSimilarity ranks exact > token overlap > unrelated', () => {
    expect(fieldSimilarity('price_amount', 'price_amount')).toBe(1);
    expect(fieldSimilarity('customerEmail', 'customer_ref')).toBeGreaterThan(0.5);
    expect(fieldSimilarity('zzz', 'price_amount')).toBe(0);
  });

  test('guessEntity uses the schema name first, then field overlap', () => {
    expect(guessEntity('OrderRequest', ['sku'])).toBe('order');
    expect(guessEntity('Thing', ['title', 'price_amount', 'sku'])).toBe('product');
    expect(guessEntity('Mystery', ['foo'])).toBeNull();
  });
});
