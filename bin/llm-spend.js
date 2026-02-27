#!/usr/bin/env node
'use strict';

const { startServer } = require('../src/server');
const os   = require('os');
const path = require('path');

const args = process.argv.slice(2);

function getFlag(flag, defaultVal) {
  const i = args.indexOf(flag);
  return i === -1 ? defaultVal : args[i + 1];
}
function hasFlag(flag) { return args.includes(flag); }

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
llm-spend — local LLM cost dashboard for Claude Code

Usage: llm-spend [options]
       npx llm-spend [options]

Options:
  -p, --port <number>      Port to listen on (default: 3000)
  --no-open                Do not open browser automatically
  --claude-dir <path>      Path to Claude data directory (default: ~/.claude)
  -V, --version            Output version number
  -h, --help               Display this help

Examples:
  npx llm-spend                  # open dashboard on port 3000
  npx llm-spend --port 4000      # use a different port
  npx llm-spend --no-open        # start without opening browser
`);
  process.exit(0);
}

if (hasFlag('--version') || hasFlag('-V')) {
  console.log(require('../package.json').version);
  process.exit(0);
}

const portStr = getFlag('--port', null) || getFlag('-p', '3000');
const port    = parseInt(portStr, 10);
if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${portStr}`);
  process.exit(1);
}

const openBrowser = !hasFlag('--no-open');
const claudeDir   = getFlag('--claude-dir', path.join(os.homedir(), '.claude'));

startServer({ port, open: openBrowser, claudeDir })
  .then(server => {
    function shutdown(signal) {
      console.log(`\n[${signal}] Shutting down…`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 3000);
    }
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  })
  .catch(err => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
