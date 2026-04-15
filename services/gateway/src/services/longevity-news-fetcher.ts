/**
 * VTID-01900: Longevity News Feed — Background RSS Fetcher
 *
 * Pulls from curated longevity sources every 12 hours.
 * Supports multiple languages (en, de, extensible).
 * Auto-tags, deduplicates via SHA-256, extracts featured images.
 */

import { createHash } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const LOG_PREFIX = '[longevity-news-fetcher]';
const VTID = 'VTID-01900';

const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;
const FEED_TIMEOUT_MS = 10_000;

let fetcherTimer: NodeJS.Timeout | null = null;
let running = false;
let cycleInFlight = false;

interface FeedSource { name: string; url: string; language: string; }

const FEEDS: FeedSource[] = [
  // ── English feeds ──
  { name: 'Fight Aging!', url: 'https://www.fightaging.org/feed/', language: 'en' },
  { name: 'Lifespan.io', url: 'https://www.lifespan.io/feed/', language: 'en' },
  { name: 'Longevity.Technology', url: 'https://longevity.technology/feed/', language: 'en' },
  { name: 'Novos Labs', url: 'https://novoslabs.com/feed/', language: 'en' },
  { name: 'Buck Institute', url: 'https://www.buckinstitute.org/feed/', language: 'en' },
  { name: 'Long Long Life', url: 'https://www.longlonglife.org/en/feed/', language: 'en' },
  { name: 'NAD.com', url: 'https://nad.com/feed/', language: 'en' },
  { name: 'Gowing Life', url: 'https://gowinglife.com/feed/', language: 'en' },
  { name: 'Unconventional Medicine', url: 'https://unconventionalmedicine.net/feed/', language: 'en' },
  { name: 'Genetic Lifehacks', url: 'https://www.geneticlifehacks.com/feed/', language: 'en' },
  { name: 'Peter Attia', url: 'https://peterattia.com/feed/', language: 'en' },
  { name: 'NMN.com', url: 'https://nmn.com/feed/', language: 'en' },
  { name: 'Rapamycin News', url: 'https://rapamycin.news/feed/', language: 'en' },
  { name: 'Longevity Advice', url: 'https://longevityadvice.com/feed/', language: 'en' },
  { name: 'Mitosynergy', url: 'https://mitosynergy.com/feed/', language: 'en' },
  // ── German feeds ──
  { name: 'Deutsches Ärzteblatt', url: 'https://www.aerzteblatt.de/rss/news.asp', language: 'de' },
  { name: 'Ärzte Zeitung', url: 'https://www.aerztezeitung.de/extras/rss/', language: 'de' },
  { name: 'Pharmazeutische Zeitung', url: 'https://www.pharmazeutische-zeitung.de/fileadmin/rss/pz_online_rss.php', language: 'de' },
  { name: 'Zentrum der Gesundheit', url: 'https://www.zentrum-der-gesundheit.de/rss', language: 'de' },
  { name: 'Heilpraxis', url: 'https://www.heilpraxisnet.de/feed/', language: 'de' },
  { name: 'Lifeline Gesundheit', url: 'https://www.lifeline.de/rss', language: 'de' },
  { name: 'Spiegel Gesundheit', url: 'https://www.spiegel.de/gesundheit/index.rss', language: 'de' },
  { name: 'NDR Ratgeber Gesundheit', url: 'https://www.ndr.de/ratgeber/gesundheit/index-rss.xml', language: 'de' },
  { name: 'Quarks', url: 'https://www.quarks.de/feed/', language: 'de' },
  { name: 'Scinexx', url: 'https://feeds.feedburner.com/scinexx', language: 'de' },
  { name: 'Apotheken Umschau', url: 'https://www.apotheken-umschau.de/feed/', language: 'de' },
  { name: 'Focus Gesundheit', url: 'https://www.focus.de/gesundheit/rss', language: 'de' },
  { name: 'Apotheke Adhoc', url: 'https://www.apotheke-adhoc.de/nachrichten/apothekenpraxis/rss.xml', language: 'de' },
];

const TAG_KEYWORDS: Record<string, string[]> = {
  supplements: ['nmn', 'nad', 'resveratrol', 'rapamycin', 'fisetin', 'quercetin', 'spermidine', 'berberine', 'metformin', 'nahrungsergänzung', 'supplement'],
  functional: ['mitochondria', 'autophagy', 'sirtuins', 'senolytic', 'telomere', 'mitochondrien', 'autophagie', 'zellalterung'],
  natural: ['polyphenol', 'flavonoid', 'curcumin', 'egcg', 'heilpflanze', 'naturheilkunde', 'phytotherapie'],
  mental_health: ['mental health', 'anxiety', 'depression', 'stress', 'mindfulness', 'meditation', 'cognitive', 'brain health', 'neuroplasticity', 'dementia', 'alzheimer', 'mood', 'psycholog', 'wellbeing', 'well-being', 'therapy', 'psyche', 'burnout', 'achtsamkeit', 'demenz'],
  general: ['sleep', 'exercise', 'nutrition', 'hydration', 'metabolic', 'prevention', 'fasting', 'longevity', 'aging', 'healthspan', 'lifespan', 'schlaf', 'ernährung', 'bewegung', 'prävention', 'langlebigkeit', 'altern', 'gesundheit', 'fasten'],
};

function autoTag(title: string, summary: string | undefined): string[] {
  const text = `${title} ${summary || ''}`.toLowerCase();
  const tags: string[] = [];
  for (const [group, keywords] of Object.entries(TAG_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) { if (!tags.includes(group)) tags.push(group); break; }
    }
  }
  return tags.length > 0 ? tags : ['general'];
}

function contentHash(title: string, link: string): string {
  return createHash('sha256').update(`${title}${link}`).digest('hex');
}

function extractImageUrl(item: any): string | null {
  if (item.enclosure?.url) return item.enclosure.url;
  if (item['media:content']?.$?.url) return item['media:content'].$.url;
  if (item['media:thumbnail']?.$?.url) return item['media:thumbnail'].$.url;
  if (item['itunes:image']?.$?.href) return item['itunes:image'].$.href;
  const htmlContent = item.content || item['content:encoded'] || item.description || '';
  if (htmlContent) {
    const imgMatch = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch?.[1]) {
      const src = imgMatch[1];
      if (!src.includes('gravatar') && !src.includes('1x1') && !src.includes('pixel')) return src;
    }
  }
  return null;
}

async function supabaseInsert(items: Array<{
  source_name: string; source_url: string; title: string; link: string;
  summary: string | null; image_url: string | null; published_at: string;
  fetched_at: string; tags: string[]; content_hash: string; language: string;
}>): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || items.length === 0) return 0;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/news_items`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Prefer': 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(items),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase insert failed: ${response.status} ${errText}`);
  }
  return items.length;
}

async function runFetchCycle(): Promise<void> {
  if (cycleInFlight) { console.log(`${LOG_PREFIX} Cycle already in flight, skipping`); return; }
  cycleInFlight = true;
  const cycleStart = Date.now();
  let totalInserted = 0, feedsProcessed = 0, feedsFailed = 0;
  console.log(`${LOG_PREFIX} Starting fetch cycle for ${FEEDS.length} feeds...`);

  const Parser = (await import('rss-parser')).default;
  const parser = new Parser({
    timeout: FEED_TIMEOUT_MS,
    headers: { 'User-Agent': 'VitanaNewsFetcher/1.0 (+https://vitana.dev)' },
    customFields: { item: [['media:content', 'media:content'], ['media:thumbnail', 'media:thumbnail'], ['content:encoded', 'content:encoded']] },
  });
  const now = new Date().toISOString();

  for (const feed of FEEDS) {
    try {
      const timeoutId = setTimeout(() => {}, FEED_TIMEOUT_MS);
      let rssData;
      try { rssData = await parser.parseURL(feed.url); } finally { clearTimeout(timeoutId); }

      const items = (rssData.items || []).slice(0, 20);
      const batchItems: Array<{
        source_name: string; source_url: string; title: string; link: string;
        summary: string | null; image_url: string | null; published_at: string;
        fetched_at: string; tags: string[]; content_hash: string; language: string;
      }> = [];

      for (const item of items) {
        if (!item.title || !item.link) continue;
        const summary = item.contentSnippet || item.content || item.summary || null;
        const cleanSummary = summary ? summary.replace(/<[^>]+>/g, '').substring(0, 500) : null;
        const publishedAt = item.isoDate || item.pubDate ? new Date(item.isoDate || item.pubDate!).toISOString() : now;
        batchItems.push({
          source_name: feed.name, source_url: feed.url, title: item.title, link: item.link,
          summary: cleanSummary, image_url: extractImageUrl(item), published_at: publishedAt,
          fetched_at: now, tags: autoTag(item.title, cleanSummary || undefined),
          content_hash: contentHash(item.title, item.link), language: feed.language,
        });
      }

      if (batchItems.length > 0) { totalInserted += await supabaseInsert(batchItems); }
      feedsProcessed++;
      console.log(`${LOG_PREFIX} ✓ ${feed.name} [${feed.language}]: ${batchItems.length} items`);
    } catch (error: any) {
      feedsFailed++;
      console.error(`${LOG_PREFIX} ✗ ${feed.name}: ${error.message}`);
      try {
        await emitOasisEvent({ type: 'news.feed.error', source: 'longevity-news-fetcher', vtid: VTID, status: 'warning', message: `Feed fetch failed: ${feed.name}`, payload: { feed_name: feed.name, feed_url: feed.url, error: error.message } });
      } catch {}
    }
  }

  cycleInFlight = false;
  const duration = Date.now() - cycleStart;
  console.log(`${LOG_PREFIX} Cycle complete: ${feedsProcessed}/${FEEDS.length} feeds, ${totalInserted} items, ${feedsFailed} failed, ${duration}ms`);
  try {
    await emitOasisEvent({ type: 'news.feed.cycle_complete', source: 'longevity-news-fetcher', vtid: VTID, status: feedsFailed === 0 ? 'success' : 'warning', message: `News fetch cycle: ${feedsProcessed} feeds, ${totalInserted} items`, payload: { feeds_processed: feedsProcessed, feeds_failed: feedsFailed, items_processed: totalInserted, duration_ms: duration } });
  } catch {}
}

export function startNewsFetcher(): void {
  if (running) { console.log(`${LOG_PREFIX} Already running`); return; }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) { console.warn(`${LOG_PREFIX} Supabase credentials missing, fetcher not started`); return; }
  const intervalMs = parseInt(process.env.LONGEVITY_NEWS_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
  running = true;
  setTimeout(() => void runFetchCycle(), INITIAL_DELAY_MS);
  fetcherTimer = setInterval(() => void runFetchCycle(), intervalMs);
  console.log(`📰 Longevity news fetcher started (${FEEDS.length} feeds, interval=${intervalMs}ms)`);
}

export function stopNewsFetcher(): void {
  if (fetcherTimer) { clearInterval(fetcherTimer); fetcherTimer = null; }
  running = false;
  console.log(`${LOG_PREFIX} Stopped`);
}

export { runFetchCycle };
