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
 *   formatContext()     → strips source code, returns summaries only
 *
 * Claude never sees raw source code — only developer-written summaries.
 * This keeps enhance call context at ~1,200 tokens vs ~15,000 previously.
 */

import chalk from 'chalk';
import { getRaagClient } from './raag-client.js';
import { getProjectRaag } from './config.js';
import { lazySyncIfNeeded } from './sync.js';

const TOP_K = parseInt(process.env.TOP_K_FINAL ?? '5', 10);

// ─────────────────────────────────────────
// Format RAAG results — summaries only, no source
// ─────────────────────────────────────────

/**
 * Extracts the summary block from each RAAG result.
 * RAAG stores: summary + keywords + source code as one blob.
 * We send Claude only the summary + keywords — never the source.
 *
 * Reduces per-enhance Claude context from ~15,000 tokens → ~1,200 tokens.
 */
function formatContext(results) {
  if (!results || results.length === 0) {
    return 'No relevant files found in the codebase.';
  }

  return results.map((r, i) => {
    const source = r.source || r.metadata?.file_path || 'unknown';
    const score = r.score != null ? `${(r.score * 100).toFixed(0)}%` : 'N/A';
    const raw = (r.content || '').trim();

    // Extract summary block only — stop before SOURCE CODE section
    const summaryMatch = raw.match(
      /=== FILE:.*?===\s*\n+([\s\S]*?)(?:\n+=== KEYWORDS:|\n+=== SOURCE CODE ===|$)/
    );
    const keywordsMatch = raw.match(/=== KEYWORDS:\s*(.+)/);

    // Fallback: if format doesn't match, take first 400 chars (safe cap)
    const summary = summaryMatch
      ? summaryMatch[1].trim()
      : raw.slice(0, 400);

    const keywords = keywordsMatch ? `Keywords: ${keywordsMatch[1].trim()}` : '';

    return [`[${i + 1}] ${source} (${score})`, summary, keywords]
      .filter(Boolean)
      .join('\n');

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

  const projConfig = getProjectRaag(projectPath);
  if (!projConfig || !projConfig.ragId) {
    return {
      files: [],
      context: '',
      matchedCount: 0,
      error: 'Project not indexed. Run: enhance --init',
    };
  }

  const raag = getRaagClient(projectPath);
  if (!raag) {
    return {
      files: [],
      context: '',
      matchedCount: 0,
      error: 'RAAG not configured. Run any enhance command to set up API key.',
    };
  }

  // Lazy sync: push any git-modified files to RAAG before querying
  await lazySyncIfNeeded(projectPath, { verbose: true });

  // RAAG semantic search
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

  // Strip source code — Claude sees summaries only
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