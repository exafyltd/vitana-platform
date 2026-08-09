/**
 * VTID-03515 — batch translator for DB-backed content, with the validation
 * that the frontend catalog pipeline had to learn the hard way.
 *
 * Four defects were found in shipped `src/i18n/` catalogs during the 8-language
 * expansion. All four are structural, all four recur on every new language, and
 * all four are cheap to catch here rather than in review:
 *
 *  1. TRANSLATED PLACEHOLDERS. The prompt says "keep placeholders intact"; the
 *     model renames them anyway (`{date}` → `{datum}`, `{used}` → `{usado}`).
 *     Substitution is by NAME, so a renamed token is never substituted and the
 *     user sees a literal `{datum}`. Detected by comparing token lists, and
 *     repaired positionally when only the names changed.
 *  2. TRUNCATED JSON. A batch containing long prose reliably returns unparseable
 *     JSON — on every retry, identically. It is deterministic, not transient,
 *     so retrying is wasted spend. The fix is to SPLIT the batch and recurse.
 *  3. FORMAL REGISTER. Left to itself the model emits Sie/usted/vous/Vi. The
 *     brand voice is informal in every language. The hint comes from the
 *     `supported_locales` registry rather than a constant here, so adding a
 *     language carries its own register rule.
 *  4. SILENT PASSTHROUGH. A model that declines to translate returns the source
 *     verbatim. That reads as 100% coverage and renders as German. Treated as a
 *     failure for this key, not as output.
 *
 * A note on what is NOT validated: length. Compound-word and line-length limits
 * are real for German but the source here IS German, and a target-language
 * length rule tuned on one language does not transfer — the French register
 * regex in this same programme produced 39 false positives out of 41 because
 * `rendez-vous` contains `vous`. Length is left to the LLM audit pass.
 */

export interface TranslatorOptions {
  apiKey: string;
  model?: string;
  /** English name of the target language, from `supported_locales`. */
  languageName: string;
  /** Register instruction for the target language, from `supported_locales`. */
  informalHint: string;
  /** Surface-specific guidance (`SurfaceDef.translatorBrief`). */
  brief: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TranslateUnit {
  key: string;
  fields: Record<string, string>;
}

export interface TranslateFailure {
  key: string;
  reason: string;
}

export interface TranslateResult {
  translated: Map<string, Record<string, string>>;
  failures: TranslateFailure[];
}

/**
 * Same pattern as `scripts/i18n-audit.mjs` in vitana-v1, and deliberately so.
 * NOT `\w+` — that is ASCII-only and blind to `{početak}`, which is precisely
 * the case the check exists to catch. NOT `[^{}]+` — that swallows an embedded
 * JSON example and reports the whole document as one placeholder.
 */
const PLACEHOLDER = /\{([^{}\s"']+)\}/g;

export function placeholders(value: string): string[] {
  return [...String(value).matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Reconcile a translated string's placeholders against its source.
 *
 * Same NUMBER of tokens → the model only renamed them, and the mapping back is
 * unambiguous, so remap positionally. Different number → it dropped or invented
 * one, which is not mechanically recoverable; return null and let the caller
 * fail that key rather than guessing and shipping a plausible-looking string
 * with a missing value.
 */
export function repairPlaceholders(source: string, translated: string): string | null {
  const want = placeholders(source);
  const got = placeholders(translated);
  if (want.join(',') === got.join(',')) return translated;
  if (want.length !== got.length) return null;
  let i = 0;
  return translated.replace(/\{[^{}\s"']+\}/g, () => `{${want[i++]}}`);
}

function buildPrompt(opts: TranslatorOptions, units: TranslateUnit[]): string {
  return [
    `Translate the following user-visible product content into ${opts.languageName}.`,
    '',
    'REGISTER (this is not optional):',
    opts.informalHint,
    '',
    'CONTENT TYPE:',
    opts.brief,
    '',
    'RULES:',
    '- Return ONLY a JSON object. No prose, no markdown fence.',
    '- The object maps each input key to an object with exactly the same field',
    '  names as the input. Never rename, add or drop a field.',
    '- Preserve every {placeholder} EXACTLY as written, including its name.',
    '  A renamed placeholder is a broken string.',
    '- An empty input field stays an empty string. Do not invent content.',
    '- Translate; do not transliterate and do not echo the source.',
    '',
    'INPUT:',
    JSON.stringify(Object.fromEntries(units.map((u) => [u.key, u.fields])), null, 1),
  ].join('\n');
}

async function callGemini(
  opts: TranslatorOptions,
  prompt: string,
): Promise<string> {
  const model = opts.model ?? 'gemini-2.5-flash';
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
  try {
    const res = await doFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new Error('gemini returned an empty candidate');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(text: string): Record<string, Record<string, string>> {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response was not a JSON object');
  }
  return parsed as Record<string, Record<string, string>>;
}

/**
 * Validate one unit's translation. Returns the accepted field map, or a reason
 * string explaining the rejection. Never returns a partially-valid unit: a row
 * is written whole or not at all, because a half-written row looks identical to
 * a complete one in every coverage count.
 */
export function validateUnit(
  unit: TranslateUnit,
  raw: unknown,
  requiredFields: readonly string[],
): { ok: true; fields: Record<string, string> } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'missing from response' };
  }
  const got = raw as Record<string, unknown>;
  const out: Record<string, string> = {};

  for (const [field, source] of Object.entries(unit.fields)) {
    const value = got[field];
    if (source === '') {
      // Empty source stays empty. A model that "helpfully" fills it invented
      // content that no German user will ever see, so it can never be reviewed.
      out[field] = '';
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      if (requiredFields.includes(field)) {
        return { ok: false, reason: `required field ${field} was empty` };
      }
      // Optional field: leave blank, the read path falls back to German.
      out[field] = '';
      continue;
    }
    const repaired = repairPlaceholders(source, value);
    if (repaired === null) {
      return {
        ok: false,
        reason:
          `placeholder count changed in ${field} ` +
          `(source {${placeholders(source)}} vs translation {${placeholders(value)}})`,
      };
    }
    if (repaired.trim() === source.trim() && /\p{L}{4,}/u.test(source)) {
      // Verbatim echo of a substantive source string = not translated. Short
      // strings are exempt: a proper noun or a UI word legitimately survives
      // translation unchanged in many languages.
      return { ok: false, reason: `field ${field} came back identical to the German source` };
    }
    out[field] = repaired;
  }
  return { ok: true, fields: out };
}

/**
 * Translate units in batches, splitting a batch that fails to parse.
 *
 * The split is what makes long-prose content translatable at all. A batch whose
 * response is truncated fails identically on every retry, so the recovery is to
 * halve it — down to a single unit, at which point a still-failing unit is a
 * genuine per-unit failure and is reported as one.
 */
export async function translateUnits(
  units: TranslateUnit[],
  opts: TranslatorOptions,
  requiredFields: readonly string[],
  batchSize = 15,
): Promise<TranslateResult> {
  const translated = new Map<string, Record<string, string>>();
  const failures: TranslateFailure[] = [];

  async function run(batch: TranslateUnit[], depth: number): Promise<void> {
    if (batch.length === 0) return;
    let parsed: Record<string, Record<string, string>>;
    try {
      parsed = parseJsonObject(await callGemini(opts, buildPrompt(opts, batch)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (batch.length === 1) {
        failures.push({ key: batch[0].key, reason: message });
        return;
      }
      // Deterministic truncation, not a transient error — retrying the same
      // batch reproduces it. Halve and recurse.
      const mid = Math.ceil(batch.length / 2);
      console.warn(
        `[db-i18n] batch of ${batch.length} failed (${message.slice(0, 80)}) — splitting (depth ${depth})`,
      );
      await run(batch.slice(0, mid), depth + 1);
      await run(batch.slice(mid), depth + 1);
      return;
    }

    for (const unit of batch) {
      const verdict = validateUnit(unit, parsed[unit.key], requiredFields);
      if (verdict.ok) translated.set(unit.key, verdict.fields);
      else failures.push({ key: unit.key, reason: verdict.reason });
    }
  }

  for (let i = 0; i < units.length; i += batchSize) {
    await run(units.slice(i, i + batchSize), 0);
  }
  return { translated, failures };
}
