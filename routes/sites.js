const express = require('express');
const router = express.Router();
const { queryAll, queryGet, runStmt } = require('../db');
const { updateSchedule, removeJob } = require('../scheduler');
const { isScrapingActive } = require('../scraper');
const cron = require('node-cron');

// GET /api/sites
router.get('/', (req, res) => {
  try {
    const sites = queryAll(`
      SELECT s.*,
        (SELECT COUNT(*) FROM notes WHERE site_id = s.id) as notes_count,
        (SELECT COUNT(*) FROM scrape_history WHERE site_id = s.id) as scrape_count
      FROM sites s ORDER BY s.updated_at DESC
    `);

    const result = sites.map(site => ({
      ...site,
      is_scraping: isScrapingActive(site.id),
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sites/:id
router.get('/:id', (req, res) => {
  try {
    const site = queryGet('SELECT * FROM sites WHERE id = ?', [parseInt(req.params.id)]);
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
    site.is_scraping = isScrapingActive(site.id);
    res.json({ success: true, data: site });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sites
router.post('/', (req, res) => {
  try {
    const { url, name, max_depth, cron_expression } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL is required' });

    try { new URL(url); } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid URL format' });
    }

    if (cron_expression && !cron.validate(cron_expression)) {
      return res.status(400).json({ success: false, error: 'Invalid cron expression' });
    }

    const siteName = name || new URL(url).hostname;
    const depth = Math.min(Math.max(parseInt(max_depth) || 2, 0), 5);

    const result = runStmt(
      `INSERT INTO sites (url, name, max_depth, cron_expression) VALUES (?, ?, ?, ?)`,
      [url, siteName, depth, cron_expression || null]
    );

    const site = queryGet('SELECT * FROM sites WHERE id = ?', [result.lastInsertRowid]);

    if (cron_expression) updateSchedule(site.id);

    res.status(201).json({ success: true, data: site });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ success: false, error: 'This URL has already been added' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/sites/:id
router.put('/:id', (req, res) => {
  try {
    const { name, max_depth, cron_expression, is_active } = req.body;
    const site = queryGet('SELECT * FROM sites WHERE id = ?', [parseInt(req.params.id)]);
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    if (cron_expression && !cron.validate(cron_expression)) {
      return res.status(400).json({ success: false, error: 'Invalid cron expression' });
    }

    const updatedName = name !== undefined ? name : site.name;
    const updatedDepth = max_depth !== undefined ? Math.min(Math.max(parseInt(max_depth) || 2, 0), 5) : site.max_depth;
    const updatedCron = cron_expression !== undefined ? (cron_expression || null) : site.cron_expression;
    const updatedActive = is_active !== undefined ? (is_active ? 1 : 0) : site.is_active;

    runStmt(
      `UPDATE sites SET name = ?, max_depth = ?, cron_expression = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`,
      [updatedName, updatedDepth, updatedCron, updatedActive, parseInt(req.params.id)]
    );

    updateSchedule(parseInt(req.params.id));

    const updated = queryGet('SELECT * FROM sites WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/sites/:id
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const site = queryGet('SELECT * FROM sites WHERE id = ?', [id]);
    if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

    removeJob(id);
    // Delete related data first (sql.js doesn't enforce foreign keys as reliably)
    runStmt('DELETE FROM notes WHERE site_id = ?', [id]);
    runStmt('DELETE FROM scrape_history WHERE site_id = ?', [id]);
    runStmt('DELETE FROM sites WHERE id = ?', [id]);

    res.json({ success: true, message: 'Site deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
