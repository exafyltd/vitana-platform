import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.56.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isCrawler(userAgent: string): boolean {
  const crawlers = [
    'WhatsApp', 'facebookexternalhit', 'Facebot', 'Twitterbot',
    'LinkedInBot', 'Slackbot', 'TelegramBot', 'SkypeUriPreview',
    'Discordbot', 'redditbot',
  ];
  return crawlers.some((crawler) => userAgent.includes(crawler));
}

function sanitizeText(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/“|”/g, '"')
    .replace(/‘|’/g, "'")
    .replace(/`/g, "'")
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .substring(0, max);
}

const DEFAULT_IMAGE =
  'https://inmkhvwdcuyhnxkgfvsb.supabase.co/storage/v1/object/public/default-images/vitana-og-default.jpg';

interface ProfileRow {
  id: string;
  handle: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  longevity_archetype: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
}

function fallbackHTML(): string {
  const homeUrl = 'https://vitanaland.com';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MAXINA - Longevity Community</title>
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="MAXINA" />
  <meta property="og:title" content="MAXINA - Longevity Community" />
  <meta property="og:description" content="Join MAXINA to connect with the longevity community." />
  <meta property="og:image" content="${DEFAULT_IMAGE}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${homeUrl}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta http-equiv="refresh" content="0;url=${homeUrl}">
</head>
<body><p>Redirecting to MAXINA…</p><a href="${homeUrl}">Click here</a></body>
</html>`;
}

function buildProfileHTML(
  profile: ProfileRow,
  canonicalUrl: string,
  destinationUrl: string,
): string {
  const composedName =
    [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
    profile.display_name ||
    (profile.handle ? `@${profile.handle}` : 'MAXINA member');

  const handlePart = profile.handle ? `@${profile.handle}` : '';
  const archetype = profile.longevity_archetype || profile.bio || 'Longevity community member';

  const title = sanitizeText(`${composedName}${handlePart ? ` (${handlePart})` : ''} · MAXINA`, 80);
  const description = sanitizeText(
    `${handlePart ? handlePart + ' · ' : ''}${archetype}. Tap to view on MAXINA.`,
    200,
  );

  // cover_url is landscape-friendly; avatar_url works too (WhatsApp/Telegram
  // auto-fit square images). Fall back to the default MAXINA OG image.
  const image = profile.cover_url || profile.avatar_url || DEFAULT_IMAGE;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}" />

  <meta property="og:type" content="profile" />
  <meta property="og:site_name" content="MAXINA" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${image}" />
  <meta property="og:image:alt" content="${sanitizeText(composedName, 80)}" />
  ${profile.cover_url
    ? `<meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />`
    : `<meta property="og:image:width" content="512" />
  <meta property="og:image:height" content="512" />`}
  <meta property="og:url" content="${canonicalUrl}" />
  ${profile.handle ? `<meta property="profile:username" content="${sanitizeText(profile.handle, 80)}" />` : ''}
  ${profile.first_name ? `<meta property="profile:first_name" content="${sanitizeText(profile.first_name, 80)}" />` : ''}
  ${profile.last_name ? `<meta property="profile:last_name" content="${sanitizeText(profile.last_name, 80)}" />` : ''}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${image}" />

  <link rel="canonical" href="${canonicalUrl}" />
  <meta http-equiv="refresh" content="0;url=${destinationUrl}" />
</head>
<body>
  <h1>${title}</h1>
  <p>${description}</p>
  <p><a href="${destinationUrl}">Open on MAXINA</a></p>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const profileId = url.searchParams.get('id');
    const userAgent = req.headers.get('user-agent') || '';

    console.log('og-profile request:', {
      profileId,
      isCrawler: isCrawler(userAgent),
    });

    if (!profileId) {
      return new Response(fallbackHTML(), {
        headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Accept either the profiles.id UUID (current share URL format)
    // or a handle (future-proofing for pretty URLs).
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        profileId,
      );

    const query = supabase
      .from('profiles')
      .select(
        'id, handle, display_name, first_name, last_name, longevity_archetype, bio, avatar_url, cover_url',
      );
    const { data, error } = await (isUUID
      ? query.eq('id', profileId).maybeSingle()
      : query.eq('handle', profileId).maybeSingle());

    if (error || !data) {
      console.warn('og-profile: not found', { profileId, err: error?.message });
      return new Response(fallbackHTML(), {
        headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const profile = data as ProfileRow;
    const canonicalUrl = `https://e.vitanaland.com/profiles/${profile.id}`;
    const destinationUrl = `https://vitanaland.com/?share=profile&id=${profile.id}`;

    if (isCrawler(userAgent)) {
      return new Response(
        buildProfileHTML(profile, canonicalUrl, destinationUrl),
        {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        },
      );
    }

    // Non-crawler hitting the edge function directly: bounce them on.
    return new Response(null, {
      status: 302,
      headers: { ...corsHeaders, Location: destinationUrl },
    });
  } catch (err) {
    console.error('og-profile error:', err);
    return new Response(fallbackHTML(), {
      headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
});
