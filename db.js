const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'scraper.db');
const dataDir = path.join(__dirname, 'data');

let db = null;
let dbReady = null;

// Initialize database
async function initDatabase() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      max_depth INTEGER DEFAULT 2,
      cron_expression TEXT DEFAULT NULL,
      is_active INTEGER DEFAULT 1,
      last_scraped_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled',
      content_html TEXT NOT NULL,
      content_text TEXT NOT NULL,
      meta_description TEXT DEFAULT '',
      meta_keywords TEXT DEFAULT '',
      word_count INTEGER DEFAULT 0,
      images_count INTEGER DEFAULT 0,
      links_count INTEGER DEFAULT 0,
      has_changes INTEGER DEFAULT 0,
      parent_note_id INTEGER DEFAULT NULL,
      scrape_session_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_note_id) REFERENCES notes(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scrape_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      pages_scraped INTEGER DEFAULT 0,
      pages_total INTEGER DEFAULT 0,
      error_message TEXT DEFAULT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    )
  `);

  // Create indexes (ignore if exists)
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_notes_site_id ON notes(site_id)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(scrape_session_id)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_history_site ON scrape_history(site_id)`); } catch(e) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_history_session ON scrape_history(session_id)`); } catch(e) {}

  db.run("PRAGMA foreign_keys = ON");

  saveDatabase();
  console.log('[DB] Database initialized');
  return db;
}

// Save database to disk
function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 10 seconds
setInterval(() => {
  saveDatabase();
}, 10000);

// Helper: run query and return results as array of objects
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// Helper: run query and return first result
function queryGet(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

// Helper: run statement (insert/update/delete)
function runStmt(sql, params = []) {
  db.run(sql, params);
  saveDatabase();
  return {
    lastInsertRowid: db.exec("SELECT last_insert_rowid() as id")[0]?.values[0]?.[0],
    changes: db.getRowsModified(),
  };
}

// Get database ready promise
dbReady = initDatabase();

module.exports = {
  getDb: () => db,
  dbReady,
  queryAll,
  queryGet,
  runStmt,
  saveDatabase,
};
