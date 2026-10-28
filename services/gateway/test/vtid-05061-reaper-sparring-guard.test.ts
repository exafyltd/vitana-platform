/**
 * VTID-05061: allocatedOrphanReaperTick() tombstoned VTID-05045/05046 — two
 * VTIDs allocated with a Plan Sparring binding for an owner-approved plan —
 * ~10 min after allocation while their title UPDATE was still timing out.
 * A sparring-bound shell is a deliberate allocation, never an orphan.
 *
 * Same source-level pattern as vtid-03818-reaper-terminal-flag.test.ts (the
 * reaper isn't exported and needs a live Supabase): the candidate SELECT and
 * the tombstoning PATCH must both exclude rows carrying
 * metadata.sparring_id or metadata.sparring_id_unverified, and the reaper
 * must warn about sparring-bound shells left untitled for over an hour.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/services/dev-autopilot-execute.ts'),
  'utf8'
);

const ID_NULL = 'metadata->>sparring_id=is.null';
const UNVERIFIED_NULL = 'metadata->>sparring_id_unverified=is.null';

function reaperFunctionBody(): string {
  const start = SOURCE.indexOf('async function allocatedOrphanReaperTick');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\nlet backgroundTickerStarted', start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** Resolves `REAPER_NOT_SPARRING_BOUND` / `REAPER_PLACEHOLDER_TITLE` to their literal text. */
function constValue(name: string): string {
  const m = SOURCE.match(new RegExp(`const ${name} =\\s*\`([^\`]*)\`;`));
  return m ? m[1] : '';
}

function expand(text: string): string {
  return text
    .replace(/\$\{REAPER_NOT_SPARRING_BOUND\}/g, constValue('REAPER_NOT_SPARRING_BOUND'))
    .replace(/REAPER_NOT_SPARRING_BOUND/g, '`' + constValue('REAPER_NOT_SPARRING_BOUND') + '`')
    .replace(/REAPER_PLACEHOLDER_TITLE/g, '`' + constValue('REAPER_PLACEHOLDER_TITLE') + '`');
}

/** The candidate SELECT: the supa() call whose URL tombstones are drawn from. */
function candidateSelect(): string {
  const body = reaperFunctionBody();
  const start = body.indexOf('const orphansR');
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf(');', start);
  return expand(body.slice(start, end));
}

/** The tombstoning PATCH's URL. */
function patchUrl(): string {
  const body = reaperFunctionBody();
  const m = body.match(/await supa\(s, (`[^`]*`), \{\s*method: 'PATCH'/);
  expect(m).not.toBeNull();
  return expand(m![1]);
}

describe('allocatedOrphanReaperTick sparring-binding guard (VTID-05061)', () => {
  it('candidate SELECT excludes rows with metadata.sparring_id', () => {
    expect(candidateSelect()).toContain(ID_NULL);
  });

  it('candidate SELECT excludes rows with metadata.sparring_id_unverified', () => {
    expect(candidateSelect()).toContain(UNVERIFIED_NULL);
  });

  it('candidate SELECT keeps its existing scope (allocated, placeholder title)', () => {
    const sel = candidateSelect();
    expect(sel).toContain('status=eq.allocated');
    expect(sel).toContain('title.eq.Allocated%20-%20Pending%20Title');
  });

  it('tombstoning PATCH filter excludes rows with metadata.sparring_id', () => {
    expect(patchUrl()).toContain(ID_NULL);
  });

  it('tombstoning PATCH filter excludes rows with metadata.sparring_id_unverified', () => {
    expect(patchUrl()).toContain(UNVERIFIED_NULL);
  });

  it('tombstoning PATCH still requires status=allocated', () => {
    expect(patchUrl()).toContain('status=eq.allocated');
  });

  it('counts sparring-bound placeholder shells older than 1h and warns once per tick', () => {
    const body = reaperFunctionBody();
    expect(SOURCE).toMatch(/const SPARRING_BOUND_WARN_AGE_MS = 60 \* 60 \* 1000;/);
    expect(body).toContain('metadata->>sparring_id.not.is.null');
    expect(body).toContain('metadata->>sparring_id_unverified.not.is.null');
    const warns = body.match(/console\.warn\([^)]*sparring-bound shell\(s\) older than 1h/g) || [];
    expect(warns).toHaveLength(1);
    // Telemetry only — no OASIS event from the reaper.
    const reaperOnly = body.slice(0, body.indexOf('\n}\n') + 2);
    expect(reaperOnly.length).toBeGreaterThan(100);
    expect(reaperOnly).not.toMatch(/emitOasisEvent|oasis_events/);
  });
});
