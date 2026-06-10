import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { disabledModulePayload, getModuleState } from '@/lib/module-registry';

/**
 * OSIRIS — Military-Grade Intelligence API
 * Fetches public RSS/official intelligence feeds by default.
 * Telegram web scraping is disabled unless explicitly enabled by config.
 */

const TELEGRAM_CHANNELS = (process.env.OSIRIS_TELEGRAM_CHANNELS || '')
  .split(',')
  .map(channel => channel.trim())
  .filter(Boolean);
const ENABLE_TELEGRAM_SCRAPE = process.env.OSIRIS_ENABLE_TELEGRAM_SCRAPE === 'true';

const FALLBACK_FEEDS = {
  BBC: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  AlJazeera: 'https://www.aljazeera.com/xml/rss/all.xml',
  GDACS: 'https://www.gdacs.org/xml/rss.xml'
};

const RISK_KEYWORDS = ['war','missile','strike','attack','crisis','tension','military','conflict','defense','clash','nuclear','invasion','bomb','drone','weapon','sanctions','ceasefire','escalation', 'killed', 'destroyed', 'operation', 'casualty', 'frontline', 'threat'];

const KEYWORD_COORDS: Record<string, [number, number]> = {
  'ukraine': [49.487, 31.272], 'kyiv': [50.450, 30.523], 'russia': [61.524, 105.318],
  'moscow': [55.755, 37.617], 'israel': [31.046, 34.851], 'gaza': [31.416, 34.333],
  'iran': [32.427, 53.688], 'lebanon': [33.854, 35.862], 'syria': [34.802, 38.996],
  'yemen': [15.552, 48.516], 'china': [35.861, 104.195], 'taiwan': [23.697, 120.960],
  'united states': [38.907, -77.036], 'europe': [48.800, 2.300], 'middle east': [31.500, 34.800]
};

type NewsArticle = {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  source: string;
};

function scoreRisk(text: string): number {
  const lower = text.toLowerCase();
  let score = 1;
  for (const kw of RISK_KEYWORDS) {
    if (lower.includes(kw)) score += 2;
  }
  return Math.min(10, score);
}

function findCoords(text: string): [number, number] | null {
  const lower = text.toLowerCase();
  for (const [keyword, coords] of Object.entries(KEYWORD_COORDS)) {
    if (lower.includes(keyword)) return coords;
  }
  return null;
}

function parseTelegramHTML(html: string, channel: string): NewsArticle[] {
  const items: NewsArticle[] = [];
  const messageBlockRegex = /<div class="tgme_widget_message_wrap js-widget_message_wrap"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;
  let blockMatch;

  while ((blockMatch = messageBlockRegex.exec(html)) !== null) {
    const blockHtml = blockMatch[0];
    const textRegex = /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i;
    const textMatch = blockHtml.match(textRegex);
    if (!textMatch) continue;
    
    const text = textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    if (!text || text.length < 10) continue;

    const dateRegex = /<a class="tgme_widget_message_date" href="(https:\/\/t\.me\/[^"]+)".*?<time datetime="([^"]+)"/i;
    const dateMatch = blockHtml.match(dateRegex);
    const link = dateMatch ? dateMatch[1] : `https://t.me/${channel}`;
    const pubDate = dateMatch ? dateMatch[2] : new Date().toISOString();

    const title = text.split('\n')[0].substring(0, 100);

    items.push({ title, description: text, link, pubDate, source: `t.me/${channel}` });
  }
  return items;
}

function parseRSSItems(xml: string, sourceName: string): NewsArticle[] {
  const items: NewsArticle[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag: string) => {
      const m = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return (m?.[1] || m?.[2] || '').trim();
    };

    const title = getTag('title').replace(/<[^>]+>/g, '');
    const desc = getTag('description').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    
    items.push({
      title: title.length > 100 ? title.substring(0, 100) + '...' : title,
      description: desc,
      link: getTag('link'),
      pubDate: getTag('pubDate') || new Date().toISOString(),
      source: sourceName
    });
  }
  return items;
}

export async function GET() {
  const moduleState = await getModuleState('news');
  if (moduleState && !moduleState.enabled) {
    return NextResponse.json(await disabledModulePayload('news', {
      news: [],
      total: 0,
      providers: {
        rss: [],
        telegram_scrape_enabled: false,
        telegram_channels: [],
      },
    }), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  try {
    const allArticles: NewsArticle[] = [];

    const rssPromises = Object.entries(FALLBACK_FEEDS).map(async ([source, url]) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRSSItems(xml, source).slice(0, 8);
      } catch { return []; }
    });

    const rssResults = await Promise.allSettled(rssPromises);
    for (const result of rssResults) {
      if (result.status === 'fulfilled') allArticles.push(...result.value);
    }

    if (ENABLE_TELEGRAM_SCRAPE && TELEGRAM_CHANNELS.length > 0) {
      const telegramPromises = TELEGRAM_CHANNELS.map(async (channel) => {
        try {
          const res = await fetch(`https://t.me/s/${channel}`, {
            signal: AbortSignal.timeout(8000),
            headers: { 'User-Agent': 'OSIRIS-News-Monitor/1.0' }
          });
          if (!res.ok) return [];
          const html = await res.text();
          return parseTelegramHTML(html, channel).slice(-8);
        } catch { return []; }
      });

      const telegramResults = await Promise.allSettled(telegramPromises);
      for (const result of telegramResults) {
        if (result.status === 'fulfilled') allArticles.push(...result.value);
      }
    }

    const newsItems = allArticles.map(article => {
      const riskScore = scoreRisk(article.description || article.title);
      const coords = findCoords(article.description || article.title);

      return {
        id: crypto.createHash('md5').update((article.link || '') + (article.pubDate || '')).digest('hex'),
        title: article.title,
        description: article.description,
        link: article.link,
        published: article.pubDate,
        source: article.source,
        risk_score: riskScore,
        coords: coords ? [coords[0], coords[1]] : null,
        coords_default: !coords,
        machine_assessment: riskScore >= 8 ? "AI Analysis indicates elevated tactical priority based on OSINT stream patterns." : null,
      };
    });

    newsItems.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

    return NextResponse.json({
      news: newsItems,
      total: newsItems.length,
      providers: {
        rss: Object.keys(FALLBACK_FEEDS),
        telegram_scrape_enabled: ENABLE_TELEGRAM_SCRAPE,
        telegram_channels: ENABLE_TELEGRAM_SCRAPE ? TELEGRAM_CHANNELS : [],
      },
      timestamp: new Date().toISOString(),
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch {
    return NextResponse.json({ news: [], error: 'Failed to fetch intel' }, { status: 500 });
  }
}
