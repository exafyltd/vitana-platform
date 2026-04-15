/**
 * VTID-01900: Longevity News Feed — Background RSS Fetcher
 *
 * Pulls from 15 curated alternative longevity sources every 12 hours.
 * Auto-tags articles by keyword matching, deduplicates via SHA-256 hash.
 * Extracts featured images from RSS enclosures, media:content, and HTML.
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

interface FeedSource { name: string; url: string; }

const FEEDS: FeedSource[] = [
  { name: 'Fight Aging!', url: 'https://www.fightaging.org/feed/' },
  { name: 'Lifespan.io', url: 'https://www.lifespan.io/feed/' },
  { name: 'Longevity.Technology', url: 'https://longevity.technology/feed/' },
  { name: 'Novos Labs', url: 'https://novoslabs.com/feed/' },
  { name: 'Buck Institute', url: 'https://www.buckinstitute.org/feed/' },
  { name: 'Long Long Life', url: 'https://www.longlonglife.org/en/feed/' },
  { name: 'NAD.com', url: 'https://nad.com/feed/' },
  { name: 'Gowing Life', url: 'https://gowinglife.com/feed/' },
  { name: 'Unconventional Medicine', url: 'https://unconventionalmedicine.net/feed/' },
  { name: 'Genetic Lifehacks', url: 'https://www.geneticlifehacks.com/feed/' },
  { name: 'Peter Attia', url: 'https://peterattia.com/feed/' },
  { name: 'NMN.com', url: 'https://nmn.com/feed/' },
  { name: 'Rapamycin News', url: 'https://rapamycin.news/feed/' },
  { name: 'Longevity Advice', url: 'https://longevityadvice.com/feed/' },
  { name: 'Mitosynergy', url: 'https://mitosynergy.com/feed/' },
];

const TAG_KEYWORDS: Record<string, string[]> = {
  supplements: ['nmn', 'nad', 'resveratrol', 'rapamycin', 'fisetin', 'quercetin', 'spermidine', 'berberine', 'metformin'],
  functional: ['mitochondria', 'autophagy', 'sirtuins', 'senolytic', 'telomere'],
  natural: ['polyphenol', 'flavonoid', 'curcumin', 'egcg'],
  mental_health: ['mental health', 'anxiety', 'depression', 'stress', 'mindfulness', 'meditation', 'cognitive', 'brain health', 'neuroplasticity', 'dementia', 'alzheimer', 'mood', 'psycholog', 'wellbeing', 'well-being', 'therapy'],
  general: ['sleep', 'exercise', 'nutrition', 'hydration', 'metabolic', 'prevention', 'fasting', 'longevity', 'aging', 'healthspan', 'lifespan'],
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

/** Extract the best image URL from an RSS item. */
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
  fetched_at: string; tags: string[]; content_hash: string;
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
        fetched_at: string; tags: string[]; content_hash: string;
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
          content_hash: contentHash(item.title, item.link),
        });
      }

      if (batchItems.length > 0) { totalInserted += await supabaseInsert(batchItems); }
      feedsProcessed++;
      console.log(`${LOG_PREFIX} ✓ ${feed.name}: ${batchItems.length} items processed`);
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
  console.log(`${LOG_PREFIX} Cycle complete: ${feedsProcessed}/${FEEDS.length} feeds, ${totalInserted} items processed, ${feedsFailed} failed, ${duration}ms`);
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
  console.log(`📰 Longevity news fetcher started (${FEEDS.length} feeds, interval=${intervalMs}ms, initial delay=${INITIAL_DELAY_MS}ms)`);
}

export function stopNewsFetcher(): void {
  if (fetcherTimer) { clearInterval(fetcherTimer); fetcherTimer = null; }
  running = false;
  console.log(`${LOG_PREFIX} Stopped`);
}

export { runFetchCycle };
