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
  return crawlers.some(crawler => userAgent.includes(crawler));
}

function sanitizeText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/`/g, "'")
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .substring(0, 160);
}

const TYPE_LABELS: Record<string, string> = {
  person: 'Person',
  group: 'Group',
  event: 'Event',
  service: 'Service',
  product: 'Product',
  location: 'Location',
  live_room: 'Live Room',
};

const TYPE_EMOJI: Record<string, string> = {
  person: '🤝',
  group: '👥',
  event: '🎉',
  service: '🛎️',
  product: '🎁',
  location: '📍',
  live_room: '🔴',
};

interface MatchData {
  id: string;
  match_type: string;
  score: number;
  target_display_name: string;
  shared_topics: string[];
}

function generateFallbackHTML(): string {
  const defaultImage = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/storage/v1/object/public/covers/vitana-og-default.jpg';
  const homeUrl = 'https://vitanaland.com/discover';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VITANA - Discover Matches</title>
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="VITANA" />
  <meta property="og:title" content="VITANA - Discover Matches" />
  <meta property="og:description" content="Discover personalized matches on VITANA — people, events, groups, and more" />
  <meta property="og:image" content="${defaultImage}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${homeUrl}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta http-equiv="refresh" content="0;url=${homeUrl}">
</head>
<body><p>Redirecting to VITANA...</p><a href="${homeUrl}">Click here</a></body>
</html>`;
}

function generateOGHTML(match: MatchData, canonicalUrl: string, destinationUrl: string): string {
  const emoji = TYPE_EMOJI[match.match_type] || '✨';
  const typeLabel = TYPE_LABELS[match.match_type] || match.match_type;
  const title = sanitizeText(`${emoji} ${match.target_display_name}`) || 'VITANA Match';
  const topicsText = match.shared_topics.length > 0
    ? match.shared_topics.slice(0, 3).join(', ')
    : 'shared interests';
  const description = sanitizeText(
    `${typeLabel} match — Score: ${match.score}/100. You share interest in ${topicsText}. Tap to discover on VITANA.`
  );
  const defaultImage = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/storage/v1/object/public/covers/vitana-og-default.jpg';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | VITANA</title>
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="VITANA" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${defaultImage}" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${defaultImage}" />
  <link rel="canonical" href="${canonicalUrl}" />
  <meta http-equiv="refresh" content="0;url=${destinationUrl}">
</head>
<body><p>Redirecting to ${title}...</p><a href="${destinationUrl}">Click here</a></body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const matchId = url.searchParams.get('id');
    const userAgent = req.headers.get('user-agent') || '';

    console.log('og-match request:', { matchId, isCrawler: isCrawler(userAgent) });

    if (!matchId) {
      return new Response(generateFallbackHTML(), {
        headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Query match + target info
    const { data, error } = await supabase
      .from('matches_daily')
      .select(`
        id,
        match_type,
        score,
        match_targets!inner (
          display_name,
          topic_keys
        )
      `)
      .eq('id', matchId)
      .single();

    if (error || !data) {
      console.warn('og-match: match not found', matchId, error?.message);
      return new Response(generateFallbackHTML(), {
        headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const target = (data as any).match_targets;
    const match: MatchData = {
      id: data.id,
      match_type: data.match_type,
      score: data.score,
      target_display_name: target?.display_name || 'Match',
      shared_topics: (target?.topic_keys || []).slice(0, 5),
    };

    const canonicalUrl = `https://e.vitanaland.com/matches/${match.id}`;
    const destinationUrl = `https://vitanaland.com/discover?m=${match.id}`;

    if (isCrawler(userAgent)) {
      return new Response(generateOGHTML(match, canonicalUrl, destinationUrl), {
        headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    return new Response(null, {
      status: 302,
      headers: { ...corsHeaders, 'Location': destinationUrl },
    });
  } catch (error) {
    console.error('og-match error:', error);
    return new Response(generateFallbackHTML(), {
      headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
});
