/**
 * VTID-04458 — calendar regression suite: nothing calendar ships untested.
 *
 * test/calendar/manifest.json lists every calendar source file and the tests
 * that protect it. This guard fails when:
 *   - a new calendar file appears under src/ without a manifest entry
 *     (add it, with the test that covers it, in the same change);
 *   - a listed test file is gone, or no longer imports the file it covers;
 *   - an entry points at a source file that no longer exists;
 *   - the CALENDAR-REGRESSION workflow stops watching the calendar code,
 *     or stops running a listed test.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..'); // services/gateway
const REPO = path.join(ROOT, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')) as {
  sources: Record<string, { tests: string[]; via?: string }>;
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

/** A calendar source: any TypeScript file under src/ with "calendar" in its name. */
const discovered = walk(path.join(ROOT, 'src'))
  .filter((p) => /\.ts$/.test(p) && /calendar/i.test(path.basename(p)))
  .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
  .sort();

describe('calendar coverage manifest', () => {
  it('lists every calendar source file', () => {
    const missing = discovered.filter((f) => !manifest.sources[f]);
    if (missing.length) {
      throw new Error(`Calendar files with no manifest entry (add them to test/calendar/manifest.json with the tests that cover them):\n  ${missing.join('\n  ')}`);
    }
  });

  it('lists no file that is gone', () => {
    const gone = Object.keys(manifest.sources).filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(gone).toEqual([]);
  });

  it.each(Object.entries(manifest.sources))('%s is imported by each listed test', (src, entry) => {
    expect(entry.tests.length).toBeGreaterThan(0);
    const mod = entry.via ?? path.basename(src, '.ts');
    for (const t of entry.tests) {
      const file = path.join(ROOT, t);
      if (!fs.existsSync(file)) throw new Error(`${src}: listed test ${t} does not exist`);
      const body = fs.readFileSync(file, 'utf8');
      // An import/require/mock path ending in the module name.
      const re = new RegExp(`['"][^'"]*/${mod.replace(/[-/]/g, (c) => `\\${c}`)}['"]`);
      if (!re.test(body)) throw new Error(`${src}: ${t} no longer imports ${mod}`);
    }
  });

  it('the CALENDAR-REGRESSION workflow watches the calendar code and runs every listed test', () => {
    const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'CALENDAR-REGRESSION.yml'), 'utf8');
    for (const p of ["services/gateway/src/**/*calendar*", "services/gateway/test/calendar/**", "supabase/migrations/*calendar*"]) {
      expect(wf).toContain(p);
    }
    const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['test:calendar'] as string;
    expect(script).toBeTruthy();
    expect(wf).toContain('test:calendar');
    const tests = [...new Set(Object.values(manifest.sources).flatMap((e) => e.tests))];
    for (const t of tests) {
      // The script runs test/calendar and every other listed suite by path.
      if (t.startsWith('test/calendar/')) continue;
      expect(script).toContain(t);
    }
  });
});
