/**
 * embedder.js
 * -----------
 * Local embedding model wrapper using @xenova/transformers.
 *
 * Designed to fail gracefully — if the package is not installed or the model
 * fails to load, all functions return null/empty safely. matcher.js falls
 * back to keyword scoring automatically. Tool never crashes.
 *
 * Model: all-MiniLM-L6-v2
 *   - 384 dimensions
 *   - ~30MB one-time download, cached locally in .model-cache/
 *   - Runs on CPU, no GPU, no API cost, works offline
 *
 * Install: npm install @xenova/transformers
 */

let pipeline = null;
let loadAttempted = false;
let packageAvailable = null; // null = unknown, true/false after first check

// ─────────────────────────────────────────
// Check if @xenova/transformers is installed
// Cached after first check — no repeated filesystem lookups
// ─────────────────────────────────────────

async function isPackageAvailable() {
  if (packageAvailable !== null) return packageAvailable;

  try {
    await import('@xenova/transformers');
    packageAvailable = true;
  } catch {
    packageAvailable = false;
  }

  return packageAvailable;
}

// ─────────────────────────────────────────
// Load model — returns pipeline or null
// Never throws — always returns null on failure
// ─────────────────────────────────────────

async function loadModel() {
  // Already loaded
  if (pipeline) return pipeline;

  // Already tried and failed — don't retry
  if (loadAttempted) return null;

  loadAttempted = true;

  try {
    const available = await isPackageAvailable();
    if (!available) {
      // Silent — matcher.js handles fallback
      return null;
    }

    const { pipeline: createPipeline, env } = await import('@xenova/transformers');

    // Cache model locally — not re-downloaded every run
    env.cacheDir = './.model-cache';

    pipeline = await createPipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true }
    );

    return pipeline;
  } catch {
    // Model load failed — fall back silently
    return null;
  }
}

// ─────────────────────────────────────────
// Embed text → Float32Array or null
// Returns null if model unavailable — callers must handle null
// ─────────────────────────────────────────

export async function embed(text) {
  if (!text || typeof text !== 'string') return null;

  try {
    const model = await loadModel();
    if (!model) return null;

    const output = await model(text, {
      pooling: 'mean',
      normalize: true,
    });

    if (!output || !output.data) return null;

    return output.data;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────
// Cosine similarity between two vectors
// Returns 0 if either vector is null/undefined/mismatched
// ─────────────────────────────────────────

export function cosineSimilarity(vecA, vecB) {
  // Null guards — never throw
  if (!vecA || !vecB) return 0;
  if (!vecA.length || !vecB.length) return 0;
  if (vecA.length !== vecB.length) return 0;

  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }

  return Math.max(-1, Math.min(1, dot));
}

// ─────────────────────────────────────────
// Find top K entries by cosine similarity
// Returns empty array if queryVec is null or no embeddings found
// ─────────────────────────────────────────

export function topK(queryVec, entries, k = 5) {
  // Null guard — return empty if no query vector
  if (!queryVec || !entries || entries.length === 0) return [];

  return entries
    .filter(entry => entry.embedding && Array.isArray(entry.embedding) && entry.embedding.length > 0)
    .map(entry => ({
      ...entry,
      similarity: cosineSimilarity(queryVec, new Float32Array(entry.embedding)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

// ─────────────────────────────────────────
// Check if embeddings are available
// Used by matcher.js to decide whether to attempt semantic search
// ─────────────────────────────────────────

export async function isEmbeddingAvailable() {
  return isPackageAvailable();
}