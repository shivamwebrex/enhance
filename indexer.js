/**
 * indexer.js
 * ----------
 * Scans a target project directory and builds context_index.json.
 * 
 * For each file:
 *   1. Script extracts structure (functions, imports, comments) — no Claude
 *   2. Claude writes a one-line semantic summary + keywords from that extract
 * 
 * Saves result to context_index.json in the prompt-enhancer directory.
 * 
 * Run: node index.js --init /path/to/your/project
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { glob } from 'glob';
import { embed } from './embedder.js';

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const INDEX_PATH = './context_index.json';

// File types to scan
const FILE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'vue', 'py'];

// Directories to always skip
const SKIP_DIRS = [
  'node_modules', '.git', 'dist', 'build',
  '.next', 'coverage', '.cache', 'public'
];

// Max file size to process (skip massive generated files)
const MAX_FILE_SIZE_KB = 100;

// ─────────────────────────────────────────
// Step 1: Extract structure from file (no Claude)
// ─────────────────────────────────────────

export function extractFileStructure(filePath, content) {
  const lines = content.split('\n');
  const extracted = {
    path: filePath,
    functions: [],
    imports: [],
    exports: [],
    comments: [],
    variables: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Function declarations
    if (
      trimmed.match(/^(export\s+)?(async\s+)?function\s+\w+/) ||
      trimmed.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/) ||
      trimmed.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?function/)
    ) {
      const match = trimmed.match(/(?:function|const)\s+(\w+)/);
      if (match) extracted.functions.push(match[1]);
    }

    // Arrow function methods
    if (trimmed.match(/^\w+\s*[=:]\s*(async\s+)?\(.*\)\s*=>/)) {
      const match = trimmed.match(/^(\w+)\s*[=:]/);
      if (match) extracted.functions.push(match[1]);
    }

    // Import statements
    if (trimmed.startsWith('import ')) {
      const match = trimmed.match(/from\s+['"](.+)['"]/);
      if (match) extracted.imports.push(match[1]);
    }

    // Export statements
    if (trimmed.startsWith('export ')) {
      const match = trimmed.match(/export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/);
      if (match) extracted.exports.push(match[1]);
    }

    // JSDoc and meaningful comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      const comment = trimmed.replace(/^[/*\s]+/, '').trim();
      if (comment.length > 10 && comment.length < 100) {
        extracted.comments.push(comment);
      }
    }

    // State/store variables (Zustand, Redux patterns)
    if (trimmed.match(/^(const|let)\s+\w+\s*=\s*(create|createSlice|useState|useReducer|atom)/)) {
      const match = trimmed.match(/^(?:const|let)\s+(\w+)/);
      if (match) extracted.variables.push(match[1]);
    }
  }

  // Deduplicate
  extracted.functions = [...new Set(extracted.functions)].slice(0, 15);
  extracted.imports = [...new Set(extracted.imports)].slice(0, 10);
  extracted.exports = [...new Set(extracted.exports)].slice(0, 10);
  extracted.comments = [...new Set(extracted.comments)].slice(0, 5);
  extracted.variables = [...new Set(extracted.variables)].slice(0, 10);

  return extracted;
}

// ─────────────────────────────────────────
// Step 2: Ask Claude for semantic summary
// ─────────────────────────────────────────

export function buildFallbackSummary(extracted) {
  return {
    summary: `File with functions: ${extracted.functions.slice(0, 3).join(', ') || 'unknown'}`,
    keywords: [
      ...extracted.functions.slice(0, 3),
      ...extracted.exports.slice(0, 2),
    ].map(k => k.toLowerCase()).filter(Boolean),
  };
}

// ─────────────────────────────────────────
// TRUE parallel Claude call using spawn + stdin
//
// Key insight from ShipSafe parser.js:
//   spawn("claude", ["-p", "-"]) creates a fully independent OS process
//   Prompt is written to stdin — no shell argument parsing, no length limits
//   Each spawn is isolated — 10 spawns = 10 truly concurrent OS processes
//
// Why exec/execAsync failed:
//   exec passes prompt as a shell argument — shell may serialize, has length limits
//   spawn + stdin = process reads its own pipe, fully independent
// ─────────────────────────────────────────

export function askClaudeSpawn(prompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

    // Exactly like ShipSafe: spawn with "-p" "-" so Claude reads from stdin
    const child = spawn('claude', ['-p', '-'], {
      shell: true,
      windowsHide: true,
    });

    // Kill after 35s (same as ShipSafe)
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      resolve(null);
    }, 35000);

    // Write prompt to stdin and close it
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    // Collect stdout
    child.stdout.on('data', (data) => { stdout += data.toString(); });

    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve(stdout.trim() || null);
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// Per-file summary using spawn — called in parallel via Promise.all
export async function getSummaryFromClaude(extracted) {
  const prompt = `You are indexing a codebase. Given this file structure extract, write:
1. A single sentence summary of what this file does (max 20 words)
2. A comma-separated list of 5-8 keywords that developers would use to find this file

File: ${extracted.path}
Functions: ${extracted.functions.join(', ') || 'none'}
Imports: ${extracted.imports.join(', ') || 'none'}
Exports: ${extracted.exports.join(', ') || 'none'}
Key variables: ${extracted.variables.join(', ') || 'none'}
Comments: ${extracted.comments.join(' | ') || 'none'}

Respond in this exact format (no other text):
SUMMARY: <one sentence>
KEYWORDS: <keyword1, keyword2, keyword3, ...>`;

  const output = await askClaudeSpawn(prompt);

  if (!output) return buildFallbackSummary(extracted);

  const summaryMatch = output.match(/SUMMARY:\s*(.+)/);
  const keywordsMatch = output.match(/KEYWORDS:\s*(.+)/);

  if (summaryMatch) {
    return {
      summary: summaryMatch[1].trim(),
      keywords: keywordsMatch
        ? keywordsMatch[1].split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
        : [],
    };
  }

  return buildFallbackSummary(extracted);
}

// ─────────────────────────────────────────
// Main: Build Index
// ─────────────────────────────────────────

export async function buildIndex(projectPath, options = {}) {
  const { verbose = false, force = false } = options;

  // Validate project path
  if (!fs.existsSync(projectPath)) {
    console.error(`Project path not found: ${projectPath}`);
    process.exit(1);
  }

  // Load existing index if available (for incremental updates)
  let existingIndex = {};
  if (fs.existsSync(INDEX_PATH) && !force) {
    try {
      existingIndex = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    } catch {
      existingIndex = {};
    }
  }

  // Build glob pattern to find all relevant files
  const pattern = `**/*.{${FILE_EXTENSIONS.join(',')}}`;
  const ignore = SKIP_DIRS.map(d => `**/${d}/**`);

  const files = await glob(pattern, {
    cwd: projectPath,
    ignore,
    absolute: true,
  });

  console.log(`\nFound ${files.length} files to index in ${projectPath}\n`);

  const index = { ...existingIndex };
  let processed = 0;
  let skipped = 0;
  let updated = 0;

  // ─────────────────────────────────────────
  // Step 1: Pre-filter files (no Claude yet)
  // Separate unchanged files from files that need indexing
  // ─────────────────────────────────────────

  const toIndex = [];

  for (const filePath of files) {
    const relativePath = path.relative(projectPath, filePath);
    const stats = fs.statSync(filePath);
    const sizeKB = stats.size / 1024;

    // Skip large files
    if (sizeKB > MAX_FILE_SIZE_KB) {
      if (verbose) console.log(`  ⏭  Skipping large file: ${relativePath} (${sizeKB.toFixed(0)}KB)`);
      skipped++;
      continue;
    }

    const mtime = stats.mtimeMs;

    // Skip unchanged files (already in index with same mtime)
    if (existingIndex[relativePath] && existingIndex[relativePath].mtime === mtime && !force) {
      if (verbose) console.log(`  ✓  Unchanged: ${relativePath}`);
      processed++;
      continue;
    }

    // Read content
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      skipped++;
      continue;
    }

    // Skip empty files
    if (content.trim().length < 50) {
      skipped++;
      continue;
    }

    toIndex.push({ filePath, relativePath, content, mtime });
  }

  console.log(`  ${toIndex.length} files need indexing | ${processed} unchanged | ${skipped} skipped\n`);

  // ─────────────────────────────────────────
  // Step 2: TRUE parallel processing using spawn + stdin
  //
  // Each file gets its own independent OS process via spawn.
  // PARALLEL_LIMIT files run simultaneously — each reads its own stdin pipe.
  // This is exactly how ShipSafe parser.js achieves real parallelism.
  // ─────────────────────────────────────────

  const PARALLEL_LIMIT = 10; // 10 truly concurrent Claude processes
  const totalBatches = Math.ceil(toIndex.length / PARALLEL_LIMIT);

  // Process one file: extract structure → spawn Claude → return result
  async function processFile({ relativePath, content: fileContent, mtime }) {
    const extracted = extractFileStructure(relativePath, fileContent);
    const { summary, keywords } = await getSummaryFromClaude(extracted);

    // Embed the summary for semantic search (Layer 2 in matcher.js)
    // Text embedded: summary + keywords + path for richer signal
    const textToEmbed = [
      summary,
      keywords.join(' '),
      relativePath,
    ].join(' ');

    let embedding = [];
    try {
      const vec = await embed(textToEmbed);
      embedding = Array.from(vec); // store as plain array in JSON
    } catch {
      // If embedding fails, store empty — matcher falls back to keyword scoring
      embedding = [];
    }

    return {
      relativePath,
      entry: {
        path: relativePath,
        summary,
        keywords,
        functions: extracted.functions,
        imports: extracted.imports,
        exports: extracted.exports,
        embedding,   // ← 384-dim vector for semantic search
        structureSig: [extracted.functions, extracted.imports, extracted.exports].flat().join('|'),  // ← for watcher change detection
        mtime,
        indexed_at: new Date().toISOString(),
      },
    };
  }

  for (let i = 0; i < toIndex.length; i += PARALLEL_LIMIT) {
    const batch = toIndex.slice(i, i + PARALLEL_LIMIT);
    const batchNum = Math.floor(i / PARALLEL_LIMIT) + 1;

    console.log(`  📦 Batch ${batchNum}/${totalBatches} — spawning ${batch.length} Claude processes in parallel...`);
    batch.forEach(f => console.log(`     🔍 ${f.relativePath}`));

    // All files in this batch run as independent OS processes simultaneously
    const results = await Promise.all(
      batch.map(file => processFile(file))
    );

    // Store results
    for (const { relativePath, entry } of results) {
      index[relativePath] = entry;
      updated++;
      processed++;
    }

    // Save after every batch
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
    console.log(`     ✅ Batch ${batchNum} done — index saved\n`);
  }

  // Final summary
  console.log(`✅ Index built successfully`);
  console.log(`   Total files : ${files.length}`);
  console.log(`   Indexed     : ${updated} (new/updated)`);
  console.log(`   Unchanged   : ${processed - updated}`);
  console.log(`   Skipped     : ${skipped}`);
  console.log(`   Saved to    : ${INDEX_PATH}\n`);

  return index;
}