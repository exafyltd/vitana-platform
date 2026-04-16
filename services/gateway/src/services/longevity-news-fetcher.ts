/**
 * VTID-01900: Longevity News Feed — Background RSS Fetcher
 *
 * Pulls from curated longevity + wellness sources every 12 hours.
 * Supports multiple languages (en, de, extensible).
 *
 * Image extraction pipeline (per article):
 *   1. Try RSS enclosure/media:content/media:thumbnail
 *   2. Try first <img> in RSS content HTML
 *   3. Scrape og:image / twitter:image from article URL (HTML head)
 *   4. Leave null (frontend falls back to category pool)
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
const OG_SCRAPE_TIMEOUT_MS = 6_000;
const OG_SCRAPE_CONCURRENCY = 5;

let fetcherTimer: NodeJS.Timeout | null = null;
let running = false;
let cycleInFlight = false;

interface FeedSource { name: string; url: string; language: string; }

const FEEDS: FeedSource[] = [
  // ── English (15) ──
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
  // ── German consumer wellness (13) — no medical/pharmacy trade press ──
  { name: 'Zentrum der Gesundheit', url: 'https://www.zentrum-der-gesundheit.de/rss', language: 'de' },
  { name: 'Heilpraxis', url: 'https://www.heilpraxisnet.de/feed/', language: 'de' },
  { name: 'Spiegel Gesundheit', url: 'https://www.spiegel.de/gesundheit/index.rss', language: 'de' },
  { name: "Women's Health DE", url: 'https://www.womenshealth.de/feed/', language: 'de' },
  { name: "Men's Health DE", url: 'https://www.menshealth.de/feed/', language: 'de' },
  { name: 'Verbraucherzentrale Gesundheit', url: 'https://www.verbraucherzentrale.de/wissen/gesundheit-pflege/feed', language: 'de' },
  { name: 'Verbraucherzentrale Lebensmittel', url: 'https://www.verbraucherzentrale.de/wissen/lebensmittel/feed', language: 'de' },
  { name: 'stern Gesundheit', url: 'https://www.stern.de/feed/standard/gesundheit/', language: 'de' },
  { name: 'FIT FOR FUN', url: 'https://www.fitforfun.de/fff/XML/rss_fffnews_sport.xml', language: 'de' },
  { name: 'EAT SMARTER', url: 'https://eatsmarter.de/index.php?type=100', language: 'de' },
  { name: 'DGE Ernährungsgesellschaft', url: 'https://www.dge.de/rss-feed/', language: 'de' },
  { name: 'Lifeline Gesundheit', url: 'https://www.lifeline.de/rss', language: 'de' },
  { name: 'Brigitte Gesundheit', url: 'https://www.brigitte.de/feed.rss', language: 'de' },
];

const TAG_KEYWORDS: Record<string, string[]> = {
  supplements: ['nmn', 'nad', 'resveratrol', 'rapamycin', 'fisetin', 'quercetin', 'spermidine', 'berberine', 'metformin', 'nahrungsergänzung', 'supplement', 'vitamin'],
  functional: ['mitochondria', 'autophagy', 'sirtuins', 'senolytic', 'telomere', 'mitochondrien', 'autophagie', 'zellalterung'],
  natural: ['polyphenol', 'flavonoid', 'curcumin', 'egcg', 'heilpflanze', 'naturheilkunde', 'phytotherapie', 'heilpraxis'],
  mental_health: ['mental health', 'anxiety', 'depression', 'stress', 'mindfulness', 'meditation', 'cognitive', 'brain health', 'neuroplasticity', 'dementia', 'alzheimer', 'mood', 'psycholog', 'wellbeing', 'well-being', 'therapy', 'psyche', 'burnout', 'achtsamkeit', 'demenz'],
  general: ['sleep', 'exercise', 'nutrition', 'hydration', 'metabolic', 'prevention', 'fasting', 'longevity', 'aging', 'healthspan', 'lifespan', 'schlaf', 'ernährung', 'bewegung', 'prävention', 'langlebigkeit', 'altern', 'gesundheit', 'fasten', 'fitness', 'training'],
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

function extractImageFromRss(item: any): string | null {
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

async function scrapeOgImage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OG_SCRAPE_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VitanaNewsFetcher/1.0; +https://vitana.dev)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const reader = response.body?.getReader();
    if (!reader) {
      const html = await response.text();
      return extractOgFromHtml(html, url);
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    let totalBytes = 0;
    const maxBytes = 256 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      html += decoder.decode(value, { stream: true });
      if (html.includes('</head>') || totalBytes >= maxBytes) break;
    }
    reader.cancel().catch(() => {});
    return extractOgFromHtml(html, url);
  } catch {
    return null;
  }
}

function extractOgFromHtml(html: string, pageUrl: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+property=["']og:image:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      let src = match[1].trim();
      src = src.replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/&#47;/g, '/');
      if (src.startsWith('//')) src = 'https:' + src;
      else if (src.startsWith('/')) {
        try {
          const u = new URL(pageUrl);
          src = `${u.protocol}//${u.host}${src}`;
        } catch {}
      } else if (!src.startsWith('http')) {
        try {
          src = new URL(src, pageUrl).toString();
        } catch {}
      }
      return src;
    }
  }
  return null;
}

async function batchScrapeImages(
  items: Array<{ link: string; imageUrl: string | null }>,
  concurrency: number
): Promise<void> {
  let index = 0;
  const workers: Promise<void>[] = [];
  async function worker() {
    while (index < items.length) {
      const i = index++;
      const item = items[i];
      if (!item.imageUrl && item.link) {
        const scraped = await scrapeOgImage(item.link);
        if (scraped) item.imageUrl = scraped;
      }
    }
  }
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
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
  let totalInserted = 0, feedsProcessed = 0, feedsFailed = 0, totalScraped = 0;
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
      let rssData;
      try { rssData = await parser.parseURL(feed.url); } catch (e) { throw e; }

      const items = (rssData.items || []).slice(0, 20);
      const preItems = items
        .filter((item: any) => item.title && item.link)
        .map((item: any) => {
          const summary = item.contentSnippet || item.content || item.summary || null;
          const cleanSummary = summary ? summary.replace(/<[^>]+>/g, '').substring(0, 500) : null;
          const publishedAt = item.isoDate || item.pubDate ? new Date(item.isoDate || item.pubDate!).toISOString() : now;
          return {
            title: item.title,
            link: item.link,
            summary: cleanSummary,
            imageUrl: extractImageFromRss(item),
            published_at: publishedAt,
          };
        });

      const beforeScrape = preItems.filter((p: any) => p.imageUrl).length;
      await batchScrapeImages(preItems, OG_SCRAPE_CONCURRENCY);
      const afterScrape = preItems.filter((p: any) => p.imageUrl).length;
      const scrapedThisFeed = afterScrape - beforeScrape;
      totalScraped += scrapedThisFeed;

      const batchItems = preItems.map((p: any) => ({
        source_name: feed.name,
        source_url: feed.url,
        title: p.title,
        link: p.link,
        summary: p.summary,
        image_url: p.imageUrl,
        published_at: p.published_at,
        fetched_at: now,
        tags: autoTag(p.title, p.summary || undefined),
        content_hash: contentHash(p.title, p.link),
        language: feed.language,
      }));

      if (batchItems.length > 0) { totalInserted += await supabaseInsert(batchItems); }
      feedsProcessed++;
      console.log(`${LOG_PREFIX} ✓ ${feed.name} [${feed.language}]: ${batchItems.length} items (${scrapedThisFeed} og:image scraped)`);
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
  console.log(`${LOG_PREFIX} Cycle complete: ${feedsProcessed}/${FEEDS.length} feeds, ${totalInserted} items, ${totalScraped} og:image scraped, ${feedsFailed} failed, ${duration}ms`);
  try {
    await emitOasisEvent({ type: 'news.feed.cycle_complete', source: 'longevity-news-fetcher', vtid: VTID, status: feedsFailed === 0 ? 'success' : 'warning', message: `News fetch cycle: ${feedsProcessed} feeds, ${totalInserted} items, ${totalScraped} scraped`, payload: { feeds_processed: feedsProcessed, feeds_failed: feedsFailed, items_processed: totalInserted, images_scraped: totalScraped, duration_ms: duration } });
  } catch {}
}

export function startNewsFetcher(): void {
  if (running) { console.log(`${LOG_PREFIX} Already running`); return; }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) { console.warn(`${LOG_PREFIX} Supabase credentials missing, fetcher not started`); return; }
  const intervalMs = parseInt(process.env.LONGEVITY_NEWS_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
  running = true;
  setTimeout(() => void runFetchCycle(), INITIAL_DELAY_MS);
  fetcherTimer = setInterval(() => void runFetchCycle(), intervalMs);
  console.log(`📰 Longevity news fetcher started (${FEEDS.length} feeds, interval=${intervalMs}ms, og:image scraping enabled)`);
}

export function stopNewsFetcher(): void {
  if (fetcherTimer) { clearInterval(fetcherTimer); fetcherTimer = null; }
  running = false;
  console.log(`${LOG_PREFIX} Stopped`);
}

export { runFetchCycle };
