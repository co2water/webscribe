const cron = require('node-cron');
const { queryAll, queryGet } = require('./db');
const { scrapeSite, isScrapingActive } = require('./scraper');

const cronJobs = new Map();

function initScheduler() {
  const sites = queryAll(
    `SELECT * FROM sites WHERE is_active = 1 AND cron_expression IS NOT NULL`
  );

  for (const site of sites) {
    scheduleJob(site);
  }

  console.log(`[Scheduler] Initialized ${sites.length} scheduled jobs`);
}

function scheduleJob(site) {
  removeJob(site.id);
  if (!site.cron_expression || !site.is_active) return;

  if (!cron.validate(site.cron_expression)) {
    console.error(`[Scheduler] Invalid cron expression for site ${site.id}: ${site.cron_expression}`);
    return;
  }

  const job = cron.schedule(site.cron_expression, async () => {
    console.log(`[Scheduler] Running scheduled scrape for site: ${site.name} (${site.url})`);
    if (isScrapingActive(site.id)) {
      console.log(`[Scheduler] Skipping - scrape already in progress for site ${site.id}`);
      return;
    }
    try {
      const result = await scrapeSite(site.id);
      console.log(`[Scheduler] Completed scrape for ${site.name}: ${result.pagesScraped} pages`);
    } catch (err) {
      console.error(`[Scheduler] Error scraping ${site.name}:`, err.message);
    }
  }, {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  cronJobs.set(site.id, job);
  console.log(`[Scheduler] Job scheduled for "${site.name}" with cron: ${site.cron_expression}`);
}

function removeJob(siteId) {
  const existing = cronJobs.get(siteId);
  if (existing) { existing.stop(); cronJobs.delete(siteId); }
}

function updateSchedule(siteId) {
  const site = queryGet('SELECT * FROM sites WHERE id = ?', [siteId]);
  if (site) { scheduleJob(site); } else { removeJob(siteId); }
}

function getSchedulerStatus() {
  const jobs = [];
  for (const [siteId] of cronJobs) {
    const site = queryGet('SELECT name, url, cron_expression FROM sites WHERE id = ?', [siteId]);
    if (site) {
      jobs.push({ siteId, name: site.name, url: site.url, cronExpression: site.cron_expression, running: isScrapingActive(siteId) });
    }
  }
  return jobs;
}

module.exports = { initScheduler, scheduleJob, removeJob, updateSchedule, getSchedulerStatus };
