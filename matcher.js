/**
 * matcher.js
 * ----------
 * Mini RAG: Two-layer semantic search over context_index.json.
 * 
 * Layer 1: Keyword scoring (fast, no API, no model)
 *   → Reduces all files down to top 15 candidates
 * 
 * Layer 2: Local embedding cosine similarity (semantic, no API call)
 *   → Embeds raw prompt → compares against stored file vectors
 *   → Picks true top 5 by meaning, not just word overlap
 * 
 * Returns top 5 file contexts to feed into enhancer.js
 */

import fs from 'fs';
import { embed, topK } from './embedder.js';

const INDEX_PATH = './context_index.json';
const TOP_K_KEYWORD = 15;  // Layer 1 candidates
const TOP_K_FINAL = 5;     // Layer 2 final output

// ─────────────────────────────────────────
// Load Index
// ─────────────────────────────────────────

export function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────
// Layer 1: Keyword Scoring (no model, no API)
// Fast pre-filter — reduces N files to 15 candidates
// ─────────────────────────────────────────

function extractKeywords(rawPrompt) {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'must', 'can',
    'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me',
    'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them',
    'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom',
    'and', 'but', 'or', 'in', 'on', 'at', 'to', 'for', 'of',
    'with', 'by', 'from', 'up', 'about', 'into', 'through', 'after',
    'still', 'just', 'like', 'looks', 'fine', 'shows', 'gets',
  ]);

  return rawPrompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function scoreFile(fileEntry, keywords) {
  if (!fileEntry || !keywords) return 0;

  let score = 0;

  // Guard every field — old index entries may have null/undefined values
  const filePath = (fileEntry.path || '').toLowerCase();
  const summary = (fileEntry.summary || '').toLowerCase();
  const fileKeywords = (fileEntry.keywords || []).filter(Boolean).map(k => String(k).toLowerCase());
  const functions = (fileEntry.functions || []).filter(Boolean).map(f => String(f).toLowerCase());
  const imports = (fileEntry.imports || []).filter(Boolean).map(i => String(i).toLowerCase());

  for (const kw of keywords) {
    if (!kw) continue;
    try {
      if (filePath.includes(kw)) score += 5;
      if (fileKeywords.some(fk => fk.includes(kw) || kw.includes(fk))) score += 4;
      if (summary.includes(kw)) score += 3;
      if (functions.some(fn => fn.includes(kw) || kw.includes(fn))) score += 2;
      if (imports.some(imp => imp.includes(kw))) score += 1;
    } catch {
      // Skip malformed entry — never crash on bad index data
    }
  }

  return score;
}

function keywordMatch(index, rawPrompt) {
  const keywords = extractKeywords(rawPrompt);
  if (!keywords || keywords.length === 0) return [];

  return Object.values(index)
    .filter(entry => entry && typeof entry === 'object') // skip malformed entries
    .map(entry => ({ ...entry, keywordScore: scoreFile(entry, keywords) }))
    .filter(entry => entry.keywordScore > 0)
    .sort((a, b) => b.keywordScore - a.keywordScore)
    .slice(0, TOP_K_KEYWORD);
}

// ─────────────────────────────────────────
// Layer 2: Semantic Re-ranking (local model)
//
// Takes Layer 1 candidates (15 files)
// Embeds the raw prompt → query vector
// Compares against stored file embeddings via cosine similarity
// Returns true top 5 by semantic meaning
//
// Files with zero keyword overlap but high semantic relevance
// get picked up here — this is what keyword matching misses
// ─────────────────────────────────────────

async function semanticRerank(candidates, rawPrompt) {
  // Filter candidates that have stored embeddings
  const withEmbeddings = candidates.filter(
    f => f.embedding && f.embedding.length > 0
  );

  // If no embeddings stored — index built before embedder was added
  // fall back gracefully to keyword order
  if (withEmbeddings.length === 0) {
    return candidates.slice(0, TOP_K_FINAL);
  }

  // Embed the raw prompt — same model that embedded the summaries
  const queryVec = await embed(rawPrompt);

  // Rank by cosine similarity — higher = more semantically similar
  const reranked = topK(queryVec, withEmbeddings, TOP_K_FINAL);

  return reranked;
}

// ─────────────────────────────────────────
// Format top files as context block for Claude
// ─────────────────────────────────────────

export function formatContextForClaude(files) {
  if (!files || files.length === 0) {
    return 'No relevant files found in codebase index.';
  }

  return files
    .map((f, i) => {
      const functions = f.functions?.length
        ? `Functions: ${f.functions.slice(0, 8).join(', ')}`
        : '';
      const keywords = f.keywords?.length
        ? `Keywords: ${f.keywords.slice(0, 6).join(', ')}`
        : '';
      const score = f.similarity !== undefined
        ? `Relevance: ${(f.similarity * 100).toFixed(0)}%`
        : '';

      return [
        `[${i + 1}] ${f.path}`,
        `Summary: ${f.summary}`,
        functions,
        keywords,
        score,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

// ─────────────────────────────────────────
// Main: Find Relevant Files
// Layer 1 (keyword) → Layer 2 (semantic) → formatted context
// ─────────────────────────────────────────

export async function findRelevantFiles(rawPrompt) {
  // Wrap entire body — nothing in here should ever crash the tool
  try {
    const index = loadIndex();

    if (!index) {
      return {
        files: [], context: '',
        error: 'No index found. Run: enhance --init /path/to/project',
      };
    }

    const totalFiles = Object.keys(index).length;

    if (totalFiles === 0) {
      return {
        files: [], context: '',
        error: 'Index is empty. Run: enhance --init /path/to/project',
      };
    }

    // ── Layer 1: Keyword scoring → up to 15 candidates ──
    const candidates = keywordMatch(index, rawPrompt);

    // Fallback: no keyword matches → use most recently indexed files
    const pool = (candidates.length > 0
      ? candidates
      : Object.values(index)
          .sort((a, b) => new Date(b.indexed_at) - new Date(a.indexed_at))
          .slice(0, TOP_K_KEYWORD)
    ) || [];

    // ── Layer 2: Semantic re-ranking → true top 5 ──
    // Falls back to keyword order if:
    //   - @xenova/transformers not installed
    //   - model fails to load
    //   - no embeddings stored in index (re-run enhance --init to generate)
    let finalFiles = pool.slice(0, TOP_K_FINAL); // safe default
    let usedSemantics = false;

    try {
      const reranked = await semanticRerank(pool, rawPrompt);
      if (reranked && reranked.length > 0) {
        finalFiles = reranked;
        usedSemantics = finalFiles.some(f => f.similarity !== undefined);
      }
    } catch {
      // Semantic layer failed silently — keyword fallback already set above
    }

    const context = formatContextForClaude(finalFiles);

    return {
      files: finalFiles,
      context,
      totalIndexed: totalFiles,
      matchedCount: candidates.length,
      usedSemantics,
    };

  } catch (err) {
    // Absolute last resort — should never happen but never crash the tool
    return {
      files: [],
      context: '',
      error: `Matcher error: ${err.message}`,
    };
  }
}