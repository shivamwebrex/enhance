/**
 * matcher.js
 * ----------
 * Finds relevant files for a prompt using RAAG semantic search.
 *
 * Single call to RAAG query endpoint — no local search, no fallback.
 * Returns top 5 file chunks formatted as context for the enhancer.
 */

import chalk from 'chalk';
import { getRaagClient } from './raag-client.js';
import { getProjectRaag } from './config.js';

const TOP_K = 5;

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
 * Query RAAG for files relevant to the prompt.
 * @param {string} rawPrompt - Developer's raw prompt
 * @param {string} projectPath - Project path (to find KB/RAG IDs)
 * @returns {{ files: object[], context: string, matchedCount: number, topScore: string, error?: string }}
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

  // Get RAAG client with project IDs
  const raag = getRaagClient(projectPath);
  if (!raag) {
    return {
      files: [],
      context: '',
      matchedCount: 0,
      error: 'RAAG not configured. Run any enhance command to set up API key.',
    };
  }

  // Query RAAG
  let raagResult;
  const queryStart = performance.now();
  try {
    raagResult = await raag.queryFiles(rawPrompt, TOP_K);
  } catch (err) {
    console.error(chalk.red(`  ✗ RAAG query failed: ${err.message}`));
    return {
      files: [],
      context: '',
      matchedCount: 0,
      error: `RAAG query failed: ${err.message}`,
    };
  }

  const results = raagResult.results || [];

  // Format context for enhancer
  const context = formatContext(results);

  // Extract top score for display
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
