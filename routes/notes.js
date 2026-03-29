const express = require('express');
const router = express.Router();
const { queryAll, queryGet, runStmt } = require('../db');
const { scrapeSite, abortScrape, isScrapingActive } = require('../scraper');

// GET /api/notes
router.get('/', (req, res) => {
  try {
    const { site_id, search, session_id, page = 1, limit = 20, changes_only } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClause = '1=1';
    const params = [];

    if (site_id) { whereClause += ' AND n.site_id = ?'; params.push(parseInt(site_id)); }
    if (session_id) { whereClause += ' AND n.scrape_session_id = ?'; params.push(session_id); }
    if (search) { whereClause += ' AND (n.title LIKE ? OR n.content_text LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (changes_only === '1') { whereClause += ' AND n.has_changes = 1'; }

    const countResult = queryGet(`SELECT COUNT(*) as total FROM notes n WHERE ${whereClause}`, params);

    const notes = queryAll(`
      SELECT n.id, n.site_id, n.url, n.title, n.meta_description, n.word_count,
             n.images_count, n.links_count, n.has_changes, n.scrape_session_id,
             n.created_at, s.name as site_name, s.url as site_url,
             SUBSTR(n.content_text, 1, 300) as content_preview
      FROM notes n LEFT JOIN sites s ON n.site_id = s.id
      WHERE ${whereClause}
      ORDER BY n.created_at DESC LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    res.json({
      success: true,
      data: notes,
      pagination: {
        total: countResult.total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(countResult.total / parseInt(limit)),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notes/:id
router.get('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid note ID' });

    const note = queryGet(`
      SELECT n.*, s.name as site_name, s.url as site_url
      FROM notes n LEFT JOIN sites s ON n.site_id = s.id WHERE n.id = ?
    `, [id]);

    if (!note) return res.status(404).json({ success: false, error: 'Note not found' });
    res.json({ success: true, data: note });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/notes/:id
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const note = queryGet('SELECT id FROM notes WHERE id = ?', [id]);
    if (!note) return res.status(404).json({ success: false, error: 'Note not found' });

    runStmt('DELETE FROM notes WHERE id = ?', [id]);
    res.json({ success: true, message: 'Note deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/notes/session/:sessionId
router.delete('/session/:sessionId', (req, res) => {
  try {
    const result = runStmt('DELETE FROM notes WHERE scrape_session_id = ?', [req.params.sessionId]);
    res.json({ success: true, message: `Deleted ${result.changes} notes` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/scrape
router.post('/scrape', (req, res) => {
  try {
    const { site_id } = req.body;
    if (!site_id) return res.status(400).json({ success: false, error: 'site_id is required' });

    const site = queryGet('SELECT * FROM sites WHERE id = ?', [parseInt(site_id)]);
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
    if (isScrapingActive(parseInt(site_id))) {
      return res.status(409).json({ success: false, error: 'Scraping is already in progress for this site' });
    }

    res.json({ success: true, message: 'Scraping started', data: { site_id } });

    scrapeSite(parseInt(site_id)).then(result => {
      console.log(`[Scrape] Completed for "${site.name}": ${result.pagesScraped} pages scraped`);
    }).catch(err => {
      console.error(`[Scrape] Failed for "${site.name}":`, err.message);
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/scrape/abort
router.post('/scrape/abort', (req, res) => {
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

// GET /api/scrape/status/:siteId
router.get('/scrape/status/:siteId', (req, res) => {
  try {
    const history = queryGet(
      `SELECT * FROM scrape_history WHERE site_id = ? ORDER BY started_at DESC LIMIT 1`,
      [parseInt(req.params.siteId)]
    );

    res.json({
      success: true,
      data: {
        is_scraping: isScrapingActive(parseInt(req.params.siteId)),
        latest_history: history || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/history/all
router.get('/history/all', (req, res) => {
  try {
    const { site_id, limit = 50 } = req.query;
    let query = `
      SELECT h.*, s.name as site_name, s.url as site_url
      FROM scrape_history h LEFT JOIN sites s ON h.site_id = s.id
    `;
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

module.exports = router;
