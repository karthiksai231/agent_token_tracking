'use strict';

const express = require('express');
const path    = require('path');
const os      = require('os');
const { loadAllEvents } = require('./parser');

// ── In-memory store ───────────────────────────────────────────────────────────
let cachedEvents   = null;
let claudeDirGlobal = null;

function getEvents() {
  if (!cachedEvents) cachedEvents = loadAllEvents(claudeDirGlobal);
  return cachedEvents;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function filterByDate(events, from, to) {
  if (!from && !to) return events;
  const hi = to ? to + 'T23:59:59' : null;
  return events.filter(e => {
    if (from && e.occurred_at < from) return false;
    if (hi   && e.occurred_at > hi)   return false;
    return true;
  });
}

// ── Aggregations ──────────────────────────────────────────────────────────────
function computeOverview(events, from, to) {
  const filtered = filterByDate(events, from, to);

  const totals = filtered.reduce((acc, e) => {
    acc.total_requests++;
    acc.input_tokens          += e.input_tokens;
    acc.output_tokens         += e.output_tokens;
    acc.cache_creation_tokens += e.cache_creation_tokens;
    acc.cache_read_tokens     += e.cache_read_tokens;
    acc.cost_usd              += e.cost_usd;
    return acc;
  }, { total_requests: 0, input_tokens: 0, output_tokens: 0,
       cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0 });

  const modelMap = new Map();
  for (const e of filtered) {
    if (!modelMap.has(e.model)) {
      modelMap.set(e.model, {
        model: e.model, provider: e.provider, requests: 0,
        input_tokens: 0, output_tokens: 0,
        cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0,
      });
    }
    const m = modelMap.get(e.model);
    m.requests++;
    m.input_tokens          += e.input_tokens;
    m.output_tokens         += e.output_tokens;
    m.cache_creation_tokens += e.cache_creation_tokens;
    m.cache_read_tokens     += e.cache_read_tokens;
    m.cost_usd              += e.cost_usd;
  }

  const byModel = [...modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd);
  return { totals, byModel };
}

function computeTimeseries(events, from, to) {
  const filtered = filterByDate(events, from, to);
  const map = new Map();
  for (const e of filtered) {
    const date = e.occurred_at.slice(0, 10);
    const key  = `${date}|${e.model}`;
    if (!map.has(key)) {
      map.set(key, { date, model: e.model, provider: e.provider, cost_usd: 0, requests: 0 });
    }
    const r = map.get(key);
    r.cost_usd += e.cost_usd;
    r.requests++;
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function computeTopSessions(events, from, to, limit = 20) {
  const filtered = filterByDate(events, from, to);
  const map = new Map();
  for (const e of filtered) {
    const key = e.session_id || 'unknown';
    if (!map.has(key)) {
      map.set(key, {
        session_id:   e.session_id,
        project_path: e.project_path,
        requests: 0,
        input_tokens: 0, output_tokens: 0,
        cache_creation_tokens: 0, cache_read_tokens: 0,
        cost_usd: 0,
        started_at: e.occurred_at,
        ended_at:   e.occurred_at,
        models: new Set(),
      });
    }
    const s = map.get(key);
    s.requests++;
    s.input_tokens          += e.input_tokens;
    s.output_tokens         += e.output_tokens;
    s.cache_creation_tokens += e.cache_creation_tokens;
    s.cache_read_tokens     += e.cache_read_tokens;
    s.cost_usd              += e.cost_usd;
    if (e.occurred_at < s.started_at) s.started_at = e.occurred_at;
    if (e.occurred_at > s.ended_at)   s.ended_at   = e.occurred_at;
    s.models.add(e.model);
  }
  return [...map.values()]
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, limit)
    .map(s => ({ ...s, models: [...s.models].join(',') }));
}

function computeEvents(events, { page = 1, limit = 50, model, provider, from, to, session_id, sort } = {}) {
  let f = events;
  if (from)       f = f.filter(e => e.occurred_at >= from);
  if (to)         f = f.filter(e => e.occurred_at <= to + 'T23:59:59');
  if (model)      f = f.filter(e => e.model      === model);
  if (provider)   f = f.filter(e => e.provider   === provider);
  if (session_id) f = f.filter(e => e.session_id === session_id);

  // Sort: by cost desc or newest first (default)
  if (sort === 'cost') {
    f = [...f].sort((a, b) => b.cost_usd - a.cost_usd);
  } else {
    f = [...f].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  }

  const total  = f.length;
  const offset = (page - 1) * limit;
  return { rows: f.slice(offset, offset + limit), total, page, limit, pages: Math.ceil(total / limit) };
}

function computeProjects(events, from, to) {
  const filtered = filterByDate(events, from, to);
  const map = new Map();
  for (const e of filtered) {
    const key = e.project_path || 'Unknown';
    if (!map.has(key)) {
      map.set(key, { project_path: key, requests: 0, cost_usd: 0,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
        cache_creation_tokens: 0, sessions: new Set() });
    }
    const p = map.get(key);
    p.requests++;
    p.cost_usd              += e.cost_usd;
    p.input_tokens          += e.input_tokens;
    p.output_tokens         += e.output_tokens;
    p.cache_read_tokens     += e.cache_read_tokens;
    p.cache_creation_tokens += e.cache_creation_tokens;
    if (e.session_id) p.sessions.add(e.session_id);
  }
  return [...map.values()]
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .map(p => ({ ...p, sessions: p.sessions.size }));
}

// ── Express app ───────────────────────────────────────────────────────────────
function createApp(options = {}) {
  claudeDirGlobal = options.claudeDir || path.join(os.homedir(), '.claude');

  // Load on startup
  try {
    cachedEvents = loadAllEvents(claudeDirGlobal);
    console.log(`[llm-spend] Loaded ${cachedEvents.length} events from ${claudeDirGlobal}`);
  } catch (err) {
    console.error('[llm-spend] Error loading events:', err.message);
    cachedEvents = [];
  }

  const app = express();
  app.use(express.json());

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // Overview
  app.get('/api/overview', (req, res) => {
    try {
      const { from, to } = req.query;
      res.json(computeOverview(getEvents(), from, to));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Timeseries
  app.get('/api/timeseries', (req, res) => {
    try {
      const { from, to } = req.query;
      res.json(computeTimeseries(getEvents(), from, to));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Sessions
  app.get('/api/sessions', (req, res) => {
    try {
      const { from, to, limit } = req.query;
      res.json(computeTopSessions(getEvents(), from, to, limit ? parseInt(limit) : 20));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Events (paginated explorer, supports sort=cost)
  app.get('/api/events', (req, res) => {
    try {
      const { page, limit, model, provider, from, to, session_id, sort } = req.query;
      res.json(computeEvents(getEvents(), {
        page:  page  ? parseInt(page)  : 1,
        limit: limit ? parseInt(limit) : 50,
        model, provider, from, to, session_id, sort,
      }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Models list
  app.get('/api/models', (req, res) => {
    try {
      const models = [...new Set(getEvents().map(e => e.model))].sort();
      res.json(models);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Refresh — re-read from disk
  app.post('/api/refresh', (req, res) => {
    try {
      cachedEvents = loadAllEvents(claudeDirGlobal);
      res.json({ events: cachedEvents.length, ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Projects breakdown
  app.get('/api/projects', (req, res) => {
    try {
      const { from, to } = req.query;
      res.json(computeProjects(getEvents(), from, to));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Settings (read-only info)
  app.get('/api/settings', (req, res) => {
    res.json({ claude_data_dir: claudeDirGlobal });
  });

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

function startServer(options = {}) {
  const { port = 3000, open: openBrowser = true, claudeDir } = options;
  const app = createApp({ claudeDir });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', async () => {
      const url = `http://localhost:${port}`;
      console.log(`llm-spend running at ${url}`);
      if (openBrowser) {
        const open_ = await import('open');
        open_.default(url).catch(() => {});
      }
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { createApp, startServer };
