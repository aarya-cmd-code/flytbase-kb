import 'dotenv/config';

// IMPORTANT: per the Problem #2 spec, docs.flytbase.com / releases.flytbase.com
// must be queried LIVE at question time — never pre-scraped or embedded once.
// Nothing fetched here is written to Supabase; it only lives in-memory for the
// duration of a single request. The sitemap URL LIST (not content) is cached
// briefly in-process purely to avoid re-fetching the sitemap on every keystroke.

const SITES = [
  { base: 'https://docs.flytbase.com', sitemap: 'https://docs.flytbase.com/sitemap.xml' },
  { base: 'https://releases.flytbase.com', sitemap: 'https://releases.flytbase.com/sitemap.xml' }
];

const SEARCH_API_KEY = process.env.SEARCH_API_KEY;
const SEARCH_API_URL = process.env.SEARCH_API_URL; // e.g. a Serper/Bing endpoint

let sitemapCache = { urls: [], fetchedAt: 0 };
const SITEMAP_TTL_MS = 5 * 60 * 1000; // only the URL list is cached, not page content

async function getSitemapUrls() {
  if (Date.now() - sitemapCache.fetchedAt < SITEMAP_TTL_MS && sitemapCache.urls.length) {
    return sitemapCache.urls;
  }
  const urls = [];
  for (const site of SITES) {
    try {
      const res = await fetch(site.sitemap, { headers: { 'User-Agent': 'flytbase-hackathon-kb-agent' } });
      if (!res.ok) continue;
      const xml = await res.text();
      const matches = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
      urls.push(...matches);
    } catch (e) {
      console.warn(`[docs_fetch] sitemap fetch failed for ${site.base}:`, e.message);
    }
  }
  sitemapCache = { urls, fetchedAt: Date.now() };
  return urls;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordScore(url, question) {
  const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const slug = url.toLowerCase();
  return words.reduce((score, w) => (slug.includes(w) ? score + 1 : score), 0);
}

/**
 * Live search over docs.flytbase.com + releases.flytbase.com.
 * If SEARCH_API_URL/SEARCH_API_KEY are configured, use that (better relevance,
 * e.g. Serper.dev's Google-restricted-to-site search). Otherwise fall back to
 * a sitemap + keyword-overlap heuristic, then fetch and extract the live page.
 */
export async function fetchLiveDocs(question, maxPages = 3) {
  let candidateUrls = [];

  if (SEARCH_API_URL && SEARCH_API_KEY) {
    try {
      const res = await fetch(SEARCH_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SEARCH_API_KEY}` },
        body: JSON.stringify({ q: `site:docs.flytbase.com OR site:releases.flytbase.com ${question}` })
      });
      if (res.ok) {
        const data = await res.json();
        candidateUrls = (data.organic || data.results || [])
          .map((r) => r.link || r.url)
          .filter(Boolean)
          .slice(0, maxPages);
      }
    } catch (e) {
      console.warn('[docs_fetch] search API failed, falling back to sitemap heuristic:', e.message);
    }
  }

  if (candidateUrls.length === 0) {
    const urls = await getSitemapUrls();
    candidateUrls = urls
      .map((u) => ({ u, score: keywordScore(u, question) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPages)
      .map((x) => x.u);
  }

  const pages = await Promise.all(
    candidateUrls.map(async (url) => {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'flytbase-hackathon-kb-agent' } });
        if (!res.ok) return null;
        const html = await res.text();
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const text = stripHtml(html);
        return {
          url,
          title: titleMatch ? titleMatch[1] : url,
          snippet: text.slice(0, 2500),
          fetchedAt: new Date().toISOString()
        };
      } catch (e) {
        return null;
      }
    })
  );

  return pages.filter(Boolean);
}
