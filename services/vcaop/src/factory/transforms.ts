/**
 * Named deterministic transforms (Phase 5, brief Sec. 5 "generate
 * transformation code"). A mapping's `transform` is a NAME resolved here —
 * generated configuration, not generated executable code, so every transform
 * is reviewable, versioned with the manifest, and cannot smuggle behavior.
 * Unknown names fail loudly (never silently pass raw values through).
 */

export type TransformFn = (value: unknown) => unknown;

const REGISTRY: Record<string, TransformFn> = {
  identity: (v) => v,
  /** Integer minor units → decimal string ("1990" cents → "19.90"). */
  cents_to_decimal: (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error(`cents_to_decimal: non-numeric value`);
    return (n / 100).toFixed(2);
  },
  to_string: (v) => String(v),
  to_number: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`to_number: non-numeric value`);
    return n;
  },
  /** Epoch seconds → ISO-8601 string. */
  epoch_seconds_to_iso: (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error(`epoch_seconds_to_iso: non-numeric value`);
    return new Date(n * 1000).toISOString();
  },
  uppercase_currency: (v) => String(v).toUpperCase(),
};

export function transformNames(): string[] {
  return Object.keys(REGISTRY);
}

export function applyTransform(name: string, value: unknown): unknown {
  const fn = REGISTRY[name];
  if (!fn) throw new Error(`Unknown transform '${name}' — not in the registry`);
  return fn(value);
}

/**
 * Deterministic transform proposal for a (source, canonical) field pair —
 * used by ingestion and by repair when a partner type drifts.
 */
export function proposeTransform(sourceField: string, canonicalField: string): string | undefined {
  if (/_cents$/i.test(sourceField) && /_amount$/i.test(canonicalField)) return 'cents_to_decimal';
  if (/_(epoch|ts|timestamp)$/i.test(sourceField) && /_at$/i.test(canonicalField)) return 'epoch_seconds_to_iso';
  if (/currency/i.test(sourceField) && /currency/i.test(canonicalField)) return 'uppercase_currency';
  return undefined;
}
