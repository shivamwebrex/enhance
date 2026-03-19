#!/usr/bin/env node
/**
 * index.js — Entry Point
 * ----------------------
 * Modes:
 * 
 *   enhance --set-project /path/to/project   → save default project (once)
 *   enhance --init                            → index saved project
 *   enhance --init /path/to/project          → index specific project + save it
 *   enhance "raw prompt"                     → enhance using saved project
 */

import chalk from 'chalk';
import ora from 'ora';
import { buildIndex } from './indexer.js';
import { findRelevantFiles } from './matcher.js';
import { enhancePrompt } from './enhancer.js';
import { loadConfig, saveConfig, setProjectPath, getProjectPath } from './config.js';
import { setupProject } from './setup-project.js';

// ─────────────────────────────────────────
// CLI Output Helpers
// ─────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log(chalk.bold.cyan('  ⚡ Prompt Enhancer'));
  console.log(chalk.gray('  Codebase-aware prompt enhancement\n'));
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
      chalk.gray(`Semantic: ${meta.usedSemantics ? '✅' : '⚠ keyword only'} | `) +
      chalk.gray(`Indexed: ${meta.totalIndexed} files`)
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

function printConfig(config) {
  console.log('');
  console.log(chalk.bold('  Current Config'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.gray('  Project : ') + chalk.white(config.projectPath || 'not set'));
  console.log(chalk.gray('  Updated : ') + chalk.white(config.updatedAt || 'never'));
  console.log('');
}

function printHelp() {
  console.log('');
  console.log(chalk.bold('  Usage:'));
  console.log('');
  console.log(chalk.cyan('  enhance --set-project /path/to/project'));
  console.log(chalk.gray('    → Save your default project path (run once)'));
  console.log('');
  console.log(chalk.cyan('  enhance --init'));
  console.log(chalk.gray('    → Index your saved project'));
  console.log('');
  console.log(chalk.cyan('  enhance --init /path/to/project'));
  console.log(chalk.gray('    → Index a specific project and save it as default'));
  console.log('');
  console.log(chalk.cyan('  enhance "your raw prompt"'));
  console.log(chalk.gray('    → Enhance a prompt using your indexed project'));
  console.log('');
  console.log(chalk.cyan('  enhance --config'));
  console.log(chalk.gray('    → Show current saved config'));
  console.log('');
  console.log(chalk.cyan('  enhance --init --force'));
  console.log(chalk.gray('    → Force rebuild index from scratch'));
  console.log('');
  console.log(chalk.cyan('  enhance --setup /path/to/project'));
  console.log(chalk.gray('    → Add /enhance slash command to a project (one time)'));
  console.log('');
}

// ─────────────────────────────────────────
// Mode: Set Project
// ─────────────────────────────────────────

function runSetProject(projectPath) {
  if (!projectPath || projectPath.startsWith('--')) {
    const config = loadConfig();
    printConfig(config);
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
// Mode: Init — Build Index
// ─────────────────────────────────────────

async function runInit(args) {
  const force = args.includes('--force');
  // Join all non-flag args to handle paths with spaces
  // e.g. C:\Users\shivam juyal\Downloads\project → correctly joined
  const pathParts = args.filter(a => !a.startsWith('--'));
  let projectPath = pathParts.length > 0 ? pathParts.join(' ') : null;

  if (projectPath) {
    // Path provided — save as default
    const result = setProjectPath(projectPath);
    if (!result.success) {
      printError(result.error);
      process.exit(1);
    }
    projectPath = result.projectPath;
    console.log(chalk.gray(`\n  Saved as default project: ${projectPath}`));
  } else {
    // Use saved config
    projectPath = getProjectPath();
    if (!projectPath) {
      printError('No project set. Run: enhance --set-project /path/to/project');
      process.exit(1);
    }
  }

  console.log(chalk.bold(`\n  Indexing: ${projectPath}`));
  console.log(chalk.gray('  This may take a few minutes on first run...\n'));

  await buildIndex(projectPath, { verbose: false, force });
}

// ─────────────────────────────────────────
// Mode: Enhance — Process Raw Prompt
// ─────────────────────────────────────────

async function runEnhance(rawPrompt) {
  printBanner();

  const projectPath = getProjectPath();
  if (!projectPath) {
    printError('No project set.');
    console.log(chalk.gray('  Step 1: enhance --set-project /path/to/project'));
    console.log(chalk.gray('  Step 2: enhance --init'));
    console.log(chalk.gray('  Step 3: enhance "your prompt"\n'));
    process.exit(1);
  }

  // Step 1: Find relevant files
  const spinner = ora({
    text: chalk.gray('Searching codebase...'),
    color: 'cyan',
  }).start();

  let matchResult;
  try {
    matchResult = await findRelevantFiles(rawPrompt);
  } catch (err) {
    spinner.fail(chalk.red('Matcher failed: ' + err.message));
    console.error(chalk.gray(err.stack));
    process.exit(1);
  }

  // Guard: ensure matchResult has expected shape
  if (!matchResult) {
    spinner.fail(chalk.red('Matcher returned empty result'));
    process.exit(1);
  }

  if (matchResult.error) {
    spinner.fail(chalk.red(matchResult.error));
    console.log(chalk.gray('\n  Run: enhance --init\n'));
    process.exit(1);
  }

  const fileCount = Array.isArray(matchResult.files) ? matchResult.files.length : 0;

  spinner.text = chalk.gray(
    `Found ${fileCount} relevant files — generating enhanced prompt...`
  );

  // Step 2: Enhance with Claude
  const context = matchResult.context || 'No codebase context available.';
  const result = await enhancePrompt(rawPrompt, context);

  spinner.stop();

  if (!result.success) {
    printError(`Enhancement failed: ${result.error}`);
    console.log(chalk.gray('  Check Claude Code is working: claude -p "hello"'));
    process.exit(1);
  }

  // Step 3: Output
  if (result.type === 'needs_context') {
    printNeedsContext(result.question);
  } else {
    printEnhanced(result, {
      matchedCount: matchResult.matchedCount,
      usedSemantics: matchResult.usedSemantics,
      totalIndexed: matchResult.totalIndexed,
    });
  }
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

  if (args[0] === '--config') {
    const config = loadConfig();
    printConfig(config);
    process.exit(0);
  }

  if (args[0] === '--set-project') {
    const projectPath = args.slice(1).join(' ').trim(); runSetProject(projectPath);
    process.exit(0);
  }

  if (args[0] === '--init') {
    await runInit(args.slice(1));
    process.exit(0);
  }


  // --setup — add /enhance command to a project
  if (args[0] === '--setup') {
    const projectPath = args.slice(1).join(' ').trim() || '.';
    await setupProject(projectPath);
    process.exit(0);
  }

  const rawPrompt = args.join(' ').trim();
  await runEnhance(rawPrompt);
}

main().catch(err => {
  console.error(chalk.red(`
  Fatal error: ${err.message}`));
  console.error(chalk.gray(err.stack));
  process.exit(1);
});