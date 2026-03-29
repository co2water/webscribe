const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');
const { URL } = require('url');
const { queryAll, queryGet, runStmt, saveDatabase } = require('./db');

// Create axios instance that handles self-signed / missing CA certs (local tool)
const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

// Generate a simple unique ID
function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
}

class WebScraper {
  constructor(siteId, baseUrl, maxDepth = 2) {
    this.siteId = siteId;
    this.baseUrl = baseUrl;
    this.maxDepth = maxDepth;
    this.visited = new Set();
    this.sessionId = generateSessionId();
    this.pagesScraped = 0;
    this.errors = [];
    this.aborted = false;

    try {
      this.baseDomain = new URL(baseUrl).hostname;
      this.baseOrigin = new URL(baseUrl).origin;
    } catch (e) {
      throw new Error(`Invalid URL: ${baseUrl}`);
    }
  }

  async start() {
    runStmt(
      `INSERT INTO scrape_history (site_id, session_id, status, pages_total) VALUES (?, ?, 'running', 0)`,
      [this.siteId, this.sessionId]
    );

    try {
      await this.scrapeRecursive(this.baseUrl, 0, null);

      runStmt(
        `UPDATE scrape_history SET status = 'completed', pages_scraped = ?, completed_at = datetime('now') WHERE session_id = ?`,
        [this.pagesScraped, this.sessionId]
      );

      runStmt(
        `UPDATE sites SET last_scraped_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        [this.siteId]
      );

      return {
        sessionId: this.sessionId,
        pagesScraped: this.pagesScraped,
        errors: this.errors,
      };
    } catch (err) {
      runStmt(
        `UPDATE scrape_history SET status = 'failed', error_message = ?, pages_scraped = ?, completed_at = datetime('now') WHERE session_id = ?`,
        [err.message, this.pagesScraped, this.sessionId]
      );
      throw err;
    }
  }

  abort() {
    this.aborted = true;
  }

  async scrapeRecursive(url, depth, parentNoteId) {
    if (this.aborted) return;
    if (depth > this.maxDepth) return;

    const normalizedUrl = this.normalizeUrl(url);
    if (!normalizedUrl) return;
    if (this.visited.has(normalizedUrl)) return;

    this.visited.add(normalizedUrl);

    try {
      const response = await httpClient.get(normalizedUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
      });

      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html')) return;

      const $ = cheerio.load(response.data);
      const pageData = this.extractContent($, normalizedUrl);

      const hasChanges = this.detectChanges(normalizedUrl, pageData.contentText);

      const result = runStmt(
        `INSERT INTO notes (site_id, url, title, content_html, content_text, meta_description, meta_keywords, word_count, images_count, links_count, has_changes, parent_note_id, scrape_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.siteId, normalizedUrl, pageData.title, pageData.contentHtml,
          pageData.contentText, pageData.metaDescription, pageData.metaKeywords,
          pageData.wordCount, pageData.imagesCount, pageData.linksCount,
          hasChanges ? 1 : 0, parentNoteId, this.sessionId,
        ]
      );

      this.pagesScraped++;
      const currentNoteId = result.lastInsertRowid;

      runStmt(
        `UPDATE scrape_history SET pages_scraped = ? WHERE session_id = ?`,
        [this.pagesScraped, this.sessionId]
      );

      if (depth < this.maxDepth) {
        const childLinks = this.extractLinks($, normalizedUrl);
        for (const link of childLinks) {
          if (this.aborted) break;
          await this.scrapeRecursive(link, depth + 1, currentNoteId);
          await this.delay(300);
        }
      }
    } catch (err) {
      console.error(`[Scraper] Error scraping ${normalizedUrl}:`, err.message);
      this.errors.push({ url: normalizedUrl, error: err.message });
    }
  }

  extractContent($, url) {
    const $clean = cheerio.load($.html());
    $clean('script, style, noscript, iframe').remove();

    const title = $('title').text().trim() ||
                  $('h1').first().text().trim() ||
                  'Untitled';

    const metaDescription = $('meta[name="description"]').attr('content') || '';
    const metaKeywords = $('meta[name="keywords"]').attr('content') || '';

    let contentHtml = '';
    const mainSelectors = ['main', 'article', '[role="main"]', '.content', '.post', '.entry', '#content', '#main'];

    for (const selector of mainSelectors) {
      const el = $clean(selector).first();
      if (el.length && el.html().trim().length > 100) {
        contentHtml = el.html().trim();
        break;
      }
    }

    if (!contentHtml) {
      $clean('nav, header, footer, aside, .sidebar, .menu, .navigation').remove();
      contentHtml = $clean('body').html() || '';
    }

    contentHtml = this.sanitizeHtml(contentHtml);

    const contentText = $clean('body').text().replace(/\s+/g, ' ').trim();
    const imagesCount = $('img').length;
    const linksCount = $('a[href]').length;
    const wordCount = contentText.split(/\s+/).filter(w => w.length > 0).length;

    return { title, contentHtml, contentText, metaDescription, metaKeywords, imagesCount, linksCount, wordCount };
  }

  sanitizeHtml(html) {
    const $ = cheerio.load(html, null, false);
    $('*').each((_, el) => {
      const attribs = $(el).attr() || {};
      for (const attr of Object.keys(attribs)) {
        if (attr.startsWith('on') || attr === 'srcdoc') {
          $(el).removeAttr(attr);
        }
      }
    });
    $('script').remove();
    return $.html();
  }

  extractLinks($, currentUrl) {
    const links = new Set();
    $('a[href]').each((_, el) => {
      try {
        const href = $(el).attr('href');
        if (!href) return;
        if (href.startsWith('#') || href.startsWith('javascript:') ||
            href.startsWith('mailto:') || href.startsWith('tel:')) return;

        const absoluteUrl = new URL(href, currentUrl).href;
        const parsedUrl = new URL(absoluteUrl);

        if (parsedUrl.hostname !== this.baseDomain) return;

        const ext = parsedUrl.pathname.split('.').pop().toLowerCase();
        const skipExts = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'mp4', 'mp3', 'zip', 'rar', 'exe', 'dmg', 'css', 'js', 'xml', 'json'];
        if (skipExts.includes(ext)) return;

        parsedUrl.hash = '';
        const cleanUrl = parsedUrl.href;

        if (!this.visited.has(cleanUrl)) {
          links.add(cleanUrl);
        }
      } catch (e) { /* skip */ }
    });

    return Array.from(links).slice(0, 50);
  }

  normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      parsed.hash = '';
      return parsed.href;
    } catch (e) {
      return null;
    }
  }

  detectChanges(url, newContentText) {
    const previous = queryGet(
      `SELECT content_text FROM notes WHERE url = ? AND site_id = ? AND scrape_session_id != ? ORDER BY created_at DESC LIMIT 1`,
      [url, this.siteId, this.sessionId]
    );
    if (!previous) return true;
    return previous.content_text !== newContentText;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Track active scrapers
const activeScrapers = new Map();

async function scrapeSite(siteId) {
  const site = queryGet('SELECT * FROM sites WHERE id = ?', [siteId]);
  if (!site) throw new Error('Site not found');
  if (activeScrapers.has(siteId)) throw new Error('This site is already being scraped');

  const scraper = new WebScraper(siteId, site.url, site.max_depth);
  activeScrapers.set(siteId, scraper);

  try {
    const result = await scraper.start();
    return result;
  } finally {
    activeScrapers.delete(siteId);
  }
}

function abortScrape(siteId) {
  const scraper = activeScrapers.get(siteId);
  if (scraper) { scraper.abort(); return true; }
  return false;
}

function isScrapingActive(siteId) {
  return activeScrapers.has(siteId);
}

module.exports = { scrapeSite, abortScrape, isScrapingActive };
