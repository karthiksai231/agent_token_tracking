'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { computeCostUSD, inferProvider } = require('./pricing');

/**
 * Read all Claude Code JSONL logs from ~/.claude and return an array of events.
 * No database — pure in-memory. Dedups by request_id (msg.id).
 *
 * @param {string} [claudeDir]
 * @returns {Array} events
 */
function loadAllEvents(claudeDir) {
  claudeDir = claudeDir || path.join(os.homedir(), '.claude');

  if (!fs.existsSync(claudeDir)) return [];

  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const seen   = new Set(); // dedup by request_id
  const events = [];

  const slugDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(projectsDir, d.name));

  for (const slugDir of slugDirs) {
    // Only read top-level *.jsonl files in the slug directory (no subdirs/subagents).
    // This matches the reference dashboard behaviour and avoids double-counting.
    let projectPath = null;

    // sessions-index.json provides the canonical projectPath for each file
    const projectPathMap = new Map();
    const indexPath = path.join(slugDir, 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        for (const entry of (idx.entries || [])) {
          if (entry.fullPath) {
            projectPathMap.set(path.basename(entry.fullPath), entry.projectPath || null);
          }
        }
        // Use first entry's projectPath as the slug-level fallback
        if (idx.entries?.[0]?.projectPath) projectPath = idx.entries[0].projectPath;
      } catch { /* skip bad index */ }
    }

    let entries;
    try { entries = fs.readdirSync(slugDir, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const fp = path.join(slugDir, ent.name);
      const proj = projectPathMap.get(ent.name) ?? projectPath;
      parseJSONL(fp, proj, seen, events);
    }
  }

  // Sort ascending by timestamp
  events.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
  return events;
}

function extractHumanText(content) {
  if (!content) return null;
  // Plain string → direct human message
  if (typeof content === 'string') return content.trim().slice(0, 400) || null;
  // Array → look for text items that are NOT tool_result
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text.trim());
      }
    }
    const joined = parts.join(' ').trim();
    return joined ? joined.slice(0, 400) : null;
  }
  return null;
}

function parseJSONL(filePath, projectPath, seen, events) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return; }

  let lastHumanText = null; // last non-tool_result user message text

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    // Track last human-written text (not tool results)
    if (obj.type === 'user') {
      const msg = obj.message;
      const text = msg ? extractHumanText(msg.content) : null;
      if (text) lastHumanText = text;
      continue;
    }

    // Only assistant messages with usage data
    if (obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg || !msg.usage) continue;

    const requestId = msg.id;
    if (!requestId) continue;

    // Dedup
    if (seen.has(requestId)) continue;
    seen.add(requestId);

    const model = msg.model;
    if (!model || model === '<synthetic>') continue;

    const usage = msg.usage;
    const inputTokens         = usage.input_tokens                || 0;
    const outputTokens        = usage.output_tokens               || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens     = usage.cache_read_input_tokens     || 0;

    events.push({
      provider:              inferProvider(model),
      model,
      session_id:            obj.sessionId   || null,
      project_path:          projectPath || obj.cwd || null,
      request_id:            requestId,
      occurred_at:           obj.timestamp   || new Date().toISOString(),
      input_tokens:          inputTokens,
      output_tokens:         outputTokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens:     cacheReadTokens,
      cost_usd:              computeCostUSD(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens),
      source:                obj.isSidechain ? 'claude-code-subagent' : 'claude-code',
      prompt_text:           lastHumanText || null,
    });
  }
}

module.exports = { loadAllEvents };
