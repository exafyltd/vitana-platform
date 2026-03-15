const SUPABASE_FUNCTIONS = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1';

const CRAWLERS = ['whatsapp', 'facebookexternalhit', 'facebot',
  'twitterbot', 'linkedinbot', 'slackbot', 'telegrambot', 'discordbot'];

function isCrawler(ua) {
  return CRAWLERS.some(c => ua.toLowerCase().includes(c));
}

function parseRoute(pathname) {
  const match = pathname.match(/^\/(events|profiles|rooms|matches)\/(.+)$/);
  if (match) return { type: match[1], identifier: match[2] };
  // Backward compat: bare /{slug} → events
  const bare = pathname.replace(/^\//, '');
  if (bare) return { type: 'events', identifier: bare };
  return null;
}

function getOgFunctionUrl(type, identifier) {
  switch (type) {
    case 'events':
      return `${SUPABASE_FUNCTIONS}/og-event?slug=${encodeURIComponent(identifier)}`;
    case 'profiles':
      return `${SUPABASE_FUNCTIONS}/og-profile?id=${encodeURIComponent(identifier)}`;
    case 'rooms':
      return `${SUPABASE_FUNCTIONS}/og-room?id=${encodeURIComponent(identifier)}`;
    case 'matches':
      return `${SUPABASE_FUNCTIONS}/og-match?id=${encodeURIComponent(identifier)}`;
    default:
      return null;
  }
}

function getRedirectUrl(type, identifier) {
  switch (type) {
    case 'events':
      return `https://vitanaland.com/?share=event&slug=${encodeURIComponent(identifier)}`;
    case 'profiles':
      return `https://vitanaland.com/?share=profile&id=${encodeURIComponent(identifier)}`;
    case 'rooms':
      return `https://vitanaland.com/?share=room&id=${encodeURIComponent(identifier)}`;
    case 'matches':
      return `https://vitanaland.com/discover?m=${encodeURIComponent(identifier)}`;
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
