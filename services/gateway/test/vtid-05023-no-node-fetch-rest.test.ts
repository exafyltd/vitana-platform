/**
 * VTID-05023: regression guard for the REST switch.
 *
 * In aurora_proxy mode, the global fetch wrapper (src/lib/data-rest-base.ts)
 * rewrites `${SUPABASE_URL}/rest/v1` calls. node-fetch never calls
 * globalThis.fetch, so a file that imports node-fetch and builds REST URLs
 * bypasses the wrapper. This test fails if any such file exists under src.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const REST_TEXT = 'SUPABASE_URL}/rest/v1';
const NODE_FETCH_IMPORT = /(?:from\s+|require\(\s*)['"]node-fetch['"]/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('VTID-05023 no node-fetch for REST calls', () => {
  it('no file under src both builds a SUPABASE_URL/rest/v1 URL and imports node-fetch', () => {
    const offenders = listTsFiles(SRC_DIR)
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return text.includes(REST_TEXT) && NODE_FETCH_IMPORT.test(text);
      })
      .map((file) => path.relative(path.resolve(__dirname, '..'), file));

    expect(offenders).toEqual([]);
  });
});
