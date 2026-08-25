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
 * PROVIDER (VTID-03689): this module names no provider and no model. It calls
 * the gateway's `llm-router`, which resolves both from `llm_routing_policy`.
 * It previously fetched Google's generative-language REST endpoint directly
 * with a raw API key — forbidden under CLAUDE.md ALWAYS 10a/10c and IF-THEN 27, and dead
 * in practice since that quota is exhausted and GCP billing is off.
 *
 * A note on what is NOT validated: length. Compound-word and line-length limits
 * are real for German but the source here IS German, and a target-language
 * length rule tuned on one language does not transfer — the French register
 * regex in this same programme produced 39 false positives out of 41 because
 * `rendez-vous` contains `vous`. Length is left to the LLM audit pass.
 */

import { callViaRouter } from '../llm-router';

/**
 * One completion: prompt in, text out.
 *
 * VTID-03689 — this replaced a `fetchImpl?: typeof fetch` seam, and the shape
 * change is the point rather than a refactor. A fetch seam takes a URL, so it
 * can be pointed at a provider host; this one cannot express a host at all, so
 * "which provider serves the translation" is decided in exactly one place
 * (`llm-router`, from the DB-backed `llm_routing_policy`) and nowhere else.
 */
export interface TranslationCompletion {
  ok: boolean;
  text?: string;
  error?: string;
}

export type TranslateCompleteFn = (
  prompt: string,
  opts: { maxTokens: number },
) => Promise<TranslationCompletion>;

export interface TranslatorOptions {
  /** English name of the target language, from `supported_locales`. */
  languageName: string;
  /** Register instruction for the target language, from `supported_locales`. */
  informalHint: string;
  /** Surface-specific guidance (`SurfaceDef.translatorBrief`). */
  brief: string;
  /** Injectable for tests. Defaults to the llm-router (Bedrock per policy). */
  completeImpl?: TranslateCompleteFn;
  maxTokens?: number;
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

/** Thrown when the PROVIDER failed. Distinct from a parse failure — see run(). */
class ProviderCallError extends Error {}

/**
 * Default completion path: the gateway's own LLM router.
 *
 * VTID-03689 — this used to be a direct `fetch` at Google's
 * generative-language REST endpoint with a raw API key, bypassing the router
 * entirely. That is forbidden (CLAUDE.md ALWAYS 10a/10c, IF-THEN 27: there is
 * no sanctioned Google dependency left, and GCP billing has been off since
 * 2026-08-16), and it had stopped working besides: every batch returned
 * HTTP 429 "You exceeded your quota", which is why the nightly I18N-DB-SEED
 * cron failed on every run for at least a week without producing a single row.
 *
 * Routing now comes from `llm_routing_policy`, so this file names no provider
 * and no model. Per policy v14 that resolves to Claude on Bedrock with DeepSeek
 * as the fallback — and critically, the router's fallback chain contains no
 * Google leg, so it cannot quietly reintroduce the dependency this removes.
 * Provider/model/latency telemetry comes free via the router (ALWAYS 18).
 *
 * `temperature` is deliberately not set: the router does not expose it, and the
 * old 0.2 was never load-bearing — every property this module actually cares
 * about (placeholders intact, no echo, no renamed fields) is VALIDATED after
 * the fact by `validateUnit`, not hoped for via sampling settings.
 */
async function routerComplete(
  prompt: string,
  opts: { maxTokens: number },
): Promise<TranslationCompletion> {
  const res = await callViaRouter('worker', prompt, {
    service: 'db-i18n-translator',
    maxTokens: opts.maxTokens,
    allowFallback: true,
  });
  if (!res.ok) return { ok: false, error: res.error || 'llm-router returned no reason' };
  const text = res.text ?? '';
  if (!text.trim()) return { ok: false, error: 'model returned an empty completion' };
  return { ok: true, text };
}

/**
 * VTID-03701-follow-up — live evidence (I18N-DB-SEED run 32730591018,
 * zh nav-catalog + journey-checklist) showed the raw-control-character
 * failure mode below firing 45 times in one run, all on Chinese output,
 * none on Arabic in the same run. Claude occasionally emits a literal
 * newline (or other control byte) inside a JSON string value instead of
 * the escaped `\n` — every "Expected ',' or '}' after property value in
 * JSON at position N" failure decoded from these runs matched that shape
 * exactly. It is NOT the truncation case `translateUnits` already handles
 * by halving the batch: halving reproduces the same malformed character
 * identically, which is exactly why these persisted all the way down to
 * single-unit batches instead of being resolved by the existing split.
 *
 * Fixed by re-escaping any raw control character (0x00-0x1F) found INSIDE
 * a JSON string literal before parsing — the one narrow, mechanical repair
 * that undoes this specific defect without attempting a general "fix any
 * malformed JSON" parser. Escaping done inside a string, honoring the
 * source's own backslash escapes, so a legitimate `\\n` (already escaped)
 * is left untouched and only a truly raw control byte is rewritten.
 */
function sanitizeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        switch (ch) {
          case '\n': out += '\\n'; break;
          case '\r': out += '\\r'; break;
          case '\t': out += '\\t'; break;
          default: out += `\\u${code.toString(16).padStart(4, '0')}`;
        }
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function parseJsonObject(text: string): Record<string, Record<string, string>> {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // Retry once against a sanitized copy — see sanitizeControlCharsInStrings
    // for why this is the one repair worth attempting rather than a general
    // malformed-JSON parser. If the sanitized copy still fails, surface the
    // ORIGINAL error: it names the original text's position, which is what
    // a human debugging a real truncation/refusal case needs to see.
    try {
      parsed = JSON.parse(sanitizeControlCharsInStrings(trimmed));
    } catch {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
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

  const complete = opts.completeImpl ?? routerComplete;
  const maxTokens = opts.maxTokens ?? 8192;

  async function run(batch: TranslateUnit[], depth: number): Promise<void> {
    if (batch.length === 0) return;
    let parsed: Record<string, Record<string, string>>;
    try {
      const res = await complete(buildPrompt(opts, batch), { maxTokens });
      if (!res.ok) throw new ProviderCallError(res.error || 'provider call failed');
      parsed = parseJsonObject(res.text ?? '');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // VTID-03689 — splitting is the recovery for a TRUNCATED RESPONSE, and
      // only for that. Applying it to a provider failure is actively harmful:
      // when the old Google path started returning HTTP 429, every batch
      // recursed 15 -> 8 -> 4 -> 2 -> 1, turning one refused call into ~15
      // refused calls per batch and burying the real reason under a wall of
      // identical "splitting" warnings. That is exactly what the nightly cron
      // logged, every night, for a week.
      //
      // A provider that refused this call refuses the halves too. Fail the
      // batch's units directly, with the provider's own reason attached, so
      // the operator sees "quota exceeded" once per batch instead of a
      // cascade that looks like a content problem.
      if (err instanceof ProviderCallError) {
        console.warn(
          `[db-i18n] provider call failed for ${batch.length} unit(s) — NOT splitting: ${message.slice(0, 160)}`,
        );
        for (const unit of batch) failures.push({ key: unit.key, reason: message });
        return;
      }

      if (batch.length === 1) {
        failures.push({ key: batch[0].key, reason: message });
        return;
      }
      // Deterministic truncation, not a transient error — retrying the same
      // batch reproduces it. Halve and recurse.
      const mid = Math.ceil(batch.length / 2);
      console.warn(
        `[db-i18n] batch of ${batch.length} failed to parse (${message.slice(0, 80)}) — splitting (depth ${depth})`,
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
