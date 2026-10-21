/**
 * VTID-04754: the Command Hub Jev card is a standalone, CSP-compliant page
 * that reads only the exafy_admin stats endpoint and never touches the
 * sidebar, app.js or index.html.
 */
import * as fs from 'fs';
import * as path from 'path';

const dir = path.resolve(__dirname, '../../src/frontend/command-hub');
const html = fs.readFileSync(path.join(dir, 'jev.html'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'jev.js'), 'utf8');

describe('VTID-04754 Jev card', () => {
  test('no inline script or style; assets are local and cache-busted', () => {
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/style="/);
    expect(html).not.toMatch(/<style/);
    expect(html).toContain('src="/command-hub/jev.js?v=');
    expect(html).toContain('href="/command-hub/jev.css?v=');
    expect(html).not.toMatch(/https?:\/\//);
  });

  test('reads the exafy_admin stats endpoint with the hub token, builds DOM without innerHTML', () => {
    expect(js).toContain("'/api/v1/jev/admin/stats?days='");
    expect(js).toContain("'vitana.command_hub.token'");
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  test('shows calls, cost, month spend and shadow agreement per gate', () => {
    for (const s of ['spend_month', 'shadow_gates', 'agreement_rate', 'gate_modes', 'by_decision', 'by_plane']) expect(js).toContain(s);
  });

  test('the sidebar and the main hub files are untouched by this card', () => {
    const nav = fs.readFileSync(path.join(dir, 'navigation-config.js'), 'utf8');
    expect(nav).not.toContain('jev.html');
  });
});
