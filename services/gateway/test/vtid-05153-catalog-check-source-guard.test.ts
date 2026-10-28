/**
 * VTID-05153 — source guard for services/catalog-check/**: the routine only
 * UPDATEs existing products rows (never INSERTs), never writes is_active,
 * merchant_id, listing_hold or first_listed_at (so the VTID-04769 gate trigger,
 * BEFORE INSERT OR UPDATE OF is_active, merchant_id, never fires from it), and
 * calls no LLM. Comments are stripped before scanning, so the file headers can
 * name what the code must not do.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(__dirname, '../src/services/catalog-check');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'));

function code(file: string): string {
  return fs
    .readFileSync(path.join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

describe('catalog-check source guard', () => {
  it('has the three planned modules', () => {
    expect(files.sort()).toEqual(['claim-prescreen.ts', 'run.ts', 'validators.ts']);
  });

  it.each(files)('%s inserts nothing and uses no POST/upsert', (f) => {
    const src = code(f);
    expect(src).not.toMatch(/\.insert\s*\(/);
    expect(src).not.toMatch(/\bupsert\b/i);
    expect(src).not.toMatch(/['"]POST['"]/);
    expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(src).not.toMatch(/\.rpc\s*\(/);
  });

  it.each(files)('%s never names listing_hold or first_listed_at', (f) => {
    expect(code(f)).not.toMatch(/listing_hold|first_listed_at/);
  });

  it.each(files)('%s mentions is_active / merchant_id only to read or filter, never to set', (f) => {
    const allowed = [
      /^\s*is_active\?: boolean \| null;$/, // CheckRow field (type)
      /^\s*merchant_id: string;$/, // CheckRow field (type)
      /'certifications,is_active,created_at';$/, // POOL_SELECT (read)
      /^\s*'id,merchant_id,title,/, // POOL_SELECT (read)
      /parts\.push\('is_active=eq\.false'\)/, // guard filter (WHERE, not SET)
      /c\.is_active === false \?/, // read
      /r\.merchant_id/, // read
      /merchants\.get\(r\.merchant_id\)/, // read
    ];
    const offending = code(f)
      .split('\n')
      .filter((l) => /\b(is_active|merchant_id)\b/.test(l))
      .filter((l) => !allowed.some((re) => re.test(l)));
    expect(offending).toEqual([]);
  });

  it.each(files)('%s calls no LLM', (f) => {
    expect(code(f)).not.toMatch(/llm-router|callViaRouter|bedrock|anthropic|openai|gemini|vertex|deepseek/i);
  });

  it('the one write is a PATCH to /rest/v1/products', () => {
    const run = code('run.ts');
    expect(run.match(/method:\s*'[A-Z]+'/g)).toEqual(["method: 'PATCH'"]);
    expect(run).toContain('/rest/v1/products?${filters}&select=id');
  });
});
