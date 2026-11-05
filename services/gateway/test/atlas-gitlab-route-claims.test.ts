/**
 * VTID-05551 (agentic-delivery/prerequisites) — the developer atlas claims the two route files the GitLab lanes
 * add, before those files land (plan agentic-delivery §9):
 *   - routes/internal-gitlab-webhook.ts — eng-gitlab-m2 lane scm-webhook
 *   - routes/delivery.ts                — agentic-delivery lane gateway-delivery
 *
 * The drift guard in test/vtid-04560-role-separation-regression.test.ts fails for any src/routes file that no
 * domain claims. With these claims both files pass it as soon as they are added. Both belong to domain `deploy`
 * (deploys, CI/CD and the Command Hub).
 */
import * as fs from 'fs';
import * as path from 'path';
import { DOMAIN_ATLAS, domainsForRoute } from '../src/orb/developer/domain-atlas';

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const NEW_ROUTE_FILES = ['internal-gitlab-webhook.ts', 'delivery.ts'];

/** The drift guard's walk: every .ts file under src/routes (relative path), without tests and .d.ts files. */
function listRouteFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const r = rel ? `${rel}/${f}` : f;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')) out.push(r);
    }
  };
  walk(ROUTES_DIR, '');
  return out;
}

const domainKeys = (routeFile: string): string[] => domainsForRoute(routeFile).map((d) => d.key);

describe('VTID-05551 atlas claims for the GitLab delivery route files', () => {
  test.each(NEW_ROUTE_FILES)('%s is claimed by domain deploy, and only by it', (file) => {
    // The drift guard passes the file name with .ts; domainsForRoute also accepts the bare name.
    expect(domainKeys(file)).toEqual(['deploy']);
    expect(domainKeys(file.replace(/\.ts$/, ''))).toEqual(['deploy']);
  });

  test("the drift guard passes for today's route files plus the two new ones", () => {
    const files = [...listRouteFiles(), ...NEW_ROUTE_FILES];
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => domainsForRoute(f).length === 0)).toEqual([]);
  });

  test('the new claims match the exact file names only', () => {
    const deploy = DOMAIN_ATLAS.find((d) => d.key === 'deploy');
    expect(deploy).toBeDefined();
    const nearMisses = ['delivery-old', 'my-delivery', 'deliveryx', 'internal-gitlab-webhook-v2', 'x-internal-gitlab-webhook', 'gitlab-webhook'];
    for (const name of nearMisses) {
      expect({ name, claimed: deploy!.routes.some((r) => r.test(name)) }).toEqual({ name, claimed: false });
    }
  });
});
