const http = require('http');
const { Pool } = require('pg');
const { URL } = require('url');

// ── Configuration ──
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const CACHE_URL = process.env.CACHE_URL;
const BLOB_STORE_URL = process.env.BLOB_STORE_URL;
const BLOB_API_KEY = process.env.BLOB_API_KEY;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ── Database ──
let pool;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
}

async function query(text, params) {
  if (!pool) throw new Error('Database not configured');
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log(`[DB] ${text.substring(0, 60)}... (${duration}ms, ${result.rowCount} rows)`);
  return result;
}

// ── Cache (Valkey/Redis compatible via RESP) ──
let cacheConnected = false;
const net = require('net');

function parseRedisResponse(data) {
  const str = data.toString();
  if (str.startsWith('+')) return str.slice(1).trim();
  if (str.startsWith('-')) throw new Error(str.slice(1).trim());
  if (str.startsWith(':')) return parseInt(str.slice(1).trim());
  if (str.startsWith('$-1')) return null;
  if (str.startsWith('$')) {
    const lines = str.split('\r\n');
    return lines[1];
  }
  return str.trim();
}

function cacheCommand(...args) {
  if (!CACHE_URL) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(CACHE_URL);
      const client = net.createConnection({ host: url.hostname, port: parseInt(url.port) || 6379 }, () => {
        const cmd = `*${args.length}\r\n${args.map(a => `$${Buffer.byteLength(String(a))}\r\n${a}`).join('\r\n')}\r\n`;
        client.write(cmd);
      });
      let response = '';
      client.on('data', (data) => { response += data.toString(); });
      client.on('end', () => { resolve(parseRedisResponse(Buffer.from(response))); });
      client.setTimeout(2000, () => { client.destroy(); reject(new Error('Cache timeout')); });
      client.on('error', (e) => { resolve(null); });
      setTimeout(() => { client.end(); }, 500);
    } catch (e) { resolve(null); }
  });
}

async function cacheGet(key) {
  return cacheCommand('GET', key);
}

async function cacheSet(key, value, ttlSeconds = 300) {
  return cacheCommand('SET', key, value, 'EX', ttlSeconds);
}

async function cacheDel(key) {
  return cacheCommand('DEL', key);
}

// ── Blob Storage ──
async function blobRequest(method, path, body = null, contentType = 'application/octet-stream') {
  if (!BLOB_STORE_URL || !BLOB_API_KEY) return null;
  const url = `${BLOB_STORE_URL}${path}`;
  const headers = { 'X-Api-Key': BLOB_API_KEY, 'Content-Type': contentType };
  const options = { method, headers };
  if (body) options.body = body;

  try {
    const resp = await fetch(url, options);
    if (!resp.ok && resp.status !== 404) {
      console.log(`[BLOB] ${method} ${path} → ${resp.status}`);
    }
    if (resp.status === 404) return null;
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('json')) return resp.json();
    return resp.text();
  } catch (e) {
    console.log(`[BLOB] Error: ${e.message}`);
    return null;
  }
}

// ── Router ──
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function matchRoute(method, pathname, routes) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (match) return { handler: route.handler, params: match.groups || {} };
  }
  return null;
}

// ── Route Handlers ──

// Health check
async function healthCheck(req, res) {
  const checks = { status: 'healthy', timestamp: new Date().toISOString(), environment: NODE_ENV, uptime: process.uptime() };

  // DB health
  try {
    if (pool) {
      const r = await pool.query('SELECT 1 as ok, NOW() as time');
      checks.database = { status: 'connected', time: r.rows[0].time };
    } else {
      checks.database = { status: 'not_configured' };
    }
  } catch (e) {
    checks.database = { status: 'error', error: e.message };
    checks.status = 'degraded';
  }

  // Cache health
  try {
    const pong = await cacheCommand('PING');
    checks.cache = { status: pong === 'PONG' ? 'connected' : 'unknown', response: pong };
  } catch (e) {
    checks.cache = { status: 'error', error: e.message };
  }

  // Blob health
  checks.blobs = { status: BLOB_STORE_URL ? 'configured' : 'not_configured' };

  json(res, checks);
}

// System info
async function systemInfo(req, res) {
  json(res, {
    app: 'Embr Task Manager',
    version: '1.0.0',
    node: process.version,
    platform: process.platform,
    env: NODE_ENV,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    pid: process.pid,
    config: {
      database: !!DATABASE_URL,
      cache: !!CACHE_URL,
      blobs: !!BLOB_STORE_URL
    }
  });
}

// ── Projects CRUD ──
async function listProjects(req, res) {
  const cached = await cacheGet('projects:list');
  if (cached) {
    console.log('[CACHE] HIT projects:list');
    return json(res, { source: 'cache', projects: JSON.parse(cached) });
  }
  const result = await query('SELECT * FROM projects ORDER BY created_at DESC');
  await cacheSet('projects:list', JSON.stringify(result.rows), 60);
  json(res, { source: 'db', projects: result.rows });
}

async function getProject(req, res, params) {
  const { id } = params;
  const cached = await cacheGet(`project:${id}`);
  if (cached) {
    return json(res, { source: 'cache', project: JSON.parse(cached) });
  }
  const result = await query('SELECT * FROM projects WHERE id = $1', [id]);
  if (result.rows.length === 0) return json(res, { error: 'Project not found' }, 404);
  const taskCount = await query('SELECT COUNT(*) as count FROM tasks WHERE project_id = $1', [id]);
  const project = { ...result.rows[0], task_count: parseInt(taskCount.rows[0].count) };
  await cacheSet(`project:${id}`, JSON.stringify(project), 120);
  json(res, { source: 'db', project });
}

async function createProject(req, res) {
  const body = await parseBody(req);
  if (!body.name) return json(res, { error: 'name is required' }, 400);
  const result = await query(
    'INSERT INTO projects (name, description, status) VALUES ($1, $2, $3) RETURNING *',
    [body.name, body.description || null, body.status || 'active']
  );
  await cacheDel('projects:list');
  await query('INSERT INTO activity_log (entity_type, entity_id, action, details) VALUES ($1, $2, $3, $4)',
    ['project', result.rows[0].id, 'created', JSON.stringify({ name: body.name })]);
  json(res, { project: result.rows[0] }, 201);
}

async function updateProject(req, res, params) {
  const body = await parseBody(req);
  const { id } = params;
  const result = await query(
    'UPDATE projects SET name = COALESCE($1, name), description = COALESCE($2, description), status = COALESCE($3, status), updated_at = NOW() WHERE id = $4 RETURNING *',
    [body.name, body.description, body.status, id]
  );
  if (result.rows.length === 0) return json(res, { error: 'Not found' }, 404);
  await cacheDel('projects:list');
  await cacheDel(`project:${id}`);
  json(res, { project: result.rows[0] });
}

async function deleteProject(req, res, params) {
  const { id } = params;
  const result = await query('DELETE FROM projects WHERE id = $1 RETURNING *', [id]);
  if (result.rows.length === 0) return json(res, { error: 'Not found' }, 404);
  await cacheDel('projects:list');
  await cacheDel(`project:${id}`);
  json(res, { deleted: true, project: result.rows[0] });
}

// ── Tasks CRUD ──
async function listTasks(req, res, params) {
  const { projectId } = params;
  const url = new URL(req.url, `http://localhost`);
  const status = url.searchParams.get('status');
  const priority = url.searchParams.get('priority');

  let sql = 'SELECT * FROM tasks WHERE project_id = $1';
  const sqlParams = [projectId];
  if (status) { sqlParams.push(status); sql += ` AND status = $${sqlParams.length}`; }
  if (priority) { sqlParams.push(priority); sql += ` AND priority = $${sqlParams.length}`; }
  sql += ' ORDER BY CASE priority WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, created_at DESC';

  const result = await query(sql, sqlParams);
  json(res, { count: result.rows.length, tasks: result.rows });
}

async function getTask(req, res, params) {
  const { id } = params;
  const result = await query('SELECT t.*, p.name as project_name FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = $1', [id]);
  if (result.rows.length === 0) return json(res, { error: 'Task not found' }, 404);
  const comments = await query('SELECT * FROM comments WHERE task_id = $1 ORDER BY created_at', [id]);
  json(res, { task: result.rows[0], comments: comments.rows });
}

async function createTask(req, res) {
  const body = await parseBody(req);
  if (!body.title || !body.project_id) return json(res, { error: 'title and project_id required' }, 400);
  const result = await query(
    'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, due_date, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [body.project_id, body.title, body.description, body.status || 'todo', body.priority || 'medium', body.assigned_to, body.due_date, body.tags || []]
  );
  await cacheDel('projects:list');
  await cacheDel(`project:${body.project_id}`);
  await query('INSERT INTO activity_log (entity_type, entity_id, action, details) VALUES ($1,$2,$3,$4)',
    ['task', result.rows[0].id, 'created', JSON.stringify({ title: body.title })]);
  json(res, { task: result.rows[0] }, 201);
}

async function updateTask(req, res, params) {
  const body = await parseBody(req);
  const { id } = params;
  const old = await query('SELECT * FROM tasks WHERE id = $1', [id]);
  if (old.rows.length === 0) return json(res, { error: 'Not found' }, 404);

  const result = await query(
    `UPDATE tasks SET title = COALESCE($1, title), description = COALESCE($2, description),
     status = COALESCE($3, status), priority = COALESCE($4, priority),
     assigned_to = COALESCE($5, assigned_to), due_date = COALESCE($6, due_date),
     updated_at = NOW() WHERE id = $7 RETURNING *`,
    [body.title, body.description, body.status, body.priority, body.assigned_to, body.due_date, id]
  );
  const changes = {};
  if (body.status && body.status !== old.rows[0].status) changes.status = { from: old.rows[0].status, to: body.status };
  if (body.priority && body.priority !== old.rows[0].priority) changes.priority = { from: old.rows[0].priority, to: body.priority };
  await query('INSERT INTO activity_log (entity_type, entity_id, action, details) VALUES ($1,$2,$3,$4)',
    ['task', id, 'updated', JSON.stringify(changes)]);
  json(res, { task: result.rows[0] });
}

async function deleteTask(req, res, params) {
  const { id } = params;
  const result = await query('DELETE FROM tasks WHERE id = $1 RETURNING *', [id]);
  if (result.rows.length === 0) return json(res, { error: 'Not found' }, 404);
  json(res, { deleted: true });
}

// ── Comments ──
async function addComment(req, res, params) {
  const body = await parseBody(req);
  const { taskId } = params;
  if (!body.body || !body.author) return json(res, { error: 'body and author required' }, 400);
  const result = await query('INSERT INTO comments (task_id, author, body) VALUES ($1,$2,$3) RETURNING *', [taskId, body.author, body.body]);
  json(res, { comment: result.rows[0] }, 201);
}

// ── Activity Log ──
async function listActivity(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const result = await query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT $1', [limit]);
  json(res, { count: result.rows.length, activities: result.rows });
}

// ── Dashboard / Stats ──
async function dashboard(req, res) {
  const cacheKey = 'dashboard:stats';
  const cached = await cacheGet(cacheKey);
  if (cached) return json(res, { source: 'cache', ...JSON.parse(cached) });

  const [projects, tasksByStatus, tasksByPriority, recentActivity, overdue] = await Promise.all([
    query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = \'active\') as active FROM projects'),
    query('SELECT status, COUNT(*) as count FROM tasks GROUP BY status ORDER BY count DESC'),
    query('SELECT priority, COUNT(*) as count FROM tasks GROUP BY priority'),
    query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 10'),
    query('SELECT COUNT(*) as count FROM tasks WHERE due_date < CURRENT_DATE AND status != \'done\'')
  ]);

  const stats = {
    projects: projects.rows[0],
    tasks_by_status: tasksByStatus.rows,
    tasks_by_priority: tasksByPriority.rows,
    overdue_tasks: parseInt(overdue.rows[0].count),
    recent_activity: recentActivity.rows
  };

  await cacheSet(cacheKey, JSON.stringify(stats), 30);
  json(res, { source: 'db', ...stats });
}

// ── Blob Storage Endpoints ──
async function uploadBlob(req, res) {
  const body = await parseBody(req);
  if (!body.key || !body.content) return json(res, { error: 'key and content required' }, 400);
  const result = await blobRequest('PUT', `/blobs/${body.key}`, body.content, 'text/plain');
  json(res, { uploaded: true, key: body.key, result });
}

async function getBlob(req, res, params) {
  const { key } = params;
  const result = await blobRequest('GET', `/blobs/${key}`);
  if (result === null) return json(res, { error: 'Blob not found' }, 404);
  json(res, { key, content: result });
}

async function listBlobs(req, res) {
  const result = await blobRequest('GET', '/blobs');
  json(res, { blobs: result });
}

// ── Cache Stats ──
async function cacheStats(req, res) {
  try {
    const info = await cacheCommand('INFO', 'stats');
    const dbsize = await cacheCommand('DBSIZE');
    json(res, { cache: 'connected', dbsize, info: info ? info.substring(0, 500) : null });
  } catch (e) {
    json(res, { cache: 'error', error: e.message });
  }
}

// ── Search ──
async function searchTasks(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('q');
  if (!q) return json(res, { error: 'q parameter required' }, 400);
  const result = await query(
    `SELECT t.*, p.name as project_name FROM tasks t JOIN projects p ON t.project_id = p.id
     WHERE t.title ILIKE $1 OR t.description ILIKE $1 OR t.assigned_to ILIKE $1
     ORDER BY t.updated_at DESC LIMIT 20`, [`%${q}%`]);
  json(res, { query: q, count: result.rows.length, results: result.rows });
}

// ── Bulk Operations ──
async function bulkUpdateTasks(req, res) {
  const body = await parseBody(req);
  if (!body.task_ids || !body.updates) return json(res, { error: 'task_ids and updates required' }, 400);
  const setClauses = [];
  const params = [];
  if (body.updates.status) { params.push(body.updates.status); setClauses.push(`status = $${params.length}`); }
  if (body.updates.priority) { params.push(body.updates.priority); setClauses.push(`priority = $${params.length}`); }
  if (body.updates.assigned_to) { params.push(body.updates.assigned_to); setClauses.push(`assigned_to = $${params.length}`); }
  setClauses.push('updated_at = NOW()');
  params.push(body.task_ids);
  const result = await query(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ANY($${params.length}) RETURNING *`, params);
  json(res, { updated: result.rowCount, tasks: result.rows });
}

// ── Routes ──
const routes = [
  // Health & Info
  { method: 'GET', pattern: /^\/health$/, handler: healthCheck },
  { method: 'GET', pattern: /^\/api\/info$/, handler: systemInfo },
  { method: 'GET', pattern: /^\/api\/dashboard$/, handler: dashboard },

  // Projects
  { method: 'GET', pattern: /^\/api\/projects$/, handler: listProjects },
  { method: 'GET', pattern: /^\/api\/projects\/(?<id>\d+)$/, handler: getProject },
  { method: 'POST', pattern: /^\/api\/projects$/, handler: createProject },
  { method: 'PUT', pattern: /^\/api\/projects\/(?<id>\d+)$/, handler: updateProject },
  { method: 'DELETE', pattern: /^\/api\/projects\/(?<id>\d+)$/, handler: deleteProject },

  // Tasks
  { method: 'GET', pattern: /^\/api\/projects\/(?<projectId>\d+)\/tasks$/, handler: listTasks },
  { method: 'GET', pattern: /^\/api\/tasks\/(?<id>\d+)$/, handler: getTask },
  { method: 'POST', pattern: /^\/api\/tasks$/, handler: createTask },
  { method: 'PUT', pattern: /^\/api\/tasks\/(?<id>\d+)$/, handler: updateTask },
  { method: 'DELETE', pattern: /^\/api\/tasks\/(?<id>\d+)$/, handler: deleteTask },
  { method: 'POST', pattern: /^\/api\/tasks\/bulk$/, handler: bulkUpdateTasks },

  // Comments
  { method: 'POST', pattern: /^\/api\/tasks\/(?<taskId>\d+)\/comments$/, handler: addComment },

  // Search & Activity
  { method: 'GET', pattern: /^\/api\/search$/, handler: searchTasks },
  { method: 'GET', pattern: /^\/api\/activity$/, handler: listActivity },

  // Blobs
  { method: 'POST', pattern: /^\/api\/blobs$/, handler: uploadBlob },
  { method: 'GET', pattern: /^\/api\/blobs\/(?<key>[^/]+)$/, handler: getBlob },
  { method: 'GET', pattern: /^\/api\/blobs$/, handler: listBlobs },

  // Cache
  { method: 'GET', pattern: /^\/api\/cache\/stats$/, handler: cacheStats },
];

// ── Server ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Root → dashboard HTML
  if (pathname === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(dashboardHTML());
  }

  console.log(`[HTTP] ${method} ${pathname}`);

  const route = matchRoute(method, pathname, routes);
  if (route) {
    try {
      await route.handler(req, res, route.params);
    } catch (e) {
      console.error(`[ERROR] ${method} ${pathname}:`, e.message);
      json(res, { error: 'Internal server error', message: e.message }, 500);
    }
  } else {
    json(res, { error: 'Not found', path: pathname }, 404);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Embr Task Manager running on port ${PORT}`);
  console.log(`📊 Environment: ${NODE_ENV}`);
  console.log(`🗄️  Database: ${DATABASE_URL ? 'configured' : 'not configured'}`);
  console.log(`⚡ Cache: ${CACHE_URL ? 'configured' : 'not configured'}`);
  console.log(`📦 Blobs: ${BLOB_STORE_URL ? 'configured' : 'not configured'}`);
});

// ── Dashboard HTML ──
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Embr Task Manager</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
    .header{background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:2rem;text-align:center}
    .header h1{font-size:2rem;font-weight:700;margin-bottom:.5rem}
    .header p{opacity:.8}
    .container{max-width:1200px;margin:2rem auto;padding:0 1rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.5rem;margin-bottom:2rem}
    .card{background:#1e293b;border-radius:12px;padding:1.5rem;border:1px solid #334155}
    .card h3{color:#a5b4fc;font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1rem}
    .stat{font-size:2.5rem;font-weight:700;color:#f1f5f9}
    .stat-label{color:#94a3b8;font-size:.9rem;margin-top:.25rem}
    .badge{display:inline-block;padding:.25rem .75rem;border-radius:999px;font-size:.75rem;font-weight:600}
    .badge-green{background:#065f46;color:#6ee7b7}
    .badge-yellow{background:#713f12;color:#fcd34d}
    .badge-red{background:#7f1d1d;color:#fca5a5}
    .badge-blue{background:#1e3a5f;color:#93c5fd}
    #status{margin-top:1rem;padding:1rem;background:#0f172a;border-radius:8px;font-family:monospace;font-size:.85rem;white-space:pre-wrap;max-height:400px;overflow-y:auto}
    button{background:#6366f1;color:white;border:none;padding:.75rem 1.5rem;border-radius:8px;cursor:pointer;font-size:.9rem;font-weight:600;margin:.25rem}
    button:hover{background:#4f46e5}
    .actions{margin:1.5rem 0;display:flex;flex-wrap:wrap;gap:.5rem}
    table{width:100%;border-collapse:collapse;margin-top:1rem}
    th,td{padding:.75rem;text-align:left;border-bottom:1px solid #334155}
    th{color:#a5b4fc;font-size:.8rem;text-transform:uppercase}
    .api-list{list-style:none;padding:0}
    .api-list li{padding:.5rem 0;border-bottom:1px solid #1e293b;font-family:monospace;font-size:.85rem}
    .method{font-weight:700;margin-right:.5rem}
    .method-get{color:#6ee7b7}.method-post{color:#fcd34d}.method-put{color:#93c5fd}.method-delete{color:#fca5a5}
  </style>
</head>
<body>
  <div class="header">
    <h1>🔥 Embr Task Manager</h1>
    <p>Production-grade task management API • Powered by Embr Platform</p>
  </div>
  <div class="container">
    <div class="grid" id="stats">
      <div class="card"><h3>System Status</h3><div id="health">Loading...</div></div>
      <div class="card"><h3>Projects</h3><div id="project-count"><span class="stat">-</span></div></div>
      <div class="card"><h3>Tasks</h3><div id="task-stats">Loading...</div></div>
      <div class="card"><h3>Services</h3><div id="services">Loading...</div></div>
    </div>
    <div class="card">
      <h3>Quick Actions</h3>
      <div class="actions">
        <button onclick="createSampleData()">📦 Create Sample Data</button>
        <button onclick="loadDashboard()">📊 Refresh Dashboard</button>
        <button onclick="testCache()">⚡ Test Cache</button>
        <button onclick="testSearch()">🔍 Test Search</button>
        <button onclick="loadActivity()">📜 View Activity</button>
        <button onclick="healthCheck()">🏥 Health Check</button>
      </div>
    </div>
    <div class="grid" style="margin-top:1.5rem">
      <div class="card" style="grid-column:1/-1"><h3>API Endpoints</h3>
        <ul class="api-list">
          <li><span class="method method-get">GET</span> /health — Health check</li>
          <li><span class="method method-get">GET</span> /api/info — System info</li>
          <li><span class="method method-get">GET</span> /api/dashboard — Dashboard stats</li>
          <li><span class="method method-get">GET</span> /api/projects — List projects</li>
          <li><span class="method method-post">POST</span> /api/projects — Create project</li>
          <li><span class="method method-get">GET</span> /api/projects/:id — Get project</li>
          <li><span class="method method-put">PUT</span> /api/projects/:id — Update project</li>
          <li><span class="method method-delete">DELETE</span> /api/projects/:id — Delete project</li>
          <li><span class="method method-get">GET</span> /api/projects/:id/tasks — List tasks (filter: ?status=&priority=)</li>
          <li><span class="method method-post">POST</span> /api/tasks — Create task</li>
          <li><span class="method method-get">GET</span> /api/tasks/:id — Get task with comments</li>
          <li><span class="method method-put">PUT</span> /api/tasks/:id — Update task</li>
          <li><span class="method method-delete">DELETE</span> /api/tasks/:id — Delete task</li>
          <li><span class="method method-post">POST</span> /api/tasks/bulk — Bulk update tasks</li>
          <li><span class="method method-post">POST</span> /api/tasks/:id/comments — Add comment</li>
          <li><span class="method method-get">GET</span> /api/search?q= — Search tasks</li>
          <li><span class="method method-get">GET</span> /api/activity — Activity log</li>
          <li><span class="method method-get">GET</span> /api/cache/stats — Cache stats</li>
          <li><span class="method method-post">POST</span> /api/blobs — Upload blob</li>
          <li><span class="method method-get">GET</span> /api/blobs/:key — Get blob</li>
        </ul>
      </div>
    </div>
    <div class="card" style="margin-top:1.5rem"><h3>Console</h3><div id="status">Ready. Click an action above.</div></div>
  </div>
  <script>
    const log = (msg) => { const el = document.getElementById('status'); el.textContent = typeof msg === 'object' ? JSON.stringify(msg, null, 2) : msg; };
    const api = async (path, opts = {}) => {
      const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      return r.json();
    };
    async function healthCheck() { log(await api('/health')); }
    async function loadDashboard() {
      try {
        const [h, d] = await Promise.all([api('/health'), api('/api/dashboard')]);
        document.getElementById('health').innerHTML = '<span class="badge badge-' + (h.status==='healthy'?'green':'red') + '">' + h.status + '</span>';
        document.getElementById('services').innerHTML =
          '<div>DB: <span class="badge badge-' + (h.database?.status==='connected'?'green':'yellow') + '">' + (h.database?.status||'?') + '</span></div>' +
          '<div style="margin-top:.5rem">Cache: <span class="badge badge-' + (h.cache?.status==='connected'?'green':'yellow') + '">' + (h.cache?.status||'?') + '</span></div>' +
          '<div style="margin-top:.5rem">Blobs: <span class="badge badge-' + (h.blobs?.status==='configured'?'blue':'yellow') + '">' + (h.blobs?.status||'?') + '</span></div>';
        document.getElementById('project-count').innerHTML = '<span class="stat">' + (d.projects?.total || 0) + '</span><div class="stat-label">' + (d.projects?.active || 0) + ' active</div>';
        const ts = (d.tasks_by_status || []).map(t => '<span class="badge badge-blue" style="margin:.1rem">' + t.status + ': ' + t.count + '</span>').join(' ');
        document.getElementById('task-stats').innerHTML = ts || 'No tasks';
        log(d);
      } catch(e) { log('Error: ' + e.message); }
    }
    async function createSampleData() {
      log('Creating sample data...');
      const p1 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Website Redesign', description: 'Complete overhaul of company website' }) });
      const p2 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Mobile App', description: 'iOS and Android app development' }) });
      const pid1 = p1.project?.id, pid2 = p2.project?.id;
      if (!pid1) { log('Error creating projects: ' + JSON.stringify(p1)); return; }
      const tasks = [
        { project_id: pid1, title: 'Design mockups', priority: 'high', assigned_to: 'alice', description: 'Create Figma designs', status: 'in_progress' },
        { project_id: pid1, title: 'Set up CI/CD', priority: 'critical', assigned_to: 'bob', description: 'Configure GitHub Actions', due_date: '2025-02-01' },
        { project_id: pid1, title: 'Write unit tests', priority: 'medium', assigned_to: 'charlie', tags: ['testing','quality'] },
        { project_id: pid2, title: 'API integration', priority: 'high', assigned_to: 'alice', status: 'todo' },
        { project_id: pid2, title: 'Push notifications', priority: 'medium', assigned_to: 'dave', description: 'Firebase setup' },
        { project_id: pid2, title: 'App store submission', priority: 'low', due_date: '2025-03-15' },
      ];
      for (const t of tasks) await api('/api/tasks', { method: 'POST', body: JSON.stringify(t) });
      await api('/api/tasks/1/comments', { method: 'POST', body: JSON.stringify({ author: 'alice', body: 'Started working on this!' }) });
      log('Sample data created! Refreshing dashboard...');
      setTimeout(loadDashboard, 500);
    }
    async function testCache() { log(await api('/api/cache/stats')); }
    async function testSearch() { log(await api('/api/search?q=design')); }
    async function loadActivity() { log(await api('/api/activity?limit=20')); }
    loadDashboard();
  </script>
</body>
</html>`;
}
