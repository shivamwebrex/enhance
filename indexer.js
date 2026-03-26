/**
 * indexer.js
 * ----------
 * Scans a project, generates Claude summaries, and uploads to RAAG.
 *
 * For each file:
 *   1. Extract structure (functions, imports, exports) — no Claude
 *   2. Claude writes a ≤50 word summary from the extract
 *   3. Prepend summary to file content and upload to RAAG KB
 *
 * Auto-creates KB + RAG model in RAAG on first init.
 * No local index file — RAAG is the single source of truth.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { glob } from 'glob';
import chalk from 'chalk';
import { getRaagClient } from './raag-client.js';
import { getProjectRaag } from './config.js';

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const FILE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'vue', 'py', 'go', 'rs', 'java', 'rb','html','css','cpp'];

const SKIP_DIRS = [
  'node_modules', '.git', 'dist', 'build',
  '.next', 'coverage', '.cache', 'public',
  '__pycache__', '.venv', 'venv', 'target',
];

const MAX_FILE_SIZE_KB = 100;
const PARALLEL_LIMIT = 10;

// Local cache for watcher change detection only
const CACHE_FILENAME = '.enhance-cache.json';

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

    // State/store variables
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

export function askClaudeSpawn(prompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

    const child = spawn('claude', ['-p', '-'], {
      shell: true,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      resolve(null);
    }, 35000);

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

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

export async function getSummaryFromClaude(extracted) {
  const prompt = `You are indexing a codebase. Given this file structure extract, write:
1. A summary of what this file does (max 50 words)
2. A comma-separated list of 5-8 keywords that developers would use to find this file

File: ${extracted.path}
Functions: ${extracted.functions.join(', ') || 'none'}
Imports: ${extracted.imports.join(', ') || 'none'}
Exports: ${extracted.exports.join(', ') || 'none'}
Key variables: ${extracted.variables.join(', ') || 'none'}
Comments: ${extracted.comments.join(' | ') || 'none'}

Respond in this exact format (no other text):
SUMMARY: <summary in max 50 words>
KEYWORDS: <keyword1, keyword2, keyword3, ...>`;

  const output = await askClaudeSpawn(prompt);

  if (!output) return buildFallbackSummary(extracted);

  const summaryMatch = output.match(/SUMMARY:\s*(.+)/);
  const keywordsMatch = output.match(/KEYWORDS:\s*(.+)/);

  if (summaryMatch && summaryMatch[1].trim()) {
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
// Summary prepend — adds context for RAAG
// ─────────────────────────────────────────

function prependSummary(content, summary, filePath) {
  const block = `<!-- RAAG-SUMMARY: ${summary} | File: ${filePath} -->\n`;
  return block + content;
}

// ─────────────────────────────────────────
// Local cache (for watcher change detection)
// ─────────────────────────────────────────

function getCachePath(projectPath) {
  return path.join(projectPath, CACHE_FILENAME);
}

function loadCache(projectPath) {
  const cachePath = getCachePath(projectPath);
  if (!fs.existsSync(cachePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(projectPath, cache) {
  fs.writeFileSync(getCachePath(projectPath), JSON.stringify(cache, null, 2));
}

// ─────────────────────────────────────────
// RAAG: Auto-create KB + RAG
// ─────────────────────────────────────────

/**
 * Ensure KB exists. Returns { kbId, ragId?, kbName, needsFullBuild }.
 * Does NOT build RAG here — that happens AFTER files are uploaded.
 */
async function ensureKBAndRAG(projectPath, raag) {
  let projConfig = getProjectRaag(projectPath);
  const projectName = path.basename(projectPath);

  // Check if existing config is valid
  if (projConfig && projConfig.kbId && projConfig.ragId) {
    raag.kbId = projConfig.kbId;
    raag.ragId = projConfig.ragId;

    // Verify RAG still exists in RAAG
    try {
      const status = await raag.getRAGStatus(projConfig.ragId);
      // RAG exists and has chunks — incremental mode
      if (status.status === 'ready' && status.total_chunks > 0) {
        return { ...projConfig, needsFullBuild: false };
      }
      // RAG exists but empty (0 chunks) — needs full rebuild
      console.log(chalk.yellow(`\n  ⚠  RAG model has 0 chunks. Will rebuild after upload.`));
      return { ...projConfig, needsFullBuild: true };
    } catch (err) {
      if (err.message.includes('404')) {
        console.log(chalk.yellow(`\n  ⚠  RAG model no longer exists in RAAG. Re-creating...`));
        const cachePath = path.join(projectPath, CACHE_FILENAME);
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
        // Fall through to create fresh
      } else {
        throw err;
      }
    }
  }

  // Create KB (or get existing)
  console.log(chalk.gray(`\n  Creating KB "${projectName}" in RAAG...`));
  const kb = await raag.createKB(projectName, `Codebase index for ${projectName}`);
  raag.kbId = kb.id;
  console.log(chalk.green(`  ✅ KB created: ${kb.name} (${kb.id})`));

  // DON'T build RAG yet — files need to be uploaded first
  // Save partial config (no ragId yet)
  projConfig = { kbId: kb.id, ragId: null, kbName: projectName, needsFullBuild: true };
  return projConfig;
}

/**
 * Build RAG model AFTER files have been uploaded to KB.
 */
async function buildRAGAfterUpload(projectPath, raag, projConfig) {
  const projectName = projConfig.kbName || path.basename(projectPath);

  console.log(chalk.gray(`\n  Building RAG model on ${projectName}...`));
  const rag = await raag.buildRAG(`${projectName}-search`, [raag.kbId]);
  raag.ragId = rag.id;
  console.log(chalk.green(`  ✅ RAG model created: ${rag.id}`));

  console.log(chalk.gray(`  Waiting for RAG build to complete...`));
  await raag.waitForReady(rag.id);
  console.log(chalk.green(`  ✅ RAG model ready`));

  // Now save full config with ragId
  const fullConfig = { kbId: raag.kbId, ragId: rag.id, kbName: projectName };
  writeProjectFiles(projectPath, fullConfig);

  return fullConfig;
}

// ─────────────────────────────────────────
// Write .claude/commands/enhance.md
// ─────────────────────────────────────────

function writeProjectFiles(projectPath, projConfig) {
  // 1. Write .claude/raag.json — stores KB/RAG IDs (committed with project)
  const claudeDir = path.join(projectPath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'raag.json'), JSON.stringify({
    kb: projConfig.kbName,
    kbId: projConfig.kbId,
    ragId: projConfig.ragId,
  }, null, 2) + '\n');

  // 2. Write .claude/commands/enhance.md — slash command for Claude Code
  const commandsDir = path.join(claudeDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });

  const content = `You MUST run this bash command first before doing anything else. Do NOT explore, search, or read files yourself. Just run this command:

\`\`\`bash
enhance "$ARGUMENTS"
\`\`\`

Wait for the command output. Then:

1. Display the enhanced prompt from the output to the user
2. Ask the user: "Proceed with this enhanced prompt, or would you like to edit it?"
3. Only after user confirms, answer the enhanced prompt by reading files and providing fixes
4. Do NOT skip the command. Do NOT do your own codebase search instead.
`;

  fs.writeFileSync(path.join(commandsDir, 'enhance.md'), content);
}

// ─────────────────────────────────────────
// Main: Build Index + Upload to RAAG
// ─────────────────────────────────────────

export async function buildIndex(projectPath, options = {}) {
  const { force = false } = options;

  if (!fs.existsSync(projectPath)) {
    console.error(`Project path not found: ${projectPath}`);
    process.exit(1);
  }

  // Get RAAG client
  const raag = getRaagClient(projectPath);
  if (!raag) {
    console.error(chalk.red('  RAAG not configured. Run any enhance command to set up API key.'));
    process.exit(1);
  }

  // Ensure KB exists (may or may not have RAG yet)
  const kbConfig = await ensureKBAndRAG(projectPath, raag);
  const needsFullBuild = kbConfig.needsFullBuild || !kbConfig.ragId;

  // Force re-index if RAG needs full build
  const cache = (force || needsFullBuild) ? {} : loadCache(projectPath);

  // Find files
  const pattern = `**/*.{${FILE_EXTENSIONS.join(',')}}`;
  const ignore = SKIP_DIRS.map(d => `**/${d}/**`);

  const files = await glob(pattern, {
    cwd: projectPath,
    ignore,
    absolute: true,
  });

  console.log(`  Found ${files.length} files in ${projectPath}\n`);

  // Pre-filter: separate unchanged from files needing indexing
  const toIndex = [];
  let skipped = 0;
  let unchanged = 0;

  for (const filePath of files) {
    const relativePath = path.relative(projectPath, filePath);

    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      skipped++;
      continue;
    }

    if (stats.size / 1024 > MAX_FILE_SIZE_KB) {
      skipped++;
      continue;
    }

    const mtime = stats.mtimeMs;

    // Skip unchanged files
    if (cache[relativePath] && cache[relativePath].mtime === mtime) {
      unchanged++;
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      skipped++;
      continue;
    }

    if (content.trim().length < 50) {
      skipped++;
      continue;
    }

    toIndex.push({ filePath, relativePath, content, mtime });
  }

  console.log(`  ${toIndex.length} need indexing | ${unchanged} unchanged | ${skipped} skipped\n`);

  if (toIndex.length === 0 && unchanged > 0) {
    // Still sync to RAAG so deleted files get removed
    console.log(chalk.gray('  No new files to index. Syncing to RAAG for deletion detection...\n'));

    const filesToSync = [];
    for (const filePath of files) {
      const relativePath = path.relative(projectPath, filePath);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.trim().length < 50) continue;
        const cachedSummary = cache[relativePath]?.summary || '';
        const withSummary = cachedSummary
          ? prependSummary(content, cachedSummary, relativePath)
          : content;
        filesToSync.push({ path: relativePath, content: withSummary });
      } catch { /* skip unreadable */ }
    }

    try {
      const syncResult = await raag.syncFiles(filesToSync, true);
      const deleted = syncResult.deleted?.length || 0;
      if (deleted > 0) {
        console.log(chalk.yellow(`  🗑  ${deleted} deleted files removed from RAAG`));
        if (syncResult.rebuild_triggered) {
          console.log(chalk.gray('  Waiting for rebuild...'));
          await raag.waitForReady();
        }
      }
      console.log(chalk.green('  ✅ Index is up to date.\n'));
    } catch (err) {
      console.error(chalk.red(`  ✗ Sync failed: ${err.message}`));
    }
    return;
  }

  // Process files in parallel batches (Claude summaries)
  const totalBatches = Math.ceil(toIndex.length / PARALLEL_LIMIT);
  const filesToSync = [];
  const newCache = { ...cache };

  for (let i = 0; i < toIndex.length; i += PARALLEL_LIMIT) {
    const batch = toIndex.slice(i, i + PARALLEL_LIMIT);
    const batchNum = Math.floor(i / PARALLEL_LIMIT) + 1;

    console.log(`  📦 Batch ${batchNum}/${totalBatches} — ${batch.length} files`);
    batch.forEach(f => console.log(chalk.gray(`     ${f.relativePath}`)));

    const results = await Promise.all(
      batch.map(async ({ relativePath, content, mtime }) => {
        const extracted = extractFileStructure(relativePath, content);
        const { summary } = await getSummaryFromClaude(extracted);

        const contentWithSummary = prependSummary(content, summary, relativePath);
        const structureSig = [extracted.functions, extracted.imports, extracted.exports].flat().join('|');

        return {
          relativePath,
          summary,
          contentWithSummary,
          cache: { mtime, structureSig, summary },
        };
      })
    );

    for (const r of results) {
      filesToSync.push({ path: r.relativePath, content: r.contentWithSummary });
      newCache[r.relativePath] = r.cache;
    }

    saveCache(projectPath, newCache);
    console.log(chalk.gray(`     ✅ Batch ${batchNum} done\n`));
  }

  // Include unchanged files in sync (full sync to RAAG)
  for (const filePath of files) {
    const relativePath = path.relative(projectPath, filePath);
    if (filesToSync.some(f => f.path === relativePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim().length < 50) continue;

      const cachedSummary = cache[relativePath]?.summary || '';
      const withSummary = cachedSummary
        ? prependSummary(content, cachedSummary, relativePath)
        : content;

      filesToSync.push({ path: relativePath, content: withSummary });
    } catch {
      // Skip unreadable files
    }
  }

  // Step 1: Upload files to KB FIRST
  console.log(chalk.bold(`  🔄 Uploading ${filesToSync.length} files to RAAG...`));

  try {
    const syncResult = await raag.syncFiles(filesToSync, true);
    console.log(
      chalk.green(`  ✅ Sync complete: `) +
      chalk.gray(`${syncResult.added?.length || 0} added, `) +
      chalk.gray(`${syncResult.updated?.length || 0} updated, `) +
      chalk.gray(`${syncResult.deleted?.length || 0} deleted`)
    );

    // Step 2: Build or rebuild RAG AFTER files are on disk
    if (needsFullBuild) {
      // First time or empty RAG — build fresh (files are now on disk)
      await buildRAGAfterUpload(projectPath, raag, kbConfig);
    } else if (syncResult.rebuild_triggered) {
      // Incremental rebuild was triggered by sync
      console.log(chalk.gray('  🔨 RAG incremental rebuild triggered'));
      console.log(chalk.gray('  Waiting for rebuild...'));
      await raag.waitForReady();
      console.log(chalk.green('  ✅ RAG rebuild complete'));
    } else {
      // Files changed but no auto-rebuild — trigger manually
      const hasChanges = (syncResult.added?.length || 0) + (syncResult.updated?.length || 0) + (syncResult.deleted?.length || 0) > 0;
      if (hasChanges) {
        console.log(chalk.gray('  🔨 Triggering RAG rebuild...'));
        try {
          await raag.triggerRebuild();
          console.log(chalk.gray('  Waiting for rebuild...'));
          await raag.waitForReady();
          console.log(chalk.green('  ✅ RAG rebuild complete'));
        } catch (err) {
          // If incremental fails, do full rebuild
          console.log(chalk.yellow(`  ⚠  Incremental rebuild failed, doing full rebuild...`));
          await buildRAGAfterUpload(projectPath, raag, kbConfig);
        }
      }
    }
  } catch (err) {
    console.error(chalk.red(`  ✗ RAAG sync failed: ${err.message}`));
    process.exit(1);
  }

  // Final summary
  console.log('');
  console.log(chalk.green('  ✅ Index complete'));
  console.log(chalk.gray(`     Files indexed : ${toIndex.length}`));
  console.log(chalk.gray(`     Files synced  : ${filesToSync.length}`));
  console.log(chalk.gray(`     Unchanged     : ${unchanged}`));
  console.log(chalk.gray(`     Skipped       : ${skipped}`));
  console.log('');
}
