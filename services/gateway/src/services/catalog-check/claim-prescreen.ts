/**
 * VTID-05153 — claim pre-screen for the supplier catalogue check (case S03,
 * pre-screen only; Loop Engineering Phase 5, loop L9).
 *
 * A short, deterministic list of English and German disease-claim patterns
 * (a cure/heal/treat/prevent verb with a disease term). This is a SEAM: Phase 6
 * builds the shared claim verifier and replaces the implementation behind the
 * same `ClaimCheck` signature.
 *
 * What a flag can do, and all it can do: move the row to `needs_review`, where
 * a person decides. It never blocks a row, never edits copy, and nothing here
 * or downstream records claims as verified (§13c-infra rules 2–3). A miss is
 * not a pass: no "claims ok" verdict exists.
 *
 * No LLM, no I/O.
 */

/** Phase 6 swaps the implementation, never the signature. `locale` is the row's language hint (unused by the pre-screen, which runs every pattern). */
export type ClaimCheck = (text: string, locale: string) => { flags: string[] };

const EN_VERB = String.raw`(?:cures?|cured|curing|heals?|healed|healing|treats?|treated|treating|treatment\s+(?:of|for)|prevents?|prevented|preventing|prevention\s+of|reverses?|reversing|fights?|fighting|eliminates?)`;
const EN_DISEASE = String.raw`(?:cancers?|tumou?rs?|diabetes|alzheimer'?s?|dementia|arthritis|covid(?:-19)?|coronavirus|viral\s+infections?|infections?|depression|hypertension|high\s+blood\s+pressure|heart\s+disease|strokes?|asthma|parkinson'?s?|multiple\s+sclerosis|hiv|aids|diseases?|illness(?:es)?)`;

const DE_VERB = String.raw`(?:heilt|heilen|heilung|kuriert|kurieren|behandelt|behandeln|behandlung\s+von|verhindert|verhindern|beugt|vorbeugen|vorbeugung|bekämpft|bekämpfen|gegen)`;
const DE_DISEASE = String.raw`(?:krebs\w*|tumor\w*|diabetes|alzheimer|demenz|arthritis|arthrose|covid(?:-19)?|corona\w*|virus\w*|viren|infektion\w*|depression\w*|bluthochdruck|herzinfarkt\w*|schlaganfall\w*|asthma|parkinson|multiple\s+sklerose|krankheit\w*|erkrankung\w*)`;

// A verb and a disease term within a few words of each other, in either order
// (German puts the verb after the object: "Krebs vorbeugen").
const NEAR = String.raw`[^.!?\n]{0,40}?`;

export const CLAIM_PATTERNS: ReadonlyArray<{ flag: string; re: RegExp }> = [
  { flag: 'claim_disease_en', re: new RegExp(String.raw`\b${EN_VERB}\b${NEAR}\b${EN_DISEASE}\b`, 'iu') },
  { flag: 'claim_disease_en', re: new RegExp(String.raw`\b${EN_DISEASE}\b${NEAR}\b${EN_VERB}\b`, 'iu') },
  { flag: 'claim_disease_de', re: new RegExp(String.raw`(?<![\p{L}])${DE_VERB}(?![\p{L}])${NEAR}(?<![\p{L}])${DE_DISEASE}`, 'iu') },
  { flag: 'claim_disease_de', re: new RegExp(String.raw`(?<![\p{L}])${DE_DISEASE}${NEAR}(?<![\p{L}])${DE_VERB}(?![\p{L}])`, 'iu') },
];

/** The wave-1 pre-screen: EN + DE patterns over the whole text, whatever the locale. */
export const prescreenClaims: ClaimCheck = (text: string, _locale: string) => {
  const flags = new Set<string>();
  const t = String(text || '');
  for (const p of CLAIM_PATTERNS) {
    if (p.re.test(t)) flags.add(p.flag);
  }
  return { flags: [...flags].sort() };
};
