#!/usr/bin/env node
/**
 * index.js — Entry Point
 * ----------------------
 * Enhance CLI — codebase-aware prompt enhancement powered by RAAG.
 *
 * Modes:
 *   enhance --init [path]          → Index project (auto-create KB + RAG in RAAG)
 *   enhance --set-project /path    → Save default project
 *   enhance --watch                → Watch for changes, auto-sync to RAAG
 *   enhance --status               → Show RAAG connection + project info
 *   enhance "raw prompt"           → Enhance using RAAG semantic search
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline';
import { buildIndex } from './indexer.js';
import { findRelevantFiles } from './matcher.js';
import { enhancePrompt } from './enhancer.js';
import { loadConfig, setProjectPath, getApiKey, setApiKey } from './config.js';
import { createClientWithKey, getRaagClient } from './raag-client.js';

// ─────────────────────────────────────────
// CLI Output Helpers
// ─────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log(chalk.bold.cyan('  ⚡ Enhance'));
  console.log(chalk.gray('  Codebase-aware prompt enhancement powered by RAAG\n'));
}

function printEnhanced(result, meta) {
  console.log('');
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.bold.green('  ✅ Enhanced Prompt'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log('');
  console.log(chalk.white(result.enhanced));
  console.log('');
  console.log(chalk.gray('─'.repeat(60)));
  if (meta) {
    console.log(
      chalk.gray(`  Files matched: ${meta.matchedCount} | `) +
      chalk.gray(`Source: RAAG | `) +
      chalk.gray(`Score: ${meta.topScore || 'N/A'}`)
    );
  }
  console.log('');
}

function printNeedsContext(question) {
  console.log('');
  console.log(chalk.yellow('  ⚠  Need more context'));
  console.log(chalk.yellow(`  → ${question}`));
  console.log('');
}

function printError(message) {
  console.log('');
  console.log(chalk.red(`  ✗ ${message}`));
  console.log('');
}

function printSearchResults(matchResult) {
  console.log('');
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.bold.cyan('  🔍 RAAG Search Results'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log('');

  if (!matchResult.files || matchResult.files.length === 0) {
    console.log(chalk.yellow('  No relevant files found.'));
  } else {
    for (const file of matchResult.files) {
      const score = file.score != null ? `${(file.score * 100).toFixed(0)}%` : 'N/A';
      console.log(chalk.green(`  [${score}] `) + chalk.white(file.path));
      if (file.snippet) {
        console.log(chalk.gray(`         ${file.snippet.slice(0, 120).replace(/\n/g, ' ')}...`));
      }
    }
  }

  console.log('');
  console.log(chalk.gray('─'.repeat(60)));
  const latency = matchResult.latencyMs != null ? `${matchResult.latencyMs}ms` : 'N/A';
  console.log(chalk.gray(`  Total: ${matchResult.matchedCount} chunks | Top score: ${matchResult.topScore} | Latency: ${latency}`));
  console.log('');
}

function printHelp() {
  console.log('');
  console.log(chalk.bold('  Usage:'));
  console.log('');
  console.log(chalk.cyan('  enhance --init [/path/to/project]'));
  console.log(chalk.gray('    → Index project: scan files, upload to RAAG, build search'));
  console.log('');
  console.log(chalk.cyan('  enhance your raw prompt'));
  console.log(chalk.gray('    → Enhance a prompt using RAAG semantic search + Claude'));
  console.log('');
  console.log(chalk.cyan('  enhance -s your query'));
  console.log(chalk.gray('    → Search only — return RAAG results instantly (no Claude)'));
  console.log('');
  console.log(chalk.cyan('  enhance --status'));
  console.log(chalk.gray('    → Show RAAG connection and project info'));
  console.log('');
}

// ─────────────────────────────────────────
// API Key Prompt (first run)
// ─────────────────────────────────────────

function askQuestion(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureApiKey() {
  if (getApiKey()) return true;

  console.log('');
  console.log(chalk.yellow('  No RAAG API key configured.'));
  console.log(chalk.gray('  Get your key at: https://raag.zoxa.ai → API Keys\n'));

  const key = await askQuestion(chalk.cyan('  RAAG API Key: '));

  if (!key) {
    printError('API key is required. Get one at https://raag.zoxa.ai');
    return false;
  }

  // Validate key
  const spinner = ora({ text: chalk.gray('Validating API key...'), color: 'cyan' }).start();

  try {
    const client = createClientWithKey(key);
    const ok = await client.ping();

    if (!ok) {
      spinner.fail(chalk.red('Invalid API key or RAAG server unreachable.'));
      console.log(chalk.gray('  Check your key at https://raag.zoxa.ai → API Keys\n'));
      return false;
    }

    setApiKey(key);
    spinner.succeed(chalk.green('Connected to RAAG'));
    console.log('');
    return true;
  } catch (err) {
    spinner.fail(chalk.red(`Connection failed: ${err.message}`));
    console.log(chalk.gray('  Check your key at https://raag.zoxa.ai → API Keys\n'));
    return false;
  }
}

// ─────────────────────────────────────────
// Mode: Set Project
// ─────────────────────────────────────────

function runSetProject(projectPath) {
  if (!projectPath || projectPath.startsWith('--')) {
    const config = loadConfig();
    console.log('');
    console.log(chalk.bold('  Current Config'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(chalk.gray('  Project : ') + chalk.white(config.projectPath || 'not set'));
    console.log(chalk.gray('  API Key : ') + chalk.white(config.apiKey ? '✅ configured' : '✗ not set'));
    console.log('');
    return;
  }

  const result = setProjectPath(projectPath);
  if (!result.success) {
    printError(result.error);
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green(`  ✅ Project saved: ${result.projectPath}`));
  console.log(chalk.gray(`  Now run: enhance --init`));
  console.log('');
}

// ─────────────────────────────────────────
// Mode: Init — Build Index + Upload to RAAG
// ─────────────────────────────────────────

async function runInit(args) {
  const force = args.includes('--force');
  const pathParts = args.filter(a => !a.startsWith('--'));
  let projectPath = pathParts.length > 0 ? pathParts.join(' ') : null;

  if (projectPath) {
    projectPath = path.resolve(projectPath);
  } else {
    // Auto-detect: use CWD
    projectPath = process.cwd();
  }

  if (!fs.existsSync(projectPath)) {
    printError(`Path does not exist: ${projectPath}`);
    process.exit(1);
  }

  // Save as default project
  setProjectPath(projectPath);

  console.log(chalk.bold(`\n  Indexing: ${projectPath}`));
  console.log(chalk.gray('  Scanning files → Claude summaries → Upload to RAAG\n'));

  await buildIndex(projectPath, { verbose: false, force });
}

// ─────────────────────────────────────────
// Mode: Enhance — Process Raw Prompt
// ─────────────────────────────────────────

async function runEnhance(rawPrompt, { searchOnly = false } = {}) {
  printBanner();

  // Project must be initialized — check CWD for .claude/raag.json
  const cwdRaagJson = path.join(process.cwd(), '.claude', 'raag.json');
  if (!fs.existsSync(cwdRaagJson)) {
    printError('No project found. Run `enhance --init` in your project directory first.');
    process.exit(1);
  }
  const projectPath = process.cwd();

  // Step 1: Find relevant files via RAAG
  const spinner = ora({
    text: chalk.gray('Searching codebase via RAAG...'),
    color: 'cyan',
  }).start();

  let matchResult;
  try {
    matchResult = await findRelevantFiles(rawPrompt, projectPath);
  } catch (err) {
    spinner.fail(chalk.red('Search failed: ' + err.message));
    process.exit(1);
  }

  if (!matchResult || matchResult.error) {
    spinner.fail(chalk.red(matchResult?.error || 'Search returned empty'));
    console.log(chalk.gray('\n  Run: enhance --init\n'));
    process.exit(1);
  }

  spinner.stop();

  // -s flag: return RAAG results immediately, no Claude
  if (searchOnly) {
    printSearchResults(matchResult);
    return;
  }

  const fileCount = Array.isArray(matchResult.files) ? matchResult.files.length : 0;
  const spinner2 = ora({
    text: chalk.gray(`Found ${fileCount} relevant files — enhancing prompt...`),
    color: 'cyan',
  }).start();

  // Step 2: Enhance with Claude
  const context = matchResult.context || 'No codebase context available.';
  const result = await enhancePrompt(rawPrompt, context);

  spinner2.stop();

  if (!result.success) {
    printError(`Enhancement failed: ${result.error}`);
    process.exit(1);
  }

  // Step 3: Output
  if (result.type === 'needs_context') {
    printNeedsContext(result.question);
  } else {
    printEnhanced(result, {
      matchedCount: matchResult.matchedCount,
      topScore: matchResult.topScore,
    });
  }
}

// ─────────────────────────────────────────
// Mode: Status
// ─────────────────────────────────────────

async function runStatus() {
  const config = loadConfig();

  console.log('');
  console.log(chalk.bold('  Enhance Status'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.gray('  API Key   : ') + chalk.white(config.apiKey ? '✅ configured' : '✗ not set'));
  console.log(chalk.gray('  Project   : ') + chalk.white(config.projectPath || 'not set'));

  if (config.projectPath && config.projects?.[config.projectPath]) {
    const proj = config.projects[config.projectPath];
    console.log(chalk.gray('  KB Name   : ') + chalk.white(proj.kbName || 'N/A'));
    console.log(chalk.gray('  KB ID     : ') + chalk.white(proj.kbId || 'N/A'));
    console.log(chalk.gray('  RAG ID    : ') + chalk.white(proj.ragId || 'N/A'));
  }

  // Test connection
  if (config.apiKey) {
    const client = getRaagClient(config.projectPath);
    if (client) {
      const ok = await client.ping();
      console.log(chalk.gray('  Connection: ') + (ok ? chalk.green('✅ connected') : chalk.red('✗ unreachable')));
    }
  }

  console.log('');
}

// ─────────────────────────────────────────
// Main
// ─────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args[0] === '--status') {
    await runStatus();
    process.exit(0);
  }

  if (args[0] === '--set-project') {
    const projectPath = args.slice(1).join(' ').trim();
    runSetProject(projectPath);
    process.exit(0);
  }

  // Everything below requires an API key
  const hasKey = await ensureApiKey();
  if (!hasKey) process.exit(1);

  if (args[0] === '--init') {
    await runInit(args.slice(1));
    process.exit(0);
  }


  // Default: enhance prompt
  const searchOnly = args.includes('-s');
  const rawPrompt = args.filter(a => a !== '-s').join(' ').trim();

  if (!rawPrompt) {
    printHelp();
    process.exit(0);
  }

  await runEnhance(rawPrompt, { searchOnly });
}

main().catch(err => {
  console.error(chalk.red(`\n  Fatal error: ${err.message}`));
  console.error(chalk.gray(err.stack));
  process.exit(1);
});
