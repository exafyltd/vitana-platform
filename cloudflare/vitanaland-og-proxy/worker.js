const SUPABASE_FUNCTIONS = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1';
const GATEWAY_URL = 'https://gateway-q74ibpv6ia-uc.a.run.app';

const CRAWLERS = ['whatsapp', 'facebookexternalhit', 'facebot',
  'twitterbot', 'linkedinbot', 'slackbot', 'telegrambot', 'discordbot'];

function isCrawler(ua) {
  return CRAWLERS.some(c => ua.toLowerCase().includes(c));
}

function parseRoute(pathname) {
  const match = pathname.match(/^\/(events|profiles|rooms|matches|products)\/(.+)$/);
  if (match) return { type: match[1], identifier: match[2] };
  // Handle /pub/events/{id} format
  const pubMatch = pathname.match(/^\/pub\/events\/(.+)$/);
  if (pubMatch) return { type: 'events', identifier: pubMatch[1] };
  // Backward compat: bare /{slug} → events
  const bare = pathname.replace(/^\//, '');
  if (bare) return { type: 'events', identifier: bare };
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatPrice(cents, currency) {
  if (cents == null || !currency) return '';
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * Build an HTML page with OG meta tags for a profile. Served to crawlers only.
 * Queries the gateway's public profile endpoint — no auth required.
 */
async function renderProfileOg(id, canonicalUrl, destinationUrl) {
  // Known-good public asset — same one og-match ships to WhatsApp today.
  // The `default-images` bucket was 403'ing (not actually public), which
  // is why profiles without an avatar rendered no image at all.
  const DEFAULT_IMAGE =
    'https://inmkhvwdcuyhnxkgfvsb.supabase.co/storage/v1/object/public/covers/vitana-og-default.jpg';

  const resp = await fetch(
    `${GATEWAY_URL}/api/v1/public/profile/${encodeURIComponent(id)}`,
  );
  if (!resp.ok) {
    return new Response('Profile not found', { status: 404 });
  }
  const body = await resp.json();
  const p = body && body.profile;
  if (!p) return new Response('Profile not found', { status: 404 });

  const composedName =
    [p.first_name, p.last_name].filter(Boolean).join(' ').trim() ||
    p.display_name ||
    (p.handle ? `@${p.handle}` : 'MAXINA member');
  const handlePart = p.handle ? `@${p.handle}` : '';
  const archetype = p.longevity_archetype || p.bio || 'Longevity community member';
  const title = `${composedName}${handlePart ? ` (${handlePart})` : ''} · MAXINA`;
  const description = `${handlePart ? handlePart + ' · ' : ''}${archetype}. Tap to view on MAXINA.`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  // cover_url is landscape-friendly; avatar_url is square (auto-fits on
  // WhatsApp/Telegram but below some crawlers' 1200x630 preference, which
  // is why DEFAULT_IMAGE is a landscape hero).
  const image = p.cover_url || p.avatar_url || DEFAULT_IMAGE;
  const isLandscape = !!p.cover_url || image === DEFAULT_IMAGE;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">

  <meta property="og:type" content="profile">
  <meta property="og:site_name" content="MAXINA">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:secure_url" content="${escapeHtml(image)}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:alt" content="${escapeHtml(composedName)}">
  <meta property="og:image:width" content="${isLandscape ? 1200 : 512}">
  <meta property="og:image:height" content="${isLandscape ? 630 : 512}">
  ${p.handle ? `<meta property="profile:username" content="${escapeHtml(p.handle)}">` : ''}
  ${p.first_name ? `<meta property="profile:first_name" content="${escapeHtml(p.first_name)}">` : ''}
  ${p.last_name ? `<meta property="profile:last_name" content="${escapeHtml(p.last_name)}">` : ''}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">

  <meta http-equiv="refresh" content="0;url=${escapeHtml(destinationUrl)}">
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(description)}</p>
  <p><img src="${escapeHtml(image)}" alt="${escapeHtml(composedName)}" style="max-width:100%"></p>
  <p><a href="${escapeHtml(destinationUrl)}">Open on MAXINA</a></p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

/**
 * Build an HTML page with OG meta tags for a product. Served to crawlers only.
 * Queries the gateway's public product endpoint — no auth required.
 */
async function renderProductOg(id, canonicalUrl) {
  const resp = await fetch(`${GATEWAY_URL}/api/v1/discover/product/${encodeURIComponent(id)}`);
  if (!resp.ok) {
    return new Response('Product not found', { status: 404 });
  }
  const { product: p } = await resp.json();
  if (!p) return new Response('Product not found', { status: 404 });

  const title = `${p.title}${p.brand ? ` — ${p.brand}` : ''}`;
  const priceLine = formatPrice(p.price_cents, p.currency);
  const rawDesc = p.description || p.description_long || `${p.title} on Vitana`;
  // Single-line, ~200 char description for OG description meta
  const description = rawDesc.replace(/\s+/g, ' ').trim().slice(0, 200) +
    (priceLine ? ` — ${priceLine}` : '');
  const image = (Array.isArray(p.images) && p.images[0]) || '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">

  <meta property="og:site_name" content="VITANA">
  <meta property="og:type" content="product">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="1200">
  <meta property="og:image:alt" content="${escapeHtml(p.title)}">` : ''}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  ${image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : ''}

  ${priceLine ? `<meta property="product:price:amount" content="${escapeHtml((p.price_cents / 100).toFixed(2))}">
  <meta property="product:price:currency" content="${escapeHtml((p.currency || 'USD').toUpperCase())}">` : ''}
  ${p.availability ? `<meta property="product:availability" content="${escapeHtml(p.availability)}">` : ''}
  ${p.brand ? `<meta property="product:brand" content="${escapeHtml(p.brand)}">` : ''}
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${priceLine ? `<p><strong>${escapeHtml(priceLine)}</strong></p>` : ''}
  <p>${escapeHtml(description)}</p>
  <p><a href="${escapeHtml(canonicalUrl)}">View on Vitana</a></p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

function getOgFunctionUrl(type, identifier) {
  switch (type) {
    case 'events':
      const isUUID = /^[0-9a-f]{8}-/.test(identifier);
      return `${SUPABASE_FUNCTIONS}/og-event?${isUUID ? 'id' : 'slug'}=${encodeURIComponent(identifier)}`;
    case 'profiles':
      return `${SUPABASE_FUNCTIONS}/og-profile?id=${encodeURIComponent(identifier)}`;
    case 'rooms':
      return `${SUPABASE_FUNCTIONS}/og-room?id=${encodeURIComponent(identifier)}`;
    case 'matches':
      return `${SUPABASE_FUNCTIONS}/og-match?id=${encodeURIComponent(identifier)}`;
    // products handled inline below via renderProductOg() — no Supabase Function needed
    default:
      return null;
  }
}

function getRedirectUrl(type, identifier) {
  switch (type) {
    case 'events':
      const isUUID = /^[0-9a-f]{8}-/.test(identifier);
      if (isUUID) {
        return `https://vitanaland.com/?share=event&id=${encodeURIComponent(identifier)}`;
      }
      return `https://vitanaland.com/?share=event&slug=${encodeURIComponent(identifier)}`;
    case 'profiles':
      return `https://vitanaland.com/?share=profile&id=${encodeURIComponent(identifier)}`;
    case 'rooms':
      return `https://vitanaland.com/?share=room&id=${encodeURIComponent(identifier)}`;
    case 'matches':
      return `https://vitanaland.com/discover?m=${encodeURIComponent(identifier)}`;
    case 'products':
      return `https://vitanaland.com/discover/product/${encodeURIComponent(identifier)}`;
    default:
      return 'https://vitanaland.com';
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const ua = request.headers.get('user-agent') || '';
    const route = parseRoute(url.pathname);

    if (!route) {
      return Response.redirect('https://vitanaland.com', 302);
    }

    if (isCrawler(ua)) {
      // Products: generate OG HTML inline from the gateway product endpoint.
      if (route.type === 'products') {
        const canonical = getRedirectUrl('products', route.identifier);
        return renderProductOg(route.identifier, canonical);
      }

      // Profiles: same pattern. Gateway has the profile row; we render the
      // OG HTML here so WhatsApp/Telegram see rich meta. The og-profile
      // Supabase function was never implemented — this supersedes that path.
      if (route.type === 'profiles') {
        const canonical = `https://e.vitanaland.com/profiles/${encodeURIComponent(route.identifier)}`;
        const destination = getRedirectUrl('profiles', route.identifier);
        return renderProfileOg(route.identifier, canonical, destination);
      }

      const ogUrl = getOgFunctionUrl(route.type, route.identifier);
      if (ogUrl) {
        const ogResp = await fetch(ogUrl, {
          headers: { 'User-Agent': ua }
        });
        const html = await ogResp.text();
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }

    return Response.redirect(getRedirectUrl(route.type, route.identifier), 302);
  }
};
