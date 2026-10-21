/**
 * VTID-04458 — golden-file helper for the calendar regression suite.
 *
 * Every scenario's output is compared with a recorded JSON file under
 * __golden__/. A change in calendar behaviour therefore fails the suite,
 * and the reviewer sees exactly which scenario moved.
 *
 * If the change is intended, re-record and commit the golden diff with it:
 *   UPDATE_CALENDAR_GOLDEN=1 npx jest test/calendar
 * A missing golden file fails in CI; it is never created silently.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(__dirname, '__golden__');
const UPDATE = process.env.UPDATE_CALENDAR_GOLDEN === '1';

/** JSON round-trip so undefined keys, Dates and key order are normalised. */
function normalise(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? null : v)));
}

export function expectGolden(file: string, scenario: string, value: unknown): void {
  const p = path.join(DIR, `${file}.json`);
  const current: Record<string, unknown> = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  const actual = normalise(value);
  if (UPDATE) {
    current[scenario] = actual;
    const sorted = Object.fromEntries(Object.keys(current).sort().map((k) => [k, current[k]]));
    fs.writeFileSync(p, `${JSON.stringify(sorted, null, 2)}\n`);
    return;
  }
  if (!(scenario in current)) {
    throw new Error(
      `No golden output for "${file}/${scenario}". Record it with UPDATE_CALENDAR_GOLDEN=1 and commit the file.`,
    );
  }
  expect(actual).toEqual(current[scenario]);
}
