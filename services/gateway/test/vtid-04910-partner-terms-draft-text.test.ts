/**
 * VTID-04910 — the Partner Terms v1 draft text (docs/legal/partner-terms/2026-10).
 *
 * German is the source; the 10 translations must keep its exact structure:
 * the same numbered sections, clauses and list letters, the counsel-review
 * markers in the same places, the same placeholder, the owner's binding-
 * language and governing-law wording, and no bidi control characters. The 11
 * files must also be valid content for the admin API (VTID-04909: German
 * binding, English present, exact BCP-47 codes).
 *
 * This is a draft: nothing here creates, publishes or accepts anything.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireExafyAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn() }));

import { parseTermsContent } from '../src/routes/admin-partner-terms';
import { SUPPORTED_TERMS_LOCALES } from '../src/services/partner-terms';

const DIR = path.resolve(__dirname, '../../../docs/legal/partner-terms/2026-10');
const REVIEW = 'FINAL LEGAL COUNSEL REVIEW REQUIRED BEFORE PUBLICATION';
const CONFIRM = 'FINAL LEGAL COUNSEL CONFIRMATION REQUIRED';
const PLACEHOLDER = '[LEGAL NOTICE CONTACT TO CONFIRM]';

const read = (code: string) => fs.readFileSync(path.join(DIR, `${code}.md`), 'utf8');
const split = (raw: string) => {
  const [first, ...rest] = raw.split('\n');
  return { title: first.replace(/^# /, '').trim(), body_md: rest.join('\n').trim(), titleLine: first };
};
const structure = (body: string) => ({
  sections: [...body.matchAll(/^## (\d+)\./gm)].map((m) => m[1]),
  clauses: [...body.matchAll(/^(\d+\.\d+) /gm)].map((m) => m[1]),
  letters: [...body.matchAll(/^([a-z])\) /gm)].map((m) => m[1]),
});
/** The line after a heading's blank line, for every `## <n>.` in `ns`. */
const lineAfterHeading = (body: string, n: string) => {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`## ${n}.`));
  return i < 0 ? undefined : lines.slice(i + 1).find((l) => l.trim() !== '');
};

const texts = Object.fromEntries(SUPPORTED_TERMS_LOCALES.map((c) => [c, split(read(c))])) as Record<string, ReturnType<typeof split>>;
const german = structure(texts.de.body_md);

describe('VTID-04910: Partner Terms v1 draft text', () => {
  it('has exactly the 11 languages, nothing else', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, '')).sort();
    expect(files).toEqual([...SUPPORTED_TERMS_LOCALES].sort());
  });

  it('the README marks it as an unpublished draft under counsel review', () => {
    const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/DRAFT · COUNSEL REVIEW · NOT PUBLICATION-APPROVED/);
    expect(readme).toMatch(/nothing is published, nothing is\s+accepted/);
  });

  it('German has the 21 sections of the owner structure', () => {
    expect(german.sections).toEqual(Array.from({ length: 21 }, (_, i) => String(i + 1)));
    expect(german.clauses.length).toBeGreaterThan(50);
  });

  it.each(SUPPORTED_TERMS_LOCALES.filter((c) => c !== 'de'))('%s keeps the German structure exactly', (code) => {
    const t = texts[code];
    expect(t.titleLine.startsWith('# ')).toBe(true);
    expect(t.title.length).toBeGreaterThan(0);
    expect(structure(t.body_md)).toEqual(german);
  });

  it.each(SUPPORTED_TERMS_LOCALES)('%s carries the counsel markers, the placeholder, and no bidi controls', (code) => {
    const body = texts[code].body_md;
    for (const n of ['15', '16', '20']) expect(lineAfterHeading(body, n)?.trim()).toBe(REVIEW);
    expect(body.split(REVIEW).length - 1).toBe(3);
    // The court sentence (20.2) carries its own confirmation marker, directly above it.
    const lines = body.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.startsWith('20.2 '));
    expect(lines[i - 1]).toBe(CONFIRM);
    expect(body.split(CONFIRM).length - 1).toBe(1);
    expect(body.split(PLACEHOLDER).length - 1).toBe(1);
    expect(lines.find((l) => l.startsWith('21.1 '))).toContain(PLACEHOLDER);
    expect(body).toContain('EXAFY LTD');
    expect(body).toContain('000006675');
    expect(body).toContain('DD-16-121-018, Floor 16, Al Khatem Tower, WeWork Hub71, ADGM Square, Al Maryah Island');
    expect(body).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
    // No commission split is promised in the general terms.
    expect(body).not.toMatch(/10\s?%|5\s?%/);
  });

  it('German and English carry the owner wording for §19 and §20', () => {
    const de = texts.de.body_md;
    expect(de).toContain(
      '19.1 Die deutsche Fassung dieser Partnerbedingungen ist die rechtsverbindliche und maßgebliche Fassung. Übersetzungen in andere Sprachen werden zur besseren Verständlichkeit bereitgestellt. Bei Abweichungen, Unterschieden oder Widersprüchen zwischen Sprachfassungen ist die deutsche Fassung maßgeblich.',
    );
    expect(de).toContain('20.1 Diese Partnerbedingungen unterliegen dem Recht der Vereinigten Arabischen Emirate, soweit zwingende gesetzliche Vorschriften nichts anderes bestimmen.');
    expect(de).toContain('20.2 Soweit rechtlich zulässig, sind für Streitigkeiten aus oder im Zusammenhang mit diesen Partnerbedingungen die zuständigen Gerichte in Abu Dhabi, Vereinigte Arabische Emirate, zuständig.');
    const en = texts.en.body_md;
    expect(en).toContain(
      '19.1 The German version of these Partner Terms is the legally binding and authoritative version. Translations into other languages are provided for convenience and understanding. In the event of any discrepancy, difference or conflict between language versions, the German version prevails.',
    );
    expect(en).toContain('20.1 These Partner Terms are governed by the laws of the United Arab Emirates, except where mandatory legal provisions require otherwise.');
    expect(en).toContain('20.2 To the extent legally permitted, the competent courts of Abu Dhabi, United Arab Emirates, shall have jurisdiction over disputes arising out of or in connection with these Partner Terms.');
  });

  it('the 11 files are valid admin content: German binding, English present, exact codes', () => {
    const content = Object.fromEntries(SUPPORTED_TERMS_LOCALES.map((c) => [c, { title: texts[c].title, body_md: texts[c].body_md }]));
    const r = parseTermsContent(content);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.content)).toEqual([...SUPPORTED_TERMS_LOCALES]);
  });
});
