/**
 * sync.js
 * -------
 * Lazy sync — called by matcher.js before every RAAG query.
 *
 * Flow:
 *   1. git status --porcelain  → get M/A/U/R/D files
 *   2. Filter to indexed extensions + skip dirs
 *   3. Compare structureSig against cache
 *   4. Re-summarize only structurally changed files (parallel)
 *   5. Sync changed files to RAAG
 *
 * Never spawns Claude for cosmetic-only edits.
 * Deleted files trigger a RAAG rebuild.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { extractFileStructure, getSummaryFromClaude } from './indexer.js';
import { getRaagClient } from './raag-client.js';

// ─────────────────────────────────────────
// Config — must mirror indexer.js
// ─────────────────────────────────────────

const FILE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'vue', 'py',
  'go', 'rs', 'java', 'rb', 'html', 'css', 'cpp',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build',
  '.next', 'coverage', '.cache', 'public',
  '__pycache__', '.venv', 'venv', 'target',
]);

const MAX_FILE_SIZE_KB = 100;
const CACHE_FILENAME = '.enhance-cache.json';
const PARALLEL_LIMIT = 10;

// ─────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────

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
  fs.writeFileSync(
    path.join(projectPath, CACHE_FILENAME),
    JSON.stringify(cache, null, 2),
  );
}

// ─────────────────────────────────────────
// Content hash — detects actual changes since last sync
// ─────────────────────────────────────────

function hashContent(content) {
  return createHash('sha1').update(content).digest('hex');
}

// ─────────────────────────────────────────
// Git helpers
// ─────────────────────────────────────────

/**
 * Returns true if the current directory (or projectPath) is inside a git repo.
 */
function isGitRepo(projectPath) {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: projectPath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses `git status --porcelain` output.
 * Returns { modified: string[], added: string[], deleted: string[], renamed: string[] }
 * All paths are relative to the repo root.
 */
function getGitChanges(projectPath) {
  const result = { modified: [], added: [], deleted: [], renamed: [] };

  let raw;
  try {
    raw = execSync('git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return result;
  }

  if (!raw || !raw.trim()) return result;

  for (const line of raw.trim().split('\n')) {
    if (line.length < 4) continue;

    const xy = line.slice(0, 2);
    const filePart = line.slice(3).trim();

    // Renamed: "R  old -> new" format
    if (xy.trim().startsWith('R')) {
      const parts = filePart.split(' -> ');
      const newPath = (parts[1] || parts[0]).trim();
      result.renamed.push(newPath);
      continue;
    }

    // Deleted
    if (xy.includes('D')) {
      result.deleted.push(filePart);
      continue;
    }

    // Added (untracked ?? or staged A)
    if (xy === '??' || xy.trim() === 'A') {
      result.added.push(filePart);
      continue;
    }

    // Modified (M in index or working tree)
    if (xy.includes('M')) {
      result.modified.push(filePart);
    }
  }

  return result;
}

// ─────────────────────────────────────────
// File filter
// ─────────────────────────────────────────

function shouldIndex(relativePath) {
  const ext = path.extname(relativePath).replace('.', '').toLowerCase();
  if (!FILE_EXTENSIONS.has(ext)) return false;

  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (parts.some(p => SKIP_DIRS.has(p))) return false;

  return true;
}

// ─────────────────────────────────────────
// Re-index a single file
// Returns { path, contentWithSummary, cacheEntry } or null if skipped
// ─────────────────────────────────────────

async function reindexFile(relativePath, projectPath, cache) {
  const absolutePath = path.join(projectPath, relativePath);

  if (!fs.existsSync(absolutePath)) return null;

  let stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    return null;
  }

  if (stats.size / 1024 > MAX_FILE_SIZE_KB) return null;

  let content;
  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }

  if (content.trim().length < 50) return null;

  // Content hash check — skip entirely if file hasn't changed since last sync
  const currentHash = hashContent(content);
  const cached = cache[relativePath];

  if (cached && cached.contentHash === currentHash) {
    return null; // identical content — no sync needed
  }

  // Extract structure and compute new sig
  const extracted = extractFileStructure(relativePath, content);
  const newSig = [
    ...extracted.functions,
    ...extracted.imports,
    ...extracted.exports,
  ].join('|');

  // Skip Claude re-summarize if structureSig unchanged — cosmetic edit only
  if (cached && cached.structureSig === newSig) {
    const summary = cached?.summary || '';
    const contentWithSummary = summary
      ? `<!-- RAAG-SUMMARY: ${summary} | File: ${relativePath} -->\n${content}`
      : content;
    return {
      path: relativePath,
      skipped: true,
      contentWithSummary,
      cacheEntry: {
        ...cached,
        mtime: stats.mtimeMs,
        contentHash: currentHash,
      },
    };
  }

  // Structural change — re-summarize via Claude
  const { summary } = await getSummaryFromClaude(extracted);

  const contentWithSummary = `<!-- RAAG-SUMMARY: ${summary} | File: ${relativePath} -->\n${content}`;

  return {
    path: relativePath,
    skipped: false,
    content,
    contentWithSummary,
    cacheEntry: {
      mtime: stats.mtimeMs,
      contentHash: currentHash,
      structureSig: newSig,
      summary,
    },
  };
}

// ─────────────────────────────────────────
// Main: Lazy sync before RAAG query
// ─────────────────────────────────────────

/**
 * Checks for git changes and syncs only what changed.
 *
 * @param {string} projectPath
 * @param {{ verbose?: boolean }} options
 * @returns {{ synced: number, skipped: number, deleted: number, latencyMs: number, hadChanges: boolean }}
 */
export async function lazySyncIfNeeded(projectPath, { verbose = true } = {}) {
  const start = performance.now();
  const noop = { synced: 0, skipped: 0, deleted: 0, latencyMs: 0, hadChanges: false };

  if (!isGitRepo(projectPath)) return noop;

  const changes = getGitChanges(projectPath);

  const filesToProcess = [
    ...changes.modified,
    ...changes.added,
    ...changes.renamed,
  ].filter(shouldIndex);

  const deletedFiles = changes.deleted.filter(shouldIndex);

  if (filesToProcess.length === 0 && deletedFiles.length === 0) {
    return noop;
  }

  const cache = loadCache(projectPath);
  const raag = getRaagClient(projectPath);

  const filesToSync = [];
  let syncedCount = 0;
  let skippedCount = 0;

  // Process in parallel batches
  for (let i = 0; i < filesToProcess.length; i += PARALLEL_LIMIT) {
    const batch = filesToProcess.slice(i, i + PARALLEL_LIMIT);

    const results = await Promise.all(
      batch.map(f => reindexFile(f, projectPath, cache)),
    );

    for (const result of results) {
      if (!result) continue;

      if (result.skipped) {
        // Cosmetic change — content synced, cacheEntry already has new contentHash + mtime
        filesToSync.push({ path: result.path, content: result.contentWithSummary });
        cache[result.path] = result.cacheEntry;
        skippedCount++;
      } else {
        // Structural change — use new summary
        filesToSync.push({ path: result.path, content: result.contentWithSummary });
        cache[result.path] = result.cacheEntry;
        syncedCount++;
      }
    }
  }

  // Handle deleted files — remove from cache
  for (const deletedPath of deletedFiles) {
    if (cache[deletedPath]) {
      delete cache[deletedPath];
    }
  }

  // Persist cache — include skipped so contentHash is recorded
  if (syncedCount > 0 || skippedCount > 0 || deletedFiles.length > 0) {
    saveCache(projectPath, cache);
  }

  // Nothing actually changed after hash check — clean exit
  if (filesToSync.length === 0 && deletedFiles.length === 0) {
    return noop;
  }

  // Now we know real work is happening — print the sync header
  if (verbose) {
    const total = filesToSync.length + deletedFiles.length;
    console.log(chalk.gray(`  Syncing ${total} changed file${total !== 1 ? 's' : ''} before search...`));
  }

  // Push to RAAG
  if (raag && (filesToSync.length > 0 || deletedFiles.length > 0)) {
    try {
      const syncResult = await raag.syncFiles(filesToSync, false);

      const hasChanges = filesToSync.length > 0 || deletedFiles.length > 0;

      if (hasChanges) {
        if (syncResult.rebuild_triggered) {
          // RAAG auto-triggered incremental rebuild — just wait
          await raag.waitForReady();
        } else {
          // Manually trigger incremental rebuild so query sees fresh content
          try {
            await raag.triggerRebuild();
            await raag.waitForReady();
          } catch (rebuildErr) {
            if (verbose) {
              console.log(chalk.yellow(`  ⚠  Rebuild warning: ${rebuildErr.message}`));
            }
          }
        }
      }
    } catch (err) {
      if (verbose) {
        console.log(chalk.yellow(`  ⚠  Sync warning: ${err.message}`));
      }
      // Non-fatal — proceed with query using current RAAG state
    }
  }

  const latencyMs = Math.round(performance.now() - start);

  if (verbose && (syncedCount > 0 || skippedCount > 0 || deletedFiles.length > 0)) {
    const parts = [];
    if (syncedCount > 0) parts.push(`${syncedCount} re-indexed`);
    if (skippedCount > 0) parts.push(`${skippedCount} content-only`);
    if (deletedFiles.length > 0) parts.push(`${deletedFiles.length} removed`);
    console.log(chalk.gray(`  ✓ ${parts.join(', ')} (${latencyMs}ms)`));
  }

  return {
    synced: syncedCount,
    skipped: skippedCount,
    deleted: deletedFiles.length,
    latencyMs,
    hadChanges: true,
  };
}