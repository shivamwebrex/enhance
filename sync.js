/**
 * sync.js
 * -------
 * Lazy sync — called by matcher.js before every RAAG query.
 *
 * Flow:
 *   1. git status --porcelain  → get M/A/U/R/D files
 *   2. Filter to indexed extensions + skip dirs
 *   3. Content hash check — skip if file identical to last sync
 *   4. Compare structureSig against cache
 *   5. If structure changed: re-extract comments (instant, zero API cost)
 *   6. If cosmetic only: reuse cached summary
 *   7. Sync changed files to RAAG
 *
 * Zero Claude calls — ever.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import chalk from 'chalk';
import {
  extractFileStructure,
  extractCommentsWithFunctions,
  buildSummaryFromComments,
  buildFallbackSummary,
  prependSummary,
} from './indexer.js';
import { getRaagClient } from './raag-client.js';

// ─────────────────────────────────────────
// Config — mirrors indexer.js
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
// Content hash
// ─────────────────────────────────────────

function hashContent(content) {
  return createHash('sha1').update(content).digest('hex');
}

// ─────────────────────────────────────────
// Git helpers
// ─────────────────────────────────────────

function isGitRepo(projectPath) {
  try {
    execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

    if (xy.trim().startsWith('R')) {
      const parts = filePart.split(' -> ');
      result.renamed.push((parts[1] || parts[0]).trim());
      continue;
    }

    if (xy.includes('D')) { result.deleted.push(filePart); continue; }
    if (xy === '??' || xy.trim() === 'A') { result.added.push(filePart); continue; }
    if (xy.includes('M')) { result.modified.push(filePart); }
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
  return !parts.some(p => SKIP_DIRS.has(p));
}

// ─────────────────────────────────────────
// Re-index a single file — zero API cost
// ─────────────────────────────────────────

function reindexFile(relativePath, projectPath, cache) {
  const absolutePath = path.join(projectPath, relativePath);

  if (!fs.existsSync(absolutePath)) return null;

  let stats;
  try { stats = fs.statSync(absolutePath); } catch { return null; }

  if (stats.size / 1024 > MAX_FILE_SIZE_KB) return null;

  let content;
  try { content = fs.readFileSync(absolutePath, 'utf8'); } catch { return null; }

  if (content.trim().length < 50) return null;

  // Content hash — skip if identical to last sync
  const currentHash = hashContent(content);
  const cached = cache[relativePath];

  if (cached && cached.contentHash === currentHash) return null;

  // Structural sig — determines if we need to re-extract comments
  const extracted = extractFileStructure(relativePath, content);
  const newSig = [...extracted.functions, ...extracted.imports, ...extracted.exports].join('|');

  // Cosmetic change only (whitespace, string literals) — reuse cached summary
  if (cached && cached.structureSig === newSig && cached.summary) {
    const contentWithSummary = prependSummary(
      content, cached.summary, cached.keywords || [], relativePath
    );
    return {
      path: relativePath,
      skipped: true,
      contentWithSummary,
      cacheEntry: { ...cached, mtime: stats.mtimeMs, contentHash: currentHash },
    };
  }

  // Structural change — re-extract comments (instant, no API)
  const commentResult = buildSummaryFromComments(relativePath, content);
  const { summary, keywords } = commentResult || buildFallbackSummary(extracted);

  const contentWithSummary = prependSummary(content, summary, keywords, relativePath);

  return {
    path: relativePath,
    skipped: false,
    contentWithSummary,
    cacheEntry: {
      mtime: stats.mtimeMs,
      contentHash: currentHash,
      structureSig: newSig,
      summary,
      keywords,
    },
  };
}

// ─────────────────────────────────────────
// Main: Lazy sync before RAAG query
// ─────────────────────────────────────────

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

  if (filesToProcess.length === 0 && deletedFiles.length === 0) return noop;

  const cache = loadCache(projectPath);
  const raag = getRaagClient(projectPath);

  const filesToSync = [];
  let syncedCount = 0;
  let skippedCount = 0;

  // Process in parallel batches — sync is now pure CPU (no async needed)
  for (let i = 0; i < filesToProcess.length; i += PARALLEL_LIMIT) {
    const batch = filesToProcess.slice(i, i + PARALLEL_LIMIT);

    // reindexFile is now synchronous (no Claude), run in parallel for I/O
    const results = await Promise.all(
      batch.map(f => Promise.resolve(reindexFile(f, projectPath, cache))),
    );

    for (const result of results) {
      if (!result) continue;

      filesToSync.push({ path: result.path, content: result.contentWithSummary });
      cache[result.path] = result.cacheEntry;

      if (result.skipped) skippedCount++;
      else syncedCount++;
    }
  }

  // Handle deleted files
  for (const deletedPath of deletedFiles) {
    delete cache[deletedPath];
  }

  if (syncedCount > 0 || skippedCount > 0 || deletedFiles.length > 0) {
    saveCache(projectPath, cache);
  }

  if (filesToSync.length === 0 && deletedFiles.length === 0) return noop;

  if (verbose) {
    const total = filesToSync.length + deletedFiles.length;
    console.log(chalk.gray(`  Syncing ${total} changed file${total !== 1 ? 's' : ''} before search...`));
  }

  if (raag && (filesToSync.length > 0 || deletedFiles.length > 0)) {
    try {
      const syncResult = await raag.syncFiles(filesToSync, false);

      if (syncResult.rebuild_triggered) {
        await raag.waitForReady();
      } else {
        try {
          await raag.triggerRebuild();
          await raag.waitForReady();
        } catch (rebuildErr) {
          if (verbose) console.log(chalk.yellow(`  ⚠  Rebuild warning: ${rebuildErr.message}`));
        }
      }
    } catch (err) {
      if (verbose) console.log(chalk.yellow(`  ⚠  Sync warning: ${err.message}`));
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

  return { synced: syncedCount, skipped: skippedCount, deleted: deletedFiles.length, latencyMs, hadChanges: true };
}