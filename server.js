const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const compression = require("compression");

const app = express();
const PORT = 3000;

app.use(compression());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));
app.use(express.json());

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ========== In-Memory LRU Cache ========== */
const CACHE_TTL_SEARCH = 5 * 60 * 1000;   // 5 min
const CACHE_TTL_WIKI   = 30 * 60 * 1000;  // 30 min
const MAX_CACHE = 200;

const searchCache = new Map();
const wikiCache   = new Map();

function cacheGet(map, key, ttl) {
  const entry = map.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  if (entry) map.delete(key);
  return null;
}

function cacheSet(map, key, data, max) {
  if (map.size >= max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, { data, ts: Date.now() });
}

/* ========== Request Deduplication ========== */
const inflight = new Map();

function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ========== HTTP Agent (keep-alive) ========== */
const httpAgent = (() => {
  try {
    const https = require("https");
    return new https.Agent({ keepAlive: true, maxSockets: 20 });
  } catch { return undefined; }
})();

const axOpts = { timeout: 6000, headers: { "User-Agent": UA }, httpsAgent: httpAgent };

/* ========== Search Functions ========== */
async function searchGoogleNews(query) {
  try {
    const { data } = await axios.get(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
      axOpts
    );
    const $ = cheerio.load(data, { xmlMode: true });
    const results = [];
    $("item").each((_, el) => {
      const title = $(el).find("title").text().trim();
      const sourceEl = $(el).find("source");
      const sourceName = sourceEl.text().trim() || "";
      const realLink = sourceEl.attr("url") || $(el).find("link").text().trim();
      if (title && realLink) {
        results.push({ title, link: realLink, snippet: sourceName ? "Source: " + sourceName : "" });
      }
    });
    return results;
  } catch (err) {
    console.error("Google News error:", err.message);
    return [];
  }
}

async function searchDDGInstant(query) {
  try {
    const { data } = await axios.get(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { timeout: 4000 }
    );
    const results = [];
    if (data.Abstract) {
      results.push({
        title: data.Heading || query,
        snippet: data.Abstract,
        link: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      });
    }
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      data.RelatedTopics.slice(0, 5).forEach((topic) => {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.substring(0, 80),
            snippet: topic.Text,
            link: topic.FirstURL,
          });
        }
      });
    }
    return results;
  } catch {
    return [];
  }
}

async function searchWeb(query) {
  const cacheKey = query.toLowerCase();
  const cached = cacheGet(searchCache, cacheKey, CACHE_TTL_SEARCH);
  if (cached) return cached;

  const results = await dedupe("search:" + cacheKey, async () => {
    const [newsResults, ddgResults] = await Promise.all([
      searchGoogleNews(query),
      searchDDGInstant(query),
    ]);
    const seen = new Set();
    const merged = [];
    for (const r of [...ddgResults, ...newsResults]) {
      const key = r.link.replace(/\/$/, "").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    }
    return merged;
  });

  cacheSet(searchCache, cacheKey, results, MAX_CACHE);
  return results;
}

async function searchWikipedia(query) {
  const cacheKey = query.toLowerCase();
  const cached = cacheGet(wikiCache, cacheKey, CACHE_TTL_WIKI);
  if (cached) return cached;

  const data = await dedupe("wiki:" + cacheKey, async () => {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
      const { data } = await axios.get(url, {
        timeout: 4000,
        headers: { "User-Agent": "Ikaros/1.0 (search-engine; https://github.com/nexussearch)" },
      });
      return {
        title: data.title,
        extract: data.extract,
        thumbnail: data.thumbnail?.source || null,
        content_urls: data.content_urls?.desktop?.page || null,
      };
    } catch {
      return null;
    }
  });

  cacheSet(wikiCache, cacheKey, data, MAX_CACHE);
  return data;
}

/* ========== Image Search (Openverse API) ========== */
const CACHE_TTL_IMAGES = 10 * 60 * 1000;
const imageCache = new Map();

async function searchImages(query) {
  const cacheKey = query.toLowerCase();
  const cached = cacheGet(imageCache, cacheKey, CACHE_TTL_IMAGES);
  if (cached) return cached;

  const results = await dedupe("img:" + cacheKey, async () => {
    try {
      const { data } = await axios.get(
        `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&per_page=30`,
        { timeout: 8000, headers: { "User-Agent": "Ikaros/1.0 (search-engine)" } }
      );
      return (data.results || []).map((item) => ({
        thumb: item.thumbnail || item.url,
        full: item.url,
        title: item.title || "",
        source: item.creator || item.provider || "",
        width: item.width || 0,
        height: item.height || 0,
      }));
    } catch (err) {
      console.error("Image search error:", err.message);
      return [];
    }
  });

  cacheSet(imageCache, cacheKey, results, MAX_CACHE);
  return results;
}

/* ========== Routes ========== */
app.get("/api/search", async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q || !q.trim()) return res.json({ results: [], query: "", total: 0 });

  const results = await searchWeb(q.trim());
  const perPage = 10;
  const start = (page - 1) * perPage;
  const paged = results.slice(start, start + perPage);

  res.json({
    results: paged,
    query: q.trim(),
    total: results.length,
    page: Number(page),
    totalPages: Math.ceil(results.length / perPage),
  });
});

app.get("/api/images", async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json({ results: [], query: "" });
  const images = await searchImages(q.trim());
  res.json({ results: images, query: q.trim(), total: images.length });
});

app.get("/api/wiki", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json(null);
  const summary = await searchWikipedia(q.trim());
  res.json(summary);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Search engine running at http://localhost:${PORT}`);
});
