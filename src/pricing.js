'use strict';

// Prices in USD per 1,000,000 tokens
// cache_write / cache_read are Anthropic prompt caching tiers
// Sources: platform.claude.com/docs/about-claude/pricing
// Note: Claude 4.5/4.6 Opus is the cheaper new generation ($5/$25), NOT the old 4.0 ($15/$75)
const PRICING = [
  // ── Anthropic Claude 4.6 ────────────────────────────────────────────────────
  { prefix: 'claude-opus-4-6',    provider: 'anthropic', input:  5.00, output: 25.00, cache_write:  6.25, cache_read: 0.50 },
  { prefix: 'claude-sonnet-4-6',  provider: 'anthropic', input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  { prefix: 'claude-haiku-4-6',   provider: 'anthropic', input:  1.00, output:  5.00, cache_write:  1.25, cache_read: 0.10 },

  // ── Anthropic Claude 4.5 ────────────────────────────────────────────────────
  { prefix: 'claude-opus-4-5',    provider: 'anthropic', input:  5.00, output: 25.00, cache_write:  6.25, cache_read: 0.50 },
  { prefix: 'claude-sonnet-4-5',  provider: 'anthropic', input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  { prefix: 'claude-haiku-4-5',   provider: 'anthropic', input:  1.00, output:  5.00, cache_write:  1.25, cache_read: 0.10 },

  // ── Anthropic Claude 4.0 / 4.1 (legacy expensive tier) ─────────────────────
  { prefix: 'claude-opus-4-1',    provider: 'anthropic', input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  { prefix: 'claude-opus-4',      provider: 'anthropic', input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },

  // ── Anthropic Claude 3.x ────────────────────────────────────────────────────
  { prefix: 'claude-opus-3',      provider: 'anthropic', input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  { prefix: 'claude-sonnet-3-7',  provider: 'anthropic', input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  { prefix: 'claude-sonnet-3-5',  provider: 'anthropic', input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  { prefix: 'claude-sonnet-3',    provider: 'anthropic', input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  { prefix: 'claude-haiku-3-5',   provider: 'anthropic', input:  0.80, output:  4.00, cache_write:  1.00, cache_read: 0.08 },
  { prefix: 'claude-haiku-3',     provider: 'anthropic', input:  0.25, output:  1.25, cache_write:  0.30, cache_read: 0.03 },

  // ── OpenAI GPT-4o family ────────────────────────────────────────────────────
  { prefix: 'gpt-4o-mini',        provider: 'openai', input:  0.15, output:  0.60, cache_write: null, cache_read: 0.075 },
  { prefix: 'gpt-4o',             provider: 'openai', input:  2.50, output: 10.00, cache_write: null, cache_read: 1.25 },
  { prefix: 'gpt-4-turbo',        provider: 'openai', input: 10.00, output: 30.00, cache_write: null, cache_read: null },
  { prefix: 'gpt-4',              provider: 'openai', input: 30.00, output: 60.00, cache_write: null, cache_read: null },
  { prefix: 'gpt-3.5-turbo',      provider: 'openai', input:  0.50, output:  1.50, cache_write: null, cache_read: null },

  // ── OpenAI o-series ─────────────────────────────────────────────────────────
  { prefix: 'o4-mini',            provider: 'openai', input:  1.10, output:  4.40, cache_write: null, cache_read: 0.275 },
  { prefix: 'o3-mini',            provider: 'openai', input:  1.10, output:  4.40, cache_write: null, cache_read: 0.55  },
  { prefix: 'o3',                 provider: 'openai', input: 10.00, output: 40.00, cache_write: null, cache_read: 2.50  },
  { prefix: 'o1-mini',            provider: 'openai', input:  3.00, output: 12.00, cache_write: null, cache_read: 1.50  },
  { prefix: 'o1',                 provider: 'openai', input: 15.00, output: 60.00, cache_write: null, cache_read: 7.50  },
];

// Strip trailing date suffixes like -20250929 or -2025-09-29 then fuzzy-prefix match
function lookupModel(model) {
  if (!model) return null;
  const normalised = model
    .toLowerCase()
    .replace(/-\d{8}$/, '')          // -20250929
    .replace(/-\d{4}-\d{2}-\d{2}$/, ''); // -2025-09-29

  // Exact prefix match (longest first — entries are ordered most-specific first)
  return PRICING.find(p => normalised.startsWith(p.prefix)) || null;
}

function computeCostUSD(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens) {
  const entry = lookupModel(model);
  if (!entry) return 0;

  const M = 1_000_000;
  let cost = 0;
  cost += (inputTokens         || 0) / M * entry.input;
  cost += (outputTokens        || 0) / M * entry.output;
  cost += (cacheCreationTokens || 0) / M * (entry.cache_write || 0);
  cost += (cacheReadTokens     || 0) / M * (entry.cache_read  || 0);
  return cost;
}

function inferProvider(model) {
  if (!model) return 'unknown';
  const entry = lookupModel(model);
  if (entry) return entry.provider;
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  return 'unknown';
}

module.exports = { computeCostUSD, inferProvider, lookupModel, PRICING };
