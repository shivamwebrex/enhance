/**
 * watcher.js
 * ----------
 * Watches the project directory for file changes.
 * On structural change → re-generates summary → syncs to RAAG.
 *
 * Uses chokidar for cross-platform file watching.
 * Run: enhance --watch
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getProjectPath, getProjectRaag } from './config.js';
import { extractFileStructure, getSummaryFromClaude } from './indexer.js';
import { getRaagClient } from './raag-client.js';

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const WATCH_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.py', '.go', '.rs', '.java', '.rb'];

const SKIP_DIRS = [
  'node_modules', '.git', 'dist', 'build',
  '.next', 'coverage', '.cache', 'public',
  '.vscode', '.idea', '.pm2', '__pycache__',
  '.venv', 'venv', 'target',
];

const DEBOUNCE_MS = 1500;
const MAX_FILE_SIZE_KB = 100;
const CACHE_FILENAME = '.enhance-cache.json';

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function shouldWatch(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!WATCH_EXTENSIONS.includes(ext)) return false;

  const normalized = filePath.replace(/\\/g, '/');
  if (SKIP_DIRS.some(dir => normalized.includes(`/${dir}/`))) return false;

  try {
    if (fs.existsSync(filePath)) {
      const sizeKB = fs.statSync(filePath).size / 1024;
      if (sizeKB > MAX_FILE_SIZE_KB) return false;
    }
  } catch {
    return false;
  }

  return true;
}

function extractStructureSignature(content) {
  const lines = content.split('\n');
  const structural = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.match(/^(export\s+)?(async\s+)?function\s+\w+/)) structural.push(t.slice(0, 60));
    if (t.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/)) structural.push(t.slice(0, 60));
    if (t.startsWith('import ')) structural.push(t.slice(0, 60));
    if (t.startsWith('export ')) structural.push(t.slice(0, 60));
    if (t.match(/^(export\s+)?class\s+\w+/)) structural.push(t.slice(0, 60));
  }

  return structural.join('|');
}

function loadCache(projectPath) {
  const cachePath = path.join(projectPath, CACHE_FILENAME);
  if (!fs.existsSync(cachePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(projectPath, cache) {
  fs.writeFileSync(path.join(projectPath, CACHE_FILENAME), JSON.stringify(cache, null, 2));
}

function isSignificantChange(filePath, projectPath) {
  const relativePath = path.relative(projectPath, filePath);

  try {
    const newContent = fs.readFileSync(filePath, 'utf8');
    const newSig = extractStructureSignature(newContent);

    const cache = loadCache(projectPath);
    const oldEntry = cache[relativePath];

    if (oldEntry && oldEntry.structureSig === newSig) {
      return false; // cosmetic change
    }

    return true;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────
// Re-index + sync a single file to RAAG
// ─────────────────────────────────────────

async function reindexFile(filePath, projectPath, eventType) {
  const relativePath = path.relative(projectPath, filePath);
  const raag = getRaagClient(projectPath);

  // Handle deleted files
  if (eventType === 'unlink') {
    try {
      const cache = loadCache(projectPath);
      if (cache[relativePath]) {
        delete cache[relativePath];
        saveCache(projectPath, cache);
        console.log(chalk.gray(`  🗑  Removed: ${relativePath}`));
      }

      if (raag) {
        await raag.triggerRebuild();
        console.log(chalk.gray(`  🔄 RAAG rebuild triggered`));
      }
    } catch (err) {
      console.log(chalk.red(`  ✗ Delete handling failed: ${err.message}`));
    }
    return;
  }

  // Check if change is significant
  if (!isSignificantChange(filePath, projectPath)) {
    console.log(chalk.gray(`  ⏭  Cosmetic change — skipped: ${relativePath}`));
    return;
  }

  // Re-index this file
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stats = fs.statSync(filePath);

    // Extract structure
    const extracted = extractFileStructure(relativePath, content);

    // Get summary from Claude
    const { summary } = await getSummaryFromClaude(extracted);

    // Update local cache
    const cache = loadCache(projectPath);
    cache[relativePath] = {
      mtime: stats.mtimeMs,
      structureSig: [...extracted.functions, ...extracted.imports, ...extracted.exports].join('|'),
      summary,
    };
    saveCache(projectPath, cache);

    console.log(chalk.green(`  ✅ Re-indexed: ${relativePath}`));

    // Sync to RAAG with summary prepended
    if (raag) {
      const contentWithSummary = `<!-- RAAG-SUMMARY: ${summary} | File: ${relativePath} -->\n${content}`;
      try {
        await raag.syncFiles([{ path: relativePath, content: contentWithSummary }]);
        console.log(chalk.gray(`  🔄 Synced to RAAG`));
      } catch (err) {
        console.log(chalk.yellow(`  ⚠  RAAG sync failed: ${err.message}`));
      }
    } else {
      console.log(chalk.yellow(`  ⚠  RAAG not configured — file indexed locally only`));
    }
  } catch (err) {
    console.log(chalk.red(`  ✗ Re-index failed: ${relativePath} — ${err.message}`));
  }
}

// ─────────────────────────────────────────
// Start Watcher
// ─────────────────────────────────────────

export async function startWatcher() {
  const projectPath = getProjectPath();

  if (!projectPath) {
    console.log(chalk.red('\n  ✗ No project set.'));
    console.log(chalk.gray('  Run: enhance --set-project /path/to/project\n'));
    process.exit(1);
  }

  if (!fs.existsSync(projectPath)) {
    console.log(chalk.red(`\n  ✗ Project not found: ${projectPath}\n`));
    process.exit(1);
  }

  // Check project is indexed
  const projConfig = getProjectRaag(projectPath);
  if (!projConfig) {
    console.log(chalk.yellow('\n  ⚠  Project not indexed yet.'));
    console.log(chalk.gray('  Run: enhance --init\n'));
    process.exit(1);
  }

  let chokidar;
  try {
    chokidar = (await import('chokidar')).default;
  } catch {
    console.log(chalk.red('\n  ✗ chokidar not installed.'));
    console.log(chalk.gray('  Run: npm install chokidar\n'));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold.cyan('  👁  Enhance — Watch Mode'));
  console.log(chalk.gray(`  Watching: ${projectPath}`));
  console.log(chalk.gray(`  KB: ${projConfig.kbName} | RAG: ${projConfig.ragId?.slice(0, 8)}...`));
  console.log(chalk.gray('  Changes auto-sync to RAAG'));
  console.log(chalk.gray('  Press Ctrl+C to stop\n'));

  const debounceMap = new Map();

  const ignored = [
    ...SKIP_DIRS.map(d => `**/${d}/**`),
    '**/*.log',
    '**/.enhance-cache.json',
    '**/.git/**',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/*.tmp',
    '**/*.temp',
  ];

  const watcher = chokidar.watch(projectPath, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  function handleEvent(filePath, eventType) {
    if (!shouldWatch(filePath)) return;

    const relativePath = path.relative(projectPath, filePath);

    if (debounceMap.has(filePath)) {
      clearTimeout(debounceMap.get(filePath));
    }

    const timer = setTimeout(async () => {
      debounceMap.delete(filePath);

      const time = new Date().toLocaleTimeString();
      const icon = eventType === 'unlink' ? '🗑' : eventType === 'add' ? '➕' : '✏️ ';
      console.log(chalk.gray(`\n  [${time}] ${icon} ${relativePath}`));

      await reindexFile(filePath, projectPath, eventType);
    }, DEBOUNCE_MS);

    debounceMap.set(filePath, timer);
  }

  watcher.on('change', filePath => handleEvent(filePath, 'change'));
  watcher.on('add', filePath => handleEvent(filePath, 'add'));
  watcher.on('unlink', filePath => handleEvent(filePath, 'unlink'));

  watcher.on('error', err => {
    console.log(chalk.red(`\n  Watch error: ${err.message}`));
  });

  watcher.on('ready', () => {
    console.log(chalk.green('  ✅ Watching for changes...\n'));
  });

  process.on('SIGINT', () => {
    console.log(chalk.gray('\n\n  Stopping watcher...\n'));
    watcher.close();
    process.exit(0);
  });
}
