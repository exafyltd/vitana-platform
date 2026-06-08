// Phase 0 staging preview router (handoff brief P0.6 extension):
//
// Cloudflare Worker that proxies `preview-gateway.vitanaland.com` and
// `preview.vitanaland.com` to their staging Cloud Run services with the
// Host header rewritten to the *.run.app value.
//
// Why: Cloud Run rejects requests whose Host header doesn't match either
// the *.run.app URL or a registered custom-domain mapping (which would need
// Google Search Console verification of every subdomain).  Cloudflare's
// free-tier proxy preserves the original Host header by default — that's
// what trips Cloud Run.  Origin Rules with Host override are a paid feature
// ("not entitled to use the HostHeader override"), so a tiny Worker that
// re-fetches with the correct Host is the cheapest correct fix.
//
// The Worker rewrites Host implicitly: `fetch(targetUrl, …)` always sends
// the Host that matches the URL's hostname.  All other headers/body/method
// pass through.
//
// Route bindings are in wrangler.toml.  DNS records (CNAMEs, proxied=true)
// for both hostnames must exist in the vitanaland.com zone so the request
// reaches Cloudflare and the Worker route can intercept it.

const ROUTES = {
  'preview-gateway.vitanaland.com': 'https://gateway-staging-q74ibpv6ia-uc.a.run.app',
  'preview.vitanaland.com':         'https://community-app-staging-q74ibpv6ia-uc.a.run.app',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = ROUTES[url.hostname];
    if (!origin) {
      return new Response(
        `Unknown preview hostname: ${url.hostname}. Configured: ${Object.keys(ROUTES).join(', ')}`,
        { status: 404, headers: { 'content-type': 'text/plain' } }
      );
    }

    const targetUrl = new URL(origin);
    targetUrl.pathname = url.pathname;
    targetUrl.search = url.search;

    // fetch() infers Host from the URL's hostname, so the Cloud Run origin
    // sees Host=gateway-staging-q74….run.app and routes correctly.  All
    // other headers (auth, content-type, user-agent, etc.) pass through.
    return fetch(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
    });
  },
};
