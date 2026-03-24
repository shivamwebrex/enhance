/**
 * watcher.js
 * ----------
 * Watches the project directory for file changes.
 * On any change — re-indexes only that file (incremental).
 *
 * Uses chokidar for cross-platform file watching.
 * Install: npm install chokidar
 *
 * Run: enhance --watch
 * Runs in foreground. Ctrl+C to stop.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getProjectPath } from './config.js';
import { extractFileStructure, getSummaryFromClaude } from './indexer.js';

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const WATCH_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.py'];

const SKIP_DIRS = [
  'node_modules', '.git', 'dist', 'build',
  '.next', 'coverage', '.cache', 'public',
  '.vscode', '.idea', '.pm2'
];

// Wait 1.5s after last change before re-indexing
// Prevents multiple spawns when editor auto-formats on save
const DEBOUNCE_MS = 1500;

const MAX_FILE_SIZE_KB = 100;

// ─────────────────────────────────────────
// Should this file be watched?
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

// ─────────────────────────────────────────
// Check if change is semantically significant
//
// Cosmetic changes (log messages, comments, strings)
// don't affect what a file does — skip re-indexing
// Only re-index if structure changed:
//   functions, imports, exports, class definitions
// ─────────────────────────────────────────

function extractStructureSignature(content) {
  const lines = content.split('\n');
  const structural = [];

  for (const line of lines) {
    const t = line.trim();
    // Function declarations
    if (t.match(/^(export\s+)?(async\s+)?function\s+\w+/)) structural.push(t.slice(0, 60));
    // Arrow functions assigned to const
    if (t.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/)) structural.push(t.slice(0, 60));
    // Import statements
    if (t.startsWith('import ')) structural.push(t.slice(0, 60));
    // Export statements
    if (t.startsWith('export ')) structural.push(t.slice(0, 60));
    // Class definitions
    if (t.match(/^(export\s+)?class\s+\w+/)) structural.push(t.slice(0, 60));
  }

  return structural.join('|');
}

function isSignificantChange(filePath, projectPath) {
  const INDEX_PATH = path.join(projectPath, 'context_index.json');
  const relativePath = path.relative(projectPath, filePath);

  try {
    // Read new content
    const newContent = fs.readFileSync(filePath, 'utf8');
    const newSig = extractStructureSignature(newContent);

    // Read old signature from index
    if (fs.existsSync(INDEX_PATH)) {
      const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      const oldEntry = index[relativePath];

      if (oldEntry && oldEntry.structureSig) {
        // Compare signatures — if same, change is cosmetic
        if (oldEntry.structureSig === newSig) {
          return false; // cosmetic change — skip
        }
      }
    }

    return true; // new file or structure changed — re-index
  } catch {
    return true; // if anything fails, re-index to be safe
  }
}

// ─────────────────────────────────────────
// Re-index a single changed file
// ─────────────────────────────────────────

async function reindexFile(filePath, projectPath, eventType) {
  const relativePath = path.relative(projectPath, filePath);
  const INDEX_PATH = path.join(projectPath, 'context_index.json');

  // Handle deleted files — remove from index immediately
  if (eventType === 'unlink') {
    try {
      if (fs.existsSync(INDEX_PATH)) {
        const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
        if (index[relativePath]) {
          delete index[relativePath];
          fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
          console.log(chalk.gray(`  🗑  Removed from index: ${relativePath}`));
        }
      }
    } catch (err) {
      console.log(chalk.red(`  ✗ Failed to remove: ${relativePath} — ${err.message}`));
    }
    return;
  }

  // Check if change is significant enough to re-index
  if (!isSignificantChange(filePath, projectPath)) {
    console.log(chalk.gray(`  ⏭  Cosmetic change — skipping re-index: ${relativePath}`));
    return;
  }

  // Structural change — re-index just this one file directly
  // No full project scan — reads one file, spawns one Claude, updates one entry
  try {
    const INDEX_PATH = path.join(projectPath, 'context_index.json');
    const content = fs.readFileSync(filePath, 'utf8');
    const stats = fs.statSync(filePath);

    // Extract structure (instant, no Claude)
    const extracted = extractFileStructure(relativePath, content);

    // Get summary from Claude (one spawn, ~3-5s)
    const { summary, keywords } = await getSummaryFromClaude(extracted);

    // Build updated entry
    const entry = {
      path: relativePath,
      summary,
      keywords,
      functions: extracted.functions,
      imports: extracted.imports,
      exports: extracted.exports,
      structureSig: [...extracted.functions, ...extracted.imports, ...extracted.exports].join('|'),
      mtime: stats.mtimeMs,
      indexed_at: new Date().toISOString(),
    };

    // Load index, update just this entry, save
    let index = {};
    if (fs.existsSync(INDEX_PATH)) {
      index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    }
    index[relativePath] = entry;
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));

    console.log(chalk.green(`  ✅ Index updated: ${relativePath}`));
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
    console.log(chalk.gray('  Run first: enhance --set-project /path/to/project\n'));
    process.exit(1);
  }

  if (!fs.existsSync(projectPath)) {
    console.log(chalk.red(`\n  ✗ Project path not found: ${projectPath}\n`));
    process.exit(1);
  }

  // Check chokidar is installed
  let chokidar;
  try {
    chokidar = (await import('chokidar')).default;
  } catch {
    console.log(chalk.red('\n  ✗ chokidar not installed.'));
    console.log(chalk.gray('  Run: npm install chokidar\n'));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.bold.cyan('  👁  Prompt Enhancer — Watch Mode'));
  console.log(chalk.gray(`  Watching: ${projectPath}`));
  console.log(chalk.gray('  Any file change → auto re-index'));
  console.log(chalk.gray('  Press Ctrl+C to stop\n'));

  // Debounce map — filePath → timer
  const debounceMap = new Map();

  const ignored = [
    ...SKIP_DIRS.map(d => `**/${d}/**`),
    '**/*.log',
    '**/context_index*.json',
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

    // Clear existing timer for this file
    if (debounceMap.has(filePath)) {
      clearTimeout(debounceMap.get(filePath));
    }

    // Wait 1.5s then re-index
    const timer = setTimeout(async () => {
      debounceMap.delete(filePath);

      const time = new Date().toLocaleTimeString();
      const icon = eventType === 'unlink' ? '🗑' : eventType === 'add' ? '➕' : '✏️ ';
      console.log(chalk.gray(`\n  [${time}] ${icon} ${relativePath}`));
      console.log(chalk.cyan('  🔄 Re-indexing...'));

      await reindexFile(filePath, projectPath, eventType);
    }, DEBOUNCE_MS);

    debounceMap.set(filePath, timer);
  }

  watcher.on('change', filePath => handleEvent(filePath, 'change'));
  watcher.on('add',    filePath => handleEvent(filePath, 'add'));
  watcher.on('unlink', filePath => handleEvent(filePath, 'unlink'));

  watcher.on('error', err => {
    console.log(chalk.red(`\n  Watch error: ${err.message}`));
  });

  watcher.on('ready', () => {
    console.log(chalk.green('  ✅ Watching for changes...\n'));
  });

  // Ctrl+C — graceful shutdown
  process.on('SIGINT', () => {
    console.log(chalk.gray('\n\n  Stopping watcher...\n'));
    watcher.close();
    process.exit(0);
  });
}