const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Wait for database to be ready, then start
const { dbReady } = require('./db');

dbReady.then(() => {
  console.log('[Server] Database ready');

  const { queryGet: qg, queryAll } = require('./db');
  const { scrapeSite, abortScrape, isScrapingActive } = require('./scraper');

  // ===== Dashboard stats =====
  app.get('/api/stats', (req, res) => {
    try {
      const totalSites = qg('SELECT COUNT(*) as count FROM sites').count;
      const activeSites = qg('SELECT COUNT(*) as count FROM sites WHERE is_active = 1').count;
      const totalNotes = qg('SELECT COUNT(*) as count FROM notes').count;
      const totalScrapes = qg('SELECT COUNT(*) as count FROM scrape_history').count;
      const notesThisWeek = qg(`SELECT COUNT(*) as count FROM notes WHERE created_at >= datetime('now', '-7 days')`).count;
      const changedNotes = qg('SELECT COUNT(*) as count FROM notes WHERE has_changes = 1').count;

      const recentActivity = queryAll(`
        SELECT h.*, s.name as site_name
        FROM scrape_history h LEFT JOIN sites s ON h.site_id = s.id
        ORDER BY h.started_at DESC LIMIT 5
      `);

      res.json({
        success: true,
        data: { totalSites, activeSites, totalNotes, totalScrapes, notesThisWeek, changedNotes, recentActivity },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== Scrape endpoints (defined directly to avoid router conflicts) =====
  app.post('/api/scrape', (req, res) => {
    try {
      const { site_id } = req.body;
      if (!site_id) return res.status(400).json({ success: false, error: 'site_id is required' });

      const site = qg('SELECT * FROM sites WHERE id = ?', [parseInt(site_id)]);
      if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
      if (isScrapingActive(parseInt(site_id))) {
        return res.status(409).json({ success: false, error: 'Scraping is already in progress' });
      }

      res.json({ success: true, message: 'Scraping started', data: { site_id } });

      scrapeSite(parseInt(site_id)).then(result => {
        console.log(`[Scrape] Completed for "${site.name}": ${result.pagesScraped} pages scraped`);
        if (result.errors.length > 0) {
          console.log(`[Scrape] Errors:`, result.errors.map(e => `${e.url}: ${e.error}`).join('\n'));
        }
      }).catch(err => {
        console.error(`[Scrape] Failed for "${site.name}":`, err.message);
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/scrape/abort', (req, res) => {
    try {
      const { site_id } = req.body;
      if (!site_id) return res.status(400).json({ success: false, error: 'site_id is required' });

      const aborted = abortScrape(parseInt(site_id));
      if (aborted) {
        res.json({ success: true, message: 'Scrape abort requested' });
      } else {
        res.status(404).json({ success: false, error: 'No active scrape for this site' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/scrape/status/:siteId', (req, res) => {
    try {
      const history = qg(
        `SELECT * FROM scrape_history WHERE site_id = ? ORDER BY started_at DESC LIMIT 1`,
        [parseInt(req.params.siteId)]
      );
      res.json({
        success: true,
        data: { is_scraping: isScrapingActive(parseInt(req.params.siteId)), latest_history: history || null },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== History endpoint =====
  app.get('/api/history/all', (req, res) => {
    try {
      const { site_id, limit = 50 } = req.query;
      let query = `SELECT h.*, s.name as site_name, s.url as site_url FROM scrape_history h LEFT JOIN sites s ON h.site_id = s.id`;
      const params = [];
      if (site_id) { query += ' WHERE h.site_id = ?'; params.push(parseInt(site_id)); }
      query += ' ORDER BY h.started_at DESC LIMIT ?';
      params.push(parseInt(limit));

      const history = queryAll(query, params);
      res.json({ success: true, data: history });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== Route modules =====
  const sitesRouter = require('./routes/sites');
  const notesRouter = require('./routes/notes');

  app.use('/api/sites', sitesRouter);
  app.use('/api/notes', notesRouter);

  // SPA catch-all
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Initialize scheduler
  const { initScheduler } = require('./scheduler');

  app.listen(PORT, () => {
    console.log(`\n  🕸️  WebScribe is running!`);
    console.log(`  📍  http://localhost:${PORT}\n`);
    initScheduler();
  });
}).catch(err => {
  console.error('[Server] Failed to initialize database:', err);
  process.exit(1);
});
