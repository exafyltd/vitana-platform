/**
 * VTID-04382 — the route the typed feedback tools resolve their surface from
 * actually reaches them on the Vertex / Nova / cascade dispatch path.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('typed feedback tool context plumbing', () => {
  it('the generic ORB tool dispatch passes current_route and is_mobile', () => {
    const src = read('src/routes/orb-live.ts');
    expect(src).toContain('current_route: session.current_route ?? null,\n                is_mobile: session.is_mobile === true,');
  });
  it('dispatchOrbToolForVertex forwards current_route into the tool identity', () => {
    const src = read('src/services/orb-tools-shared.ts');
    expect(src).toContain('current_route: identity.current_route ?? null,');
    expect(src).toMatch(/interface VertexLikeIdentity \{[\s\S]*?current_route\?: string \| null;[\s\S]*?\}/);
  });
});
