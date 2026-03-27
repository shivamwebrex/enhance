/**
 * matcher.js
 * ----------
 * Finds relevant files for a prompt using RAAG semantic search.
 *
 * Before querying, runs a lazy git-based sync to ensure the index
 * reflects any uncommitted working-tree changes. No watcher needed.
 *
 * Flow:
 *   lazySyncIfNeeded()  → sync only changed files (git status)
 *   raag.queryFiles()   → semantic search over fresh index
 */

import chalk from 'chalk';
import { getRaagClient } from './raag-client.js';
import { getProjectRaag } from './config.js';
import { lazySyncIfNeeded } from './sync.js';

const TOP_K = parseInt(process.env.TOP_K_FINAL ?? '5', 10);

// ─────────────────────────────────────────
// Format RAAG results into context block
// ─────────────────────────────────────────

function formatContext(results) {
  if (!results || results.length === 0) {
    return 'No relevant files found in the codebase.';
  }

  return results.map((r, i) => {
    const source = r.source || r.metadata?.file_path || 'unknown';
    const score = r.score != null ? `${(r.score * 100).toFixed(0)}%` : 'N/A';
    const content = (r.content || '').trim();

    return `[${i + 1}] ${source}
Relevance: ${score}
${content}`;
  }).join('\n\n' + '─'.repeat(50) + '\n\n');
}

// ─────────────────────────────────────────
// Main: Find relevant files via RAAG
// ─────────────────────────────────────────

/**
 * Syncs git changes then queries RAAG for files relevant to the prompt.
 *
 * @param {string} rawPrompt   - Developer's raw prompt
 * @param {string} projectPath - Project root (to find KB/RAG IDs + cache)
 * @returns {{ files: object[], context: string, matchedCount: number, topScore: string, latencyMs: number, error?: string }}
 */
export async function findRelevantFiles(rawPrompt, projectPath) {
  if (!projectPath) {
    return { files: [], context: '', matchedCount: 0, error: 'No project path provided.' };
  }

  // Check project has been indexed
  const projConfig = getProjectRaag(projectPath);
  if (!projConfig || !projConfig.ragId) {
    return {
      files: [],
      context: '',
      matchedCount: 0,
      error: 'Project not indexed. Run: enhance --init',
    };
  }

  // Get RAAG client
  const raag = getRaagClient(projectPath);
  if (!raag) {
    return {
      files: [],
      context: '',
      matchedCount: 0,
      error: 'RAAG not configured. Run any enhance command to set up API key.',
    };
  }

  // ── Lazy sync: push any git-modified files to RAAG before querying ──
  // Silent on no changes. Prints a one-liner if files are synced.
  await lazySyncIfNeeded(projectPath, { verbose: true });

  // ── RAAG query ──
  let raagResult;
  const queryStart = performance.now();

  try {
    raagResult = await raag.queryFiles(rawPrompt, TOP_K);
  } catch (err) {
    console.error(chalk.red(`  RAAG query failed: ${err.message}`));
    return {
      files: [],
      context: '',
      matchedCount: 0,
      error: `RAAG query failed: ${err.message}`,
    };
  }

  const results = raagResult.results || [];
  const context = formatContext(results);

  const topScore = results.length > 0 && results[0].score != null
    ? `${(results[0].score * 100).toFixed(0)}%`
    : 'N/A';

  const latencyMs = Math.round(performance.now() - queryStart);

  return {
    files: results.map(r => ({
      path: r.source || r.metadata?.file_path || 'unknown',
      score: r.score,
      snippet: (r.content || '').slice(0, 200),
    })),
    context,
    matchedCount: results.length,
    topScore,
    latencyMs,
  };
}