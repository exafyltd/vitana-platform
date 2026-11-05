/**
 * VTID-05551 (agentic-delivery/prerequisites) — the developer atlas claims the
 * two gateway route files the GitLab cutover adds, before they land.
 *
 * `routes/internal-gitlab-webhook.ts` (eng-gitlab-m2 lane scm-webhook) and
 * `routes/delivery.ts` (agentic-delivery lane gateway-delivery) belong to the
 * domain `deploy`. Without these claims the atlas drift guard in
 * `vtid-04560-role-separation-regression.test.ts` fails the moment either file
 * lands. The guard itself is unchanged.
 */
import { DOMAIN_ATLAS, domainsForRoute } from '../src/orb/developer/domain-atlas';

describe('VTID-05551 atlas claims for the GitLab delivery routes', () => {
  test('internal-gitlab-webhook belongs to the deploy domain, and only to it', () => {
    expect(domainsForRoute('internal-gitlab-webhook.ts').map((d) => d.key)).toEqual(['deploy']);
    expect(domainsForRoute('internal-gitlab-webhook').map((d) => d.key)).toEqual(['deploy']);
  });

  test('delivery belongs to the deploy domain, and only to it', () => {
    expect(domainsForRoute('delivery.ts').map((d) => d.key)).toEqual(['deploy']);
    expect(domainsForRoute('delivery').map((d) => d.key)).toEqual(['deploy']);
  });

  test('the claims are exact names, not prefixes', () => {
    for (const name of ['internal-gitlab-webhook-v2', 'internal-gitlab', 'deliveryx', 'delivery-status', 'xdelivery']) {
      expect(domainsForRoute(name).map((d) => d.key)).not.toContain('deploy');
    }
  });

  test('the deploy domain keeps its existing claims', () => {
    const deploy = DOMAIN_ATLAS.find((d) => d.key === 'deploy');
    expect(deploy).toBeDefined();
    for (const name of ['cicd', 'command-hub', 'commandhub', 'devhub', 'dev-access', 'dev-auth', 'canary-target', 'domain-routing']) {
      expect(domainsForRoute(name).map((d) => d.key)).toContain('deploy');
    }
  });
});
