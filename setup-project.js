#!/usr/bin/env node
/**
 * setup-project.js
 * ----------------
 * Adds the /enhance slash command to any project.
 * 
 * Run from inside prompt-enhancer:
 *   node setup-project.js /path/to/your/project
 * 
 * Or via enhance CLI:
 *   enhance --setup /path/to/your/project
 * 
 * What it does:
 *   1. Creates .claude/commands/enhance.md in the target project
 *   2. Creates CLAUDE.md in the target project root
 *   3. Sets that project as default in config
 *   4. Runs the indexer to build context_index.json
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────
// Source files (from prompt-enhancer folder)
// ─────────────────────────────────────────

const ENHANCE_COMMAND_SRC = path.join(__dirname, '.claude', 'commands', 'enhance.md');
const CLAUDE_MD_SRC = path.join(__dirname, 'CLAUDE.md');

// ─────────────────────────────────────────
// Setup a project
// ─────────────────────────────────────────

export async function setupProject(projectPath) {
  const absolutePath = path.resolve(projectPath);

  // Validate
  if (!fs.existsSync(absolutePath)) {
    console.log(chalk.red(`\n  ✗ Path not found: ${absolutePath}\n`));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold.cyan('  ⚡ Setting up Prompt Enhancer'));
  console.log(chalk.gray(`  Project: ${absolutePath}\n`));

  // 1. Create .claude/commands/ directory
  const claudeCommandsDir = path.join(absolutePath, '.claude', 'commands');
  fs.mkdirSync(claudeCommandsDir, { recursive: true });
  console.log(chalk.gray('  ✓ Created .claude/commands/'));

  // 2. Copy enhance.md command
  const enhanceMdDest = path.join(claudeCommandsDir, 'enhance.md');
  fs.copyFileSync(ENHANCE_COMMAND_SRC, enhanceMdDest);
  console.log(chalk.gray('  ✓ Added .claude/commands/enhance.md'));

  // 3. Create CLAUDE.md (don't overwrite if exists)
  const claudeMdDest = path.join(absolutePath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdDest)) {
    fs.copyFileSync(CLAUDE_MD_SRC, claudeMdDest);
    console.log(chalk.gray('  ✓ Created CLAUDE.md'));
  } else {
    console.log(chalk.gray('  ⏭  CLAUDE.md already exists — skipped'));
  }

  // 4. Set as default project
  const { setProjectPath } = await import('./config.js');
  const result = setProjectPath(absolutePath);
  if (result.success) {
    console.log(chalk.gray('  ✓ Set as default project'));
  }

  console.log('');
  console.log(chalk.bold.green('  ✅ Project setup complete'));
  console.log('');
  console.log(chalk.gray('  Next steps:'));
  console.log(chalk.cyan('  1. enhance --init') + chalk.gray('          ← build codebase index'));
  console.log(chalk.cyan('  2. cd ' + absolutePath));
  console.log(chalk.cyan('  3. claude') + chalk.gray('                   ← open Claude Code'));
  console.log(chalk.cyan('  4. /enhance "your prompt"') + chalk.gray('  ← use it'));
  console.log('');
}