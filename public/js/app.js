/* =========================================
   WebScribe — Frontend Application
   ========================================= */

const API_BASE = '';

// =========================================
// State
// =========================================
let currentView = 'dashboard';
let currentNotesPage = 1;
let searchTimeout = null;
let pollInterval = null;

// =========================================
// Initialization
// =========================================
document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  loadDashboard();

  // Start polling for active scrapes
  pollInterval = setInterval(pollActiveStatus, 5000);
});

// =========================================
// Navigation
// =========================================
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      navigateTo(view);
    });
  });

  // Handle hash navigation
  const hash = window.location.hash.substring(1);
  if (hash && ['dashboard', 'sites', 'notes', 'history'].includes(hash)) {
    navigateTo(hash);
  }
}

function navigateTo(view) {
  currentView = view;
  window.location.hash = view;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === view);
  });

  // Update views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');

  // Load data for view
  switch (view) {
    case 'dashboard': loadDashboard(); break;
    case 'sites': loadSites(); break;
    case 'notes': loadNotes(); break;
    case 'history': loadHistory(); break;
  }
}

// =========================================
// API Helper
// =========================================
async function api(endpoint, options = {}) {
  const { method = 'GET', body } = options;
  const config = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) config.body = JSON.stringify(body);

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, config);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Unknown error');
    return data;
  } catch (err) {
    if (err.message !== 'Unknown error') {
      console.error(`API Error [${endpoint}]:`, err);
    }
    throw err;
  }
}

// =========================================
// Dashboard
// =========================================
async function loadDashboard() {
  try {
    const { data } = await api('/api/stats');

    document.getElementById('stat-sites').textContent = data.totalSites;
    document.getElementById('stat-notes').textContent = data.totalNotes;
    document.getElementById('stat-scrapes').textContent = data.totalScrapes;
    document.getElementById('stat-changes').textContent = data.changedNotes;

    // Render recent activity
    const container = document.getElementById('recentActivity');
    if (data.recentActivity.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p>暂无活动记录</p>
          <span>添加网站并开始爬取</span>
        </div>`;
      return;
    }

    container.innerHTML = `<div class="activity-list">
      ${data.recentActivity.map(item => `
        <div class="activity-item">
          <div class="activity-dot ${item.status}"></div>
          <div class="activity-info">
            <strong>${escapeHtml(item.site_name || 'Unknown')}</strong>
            <small>${statusText(item.status)} · ${item.pages_scraped} 页已爬取</small>
          </div>
          <div class="activity-meta">${formatTime(item.started_at)}</div>
        </div>
      `).join('')}
    </div>`;
  } catch (err) {
    showToast('加载仪表板失败: ' + err.message, 'error');
  }
}

// =========================================
// Sites Management
// =========================================
async function loadSites() {
  const container = document.getElementById('sitesList');
  try {
    const { data } = await api('/api/sites');

    if (data.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <p>还没有添加任何网站</p>
          <span>点击上方"添加网站"按钮开始</span>
        </div>`;
      return;
    }

    container.innerHTML = data.map(site => renderSiteCard(site)).join('');

    // Also update notes filter
    updateSiteFilter(data);
  } catch (err) {
    showToast('加载网站列表失败: ' + err.message, 'error');
  }
}

function renderSiteCard(site) {
  const statusClass = site.is_scraping ? 'scraping' : (site.is_active ? 'active' : 'inactive');
  const statusLabel = site.is_scraping ? '爬取中' : (site.is_active ? '活跃' : '已暂停');

  return `
    <div class="site-card" id="site-${site.id}">
      <div class="site-card-header">
        <h3 class="site-card-title">${escapeHtml(site.name)}</h3>
        <span class="status-badge status-${statusClass}">
          ${site.is_scraping ? '<span class="pulse-dot"></span>' : ''}
          ${statusLabel}
        </span>
      </div>
      <a class="site-card-url" href="${escapeHtml(site.url)}" target="_blank">${escapeHtml(site.url)}</a>
      <div class="site-card-meta">
        <span>📄 ${site.notes_count || 0} 笔记</span>
        <span>🔄 ${site.scrape_count || 0} 次爬取</span>
        <span>📏 深度 ${site.max_depth}</span>
        ${site.cron_expression ? `<span>⏰ ${escapeHtml(site.cron_expression)}</span>` : ''}
        ${site.last_scraped_at ? `<span>🕐 ${formatTime(site.last_scraped_at)}</span>` : ''}
      </div>
      <div class="site-card-actions">
        ${site.is_scraping
          ? `<button class="btn btn-sm btn-warning" onclick="abortScrape(${site.id})">⏹ 停止爬取</button>`
          : `<button class="btn btn-sm btn-success" onclick="startScrape(${site.id})">▶ 开始爬取</button>`
        }
        <button class="btn btn-sm btn-ghost" onclick="editSite(${site.id})">✏️ 编辑</button>
        <button class="btn btn-sm btn-danger" onclick="deleteSite(${site.id}, '${escapeHtml(site.name)}')">🗑️ 删除</button>
      </div>
    </div>
  `;
}

function showAddSiteModal() {
  document.getElementById('editSiteId').value = '';
  document.getElementById('siteUrl').value = '';
  document.getElementById('siteName').value = '';
  document.getElementById('siteDepth').value = 2;
  document.getElementById('siteCron').value = '';
  document.getElementById('depthValue').textContent = '2';
  document.getElementById('modalTitle').textContent = '添加新网站';
  document.getElementById('btnSubmitSite').textContent = '添加网站';
  document.getElementById('siteUrl').disabled = false;
  document.getElementById('addSiteModal').classList.add('active');
}

async function editSite(id) {
  try {
    const { data } = await api(`/api/sites/${id}`);
    document.getElementById('editSiteId').value = data.id;
    document.getElementById('siteUrl').value = data.url;
    document.getElementById('siteUrl').disabled = true;
    document.getElementById('siteName').value = data.name;
    document.getElementById('siteDepth').value = data.max_depth;
    document.getElementById('siteCron').value = data.cron_expression || '';
    document.getElementById('depthValue').textContent = data.max_depth;
    document.getElementById('modalTitle').textContent = '编辑网站';
    document.getElementById('btnSubmitSite').textContent = '保存修改';
    document.getElementById('addSiteModal').classList.add('active');
  } catch (err) {
    showToast('加载网站信息失败: ' + err.message, 'error');
  }
}

function closeModal() {
  document.getElementById('addSiteModal').classList.remove('active');
}

function updateDepthDisplay() {
  document.getElementById('depthValue').textContent = document.getElementById('siteDepth').value;
}

function setCron(expr) {
  document.getElementById('siteCron').value = expr;
}

async function handleSiteSubmit(e) {
  e.preventDefault();

  const editId = document.getElementById('editSiteId').value;
  const url = document.getElementById('siteUrl').value.trim();
  const name = document.getElementById('siteName').value.trim();
  const max_depth = parseInt(document.getElementById('siteDepth').value);
  const cron_expression = document.getElementById('siteCron').value.trim() || null;

  try {
    if (editId) {
      await api(`/api/sites/${editId}`, {
        method: 'PUT',
        body: { name, max_depth, cron_expression },
      });
      showToast('网站已更新', 'success');
    } else {
      await api('/api/sites', {
        method: 'POST',
        body: { url, name, max_depth, cron_expression },
      });
      showToast('网站已添加', 'success');
    }

    closeModal();
    loadSites();
    loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSite(id, name) {
  if (!confirm(`确定要删除 "${name}" 吗？\n这将同时删除所有相关笔记和历史记录。`)) return;

  try {
    await api(`/api/sites/${id}`, { method: 'DELETE' });
    showToast('网站已删除', 'success');
    loadSites();
    loadDashboard();
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

async function startScrape(siteId) {
  try {
    await api('/api/scrape', { method: 'POST', body: { site_id: siteId } });
    showToast('爬取已开始! 请稍候...', 'info');
    loadSites();
  } catch (err) {
    showToast('启动爬取失败: ' + err.message, 'error');
  }
}

async function abortScrape(siteId) {
  try {
    await api('/api/scrape/abort', { method: 'POST', body: { site_id: siteId } });
    showToast('正在停止爬取...', 'warning');
    setTimeout(() => loadSites(), 1500);
  } catch (err) {
    showToast('停止失败: ' + err.message, 'error');
  }
}

// =========================================
// Notes
// =========================================
async function loadNotes(page = 1) {
  currentNotesPage = page;
  const container = document.getElementById('notesList');
  const search = document.getElementById('noteSearch').value.trim();
  const siteId = document.getElementById('noteSiteFilter').value;
  const changesOnly = document.getElementById('noteChangesOnly').checked;

  let params = `?page=${page}&limit=12`;
  if (search) params += `&search=${encodeURIComponent(search)}`;
  if (siteId) params += `&site_id=${siteId}`;
  if (changesOnly) params += `&changes_only=1`;

  try {
    const { data, pagination } = await api(`/api/notes${params}`);

    if (data.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p>${search ? '没有找到匹配的笔记' : '暂无笔记'}</p>
          <span>${search ? '尝试其他关键词' : '爬取网站后将自动生成笔记'}</span>
        </div>`;
      document.getElementById('notesPagination').innerHTML = '';
      return;
    }

    container.innerHTML = data.map(note => `
      <div class="note-card" onclick="viewNote(${note.id})">
        ${note.has_changes ? '<div class="change-badge"></div>' : ''}
        <div class="note-card-title">${escapeHtml(note.title)}</div>
        <div class="note-card-source">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          ${escapeHtml(note.site_name || '')}
        </div>
        <div class="note-card-preview">${escapeHtml(note.content_preview || '')}</div>
        <div class="note-card-footer">
          <span>${formatTime(note.created_at)}</span>
          <div class="note-card-stats">
            <span>📝 ${note.word_count}</span>
            <span>🖼️ ${note.images_count}</span>
            <span>🔗 ${note.links_count}</span>
          </div>
        </div>
      </div>
    `).join('');

    renderPagination(pagination);
  } catch (err) {
    showToast('加载笔记失败: ' + err.message, 'error');
  }
}

function renderPagination(pagination) {
  const container = document.getElementById('notesPagination');
  if (pagination.totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  html += `<button ${pagination.page <= 1 ? 'disabled' : ''} onclick="loadNotes(${pagination.page - 1})">‹ 上一页</button>`;

  const maxButtons = 7;
  let start = Math.max(1, pagination.page - Math.floor(maxButtons / 2));
  let end = Math.min(pagination.totalPages, start + maxButtons - 1);
  if (end - start < maxButtons - 1) {
    start = Math.max(1, end - maxButtons + 1);
  }

  if (start > 1) {
    html += `<button onclick="loadNotes(1)">1</button>`;
    if (start > 2) html += `<button disabled>…</button>`;
  }

  for (let i = start; i <= end; i++) {
    html += `<button class="${i === pagination.page ? 'active' : ''}" onclick="loadNotes(${i})">${i}</button>`;
  }

  if (end < pagination.totalPages) {
    if (end < pagination.totalPages - 1) html += `<button disabled>…</button>`;
    html += `<button onclick="loadNotes(${pagination.totalPages})">${pagination.totalPages}</button>`;
  }

  html += `<button ${pagination.page >= pagination.totalPages ? 'disabled' : ''} onclick="loadNotes(${pagination.page + 1})">下一页 ›</button>`;

  container.innerHTML = html;
}

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadNotes(), 400);
}

function updateSiteFilter(sites) {
  const select = document.getElementById('noteSiteFilter');
  const currentValue = select.value;
  select.innerHTML = '<option value="">所有网站</option>' +
    sites.map(s => `<option value="${s.id}" ${s.id == currentValue ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
}

async function viewNote(id) {
  try {
    const { data } = await api(`/api/notes/${id}`);

    document.getElementById('noteDetailTitle').textContent = data.title;
    document.getElementById('noteDetailMeta').innerHTML = `
      来源: <a href="${escapeHtml(data.url)}" target="_blank">${escapeHtml(data.site_name || data.url)}</a>
      · ${formatTime(data.created_at)}
      · ${data.word_count} 字
      · ${data.images_count} 图片
      · ${data.links_count} 链接
    `;
    document.getElementById('noteDetailContent').innerHTML = data.content_html;

    // Show note detail view
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-note-detail').classList.add('active');
  } catch (err) {
    showToast('加载笔记详情失败: ' + err.message, 'error');
  }
}

// =========================================
// History
// =========================================
async function loadHistory() {
  const container = document.getElementById('historyList');
  try {
    const { data } = await api('/api/history/all');

    if (data.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p>暂无爬取记录</p>
          <span>开始爬取网站后记录将出现在这里</span>
        </div>`;
      return;
    }

    container.innerHTML = data.map(item => {
      const icon = item.status === 'completed'
        ? '✅'
        : item.status === 'failed'
        ? '❌'
        : '🔄';

      return `
        <div class="history-item">
          <div class="history-status-icon ${item.status}">
            ${icon}
          </div>
          <div class="history-info">
            <h4>${escapeHtml(item.site_name || 'Unknown')}</h4>
            <p>${statusText(item.status)}${item.error_message ? ' — ' + escapeHtml(item.error_message) : ''}</p>
          </div>
          <div class="history-stats">
            <span>📄 ${item.pages_scraped} 页</span>
            <span>🕐 ${formatTime(item.started_at)}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    showToast('加载历史记录失败: ' + err.message, 'error');
  }
}

// =========================================
// Polling for active scrapes
// =========================================
async function pollActiveStatus() {
  if (currentView !== 'sites' && currentView !== 'dashboard') return;

  try {
    const { data } = await api('/api/sites');
    const anyScraping = data.some(s => s.is_scraping);

    if (anyScraping && currentView === 'sites') {
      const container = document.getElementById('sitesList');
      container.innerHTML = data.map(site => renderSiteCard(site)).join('');
    }

    if (currentView === 'dashboard') {
      loadDashboard();
    }
  } catch (err) {
    // Silent fail for polling
  }
}

// =========================================
// Toast Notifications
// =========================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
  };

  toast.innerHTML = `
    <span>${icons[type] || 'ℹ️'}</span>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

// =========================================
// Utility Functions
// =========================================
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(dateStr) {
  if (!dateStr) return '未知';
  try {
    const date = new Date(dateStr + 'Z'); // UTC
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;

    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return dateStr;
  }
}

function statusText(status) {
  switch (status) {
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'running': return '进行中';
    default: return status;
  }
}
