/**
 * VTID-04491 — Conversation hub rebuild, Phase 0 (plan §6 B8).
 *
 * Source contracts for the Command Hub side of the fixes:
 *   - the Tool Catalog screen sends the bearer the catalog routes now require;
 *   - Monitor stops claiming the score "changes nothing Vitana says" and
 *     reports the openings the score actually chose (VTID-04454);
 *   - Awareness screens stop naming Gemini Live as the voice model;
 *   - the Tool Catalog stops labelling the gateway transport "Vertex".
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const HUB = join(__dirname, '../src/frontend/command-hub');
const APP = readFileSync(join(HUB, 'app.js'), 'utf8');
const INDEX = readFileSync(join(HUB, 'index.html'), 'utf8');

describe('VTID-04491 — Command Hub Phase 0', () => {
  test('Tool Catalog fetches send the exafy_admin bearer via buildContextHeaders()', () => {
    expect(APP).toContain("fetch(url, { headers: buildContextHeaders(), credentials: 'include' })");
    expect(APP).toContain("fetch('/api/v1/voice-tools/catalog/stats', { headers: buildContextHeaders(), credentials: 'include' })");
    expect(APP).not.toMatch(/fetch\('\/api\/v1\/voice-tools\/catalog\/stats', \{ credentials: 'include' \}\)/);
  });

  test('Monitor no longer says the score changes nothing, and reports scored openings', () => {
    expect(APP).not.toContain('changes nothing Vitana says');
    expect(APP).toContain('d.scored_openings');
    expect(APP).toContain("_convTile('Scored openings'");
    expect(APP).toContain('d.scored_changed_opening');
  });

  test('Awareness screens no longer name Gemini Live as the live voice model', () => {
    expect(APP).not.toContain('Gemini Live system_instruction');
    expect(APP).not.toContain('Gemini Live prompt');
    expect(APP).not.toContain('what Gemini Live would see');
    expect(APP).not.toContain('Sections reaching Gemini Live');
  });

  test('Tool Catalog labels the gateway transport, not Vertex', () => {
    expect(APP).not.toContain('<option value="vertex_only">Vertex only</option>');
    expect(APP).not.toContain("label = 'VERTEX'");
    expect(APP).toContain("label = 'GATEWAY'");
  });

  test('cache-buster bumped for app.js and styles.css together', () => {
    const ver = (INDEX.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(ver >= '20261012-vtid-04491').toBe(true);
    expect(INDEX).toContain('styles.css?v=' + ver);
  });
});
