/**
 * indexer.js
 * ----------
 * Scans a project, extracts summaries from code comments, and uploads to RAAG.
 *
 * For each file:
 *   1. Extract comment+function pairs — pure regex, zero API cost
 *   2. Build summary from developer-written comments (primary)
 *   3. Fallback to exports/functions header if no comments found
 *   4. Prepend summary to file content and upload to RAAG KB
 *
 * Zero Claude calls during --init or lazy sync.
 * Claude fires once only — in enhancer.js when writing the enhanced prompt.
 */

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import { getRaagClient } from './raag-client.js';
import { getProjectRaag } from './config.js';

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────

const FILE_EXTENSIONS = ['js', 'jsx', 'ts', 'tsx', 'vue', 'py', 'go', 'rs', 'java', 'rb', 'html', 'css', 'cpp'];

const SKIP_DIRS = [
  'node_modules', '.git', 'dist', 'build',
  '.next', 'coverage', '.cache', 'public',
  '__pycache__', '.venv', 'venv', 'target',
];

const MAX_FILE_SIZE_KB = 100;
const PARALLEL_LIMIT = 20;
const CACHE_FILENAME = '.enhance-cache.json';

// ─────────────────────────────────────────
// Step 1: Extract comment + function pairs
// ─────────────────────────────────────────

/**
 * Walks file line by line and pairs comment blocks with the function below them.
 * Handles JSDoc (/** ), block comments (/* ), and single-line (//) styles.
 * Returns array of { fn, comment } objects.
 */
export function extractCommentsWithFunctions(content) {
  const lines = content.split('\n');
  const pairs = [];
  let pendingComment = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Accumulate comment lines
    if (
      trimmed.startsWith('/**') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('* ') ||
      trimmed === '*' ||
      trimmed.startsWith('//')
    ) {
      const clean = trimmed.replace(/^[/*\s]+/, '').trim();
      // Skip JSDoc tags (@param, @returns, etc) and very short noise
      if (clean.length > 4 && !clean.startsWith('@')) {
        pendingComment.push(clean);
      }
      continue;
    }

    // Function/const arrow line — pair with accumulated comment
    if (pendingComment.length > 0) {
      const fnMatch = trimmed.match(
        /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function)/
      );

      if (fnMatch) {
        const fnName = fnMatch[1] || fnMatch[2];
        const comment = pendingComment.join(' ').slice(0, 200);
        if (fnName && comment) {
          pairs.push({ fn: fnName, comment });
        }
      }
    }

    // Reset comment buffer on any non-comment, non-blank line
    if (trimmed.length > 0) {
      pendingComment = [];
    }
  }

  return pairs;
}

// ─────────────────────────────────────────
// Step 2: Build summary from comments (primary — zero API cost)
// ─────────────────────────────────────────

/**
 * Builds a semantic summary from developer-written comments.
 * Returns { summary, keywords } or null if no usable comments found.
 */
export function buildSummaryFromComments(filePath, content) {
  // Extract file-level comment block (first comment at top of file)
  const fileCommentMatch = content.match(/^(?:\/\*\*?[\s\S]*?\*\/|(?:\/\/[^\n]*\n){1,8})/);
  const fileComment = fileCommentMatch
    ? fileCommentMatch[0]
        .replace(/\/\*\*?|\*\//g, '')
        .replace(/^\s*\/\/\s?/gm, '')
        .replace(/^\s*\*\s?/gm, '')
        .trim()
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 4 && !l.startsWith('@'))
        .slice(0, 4)
        .join(' ')
    : '';

  // Extract per-function comment pairs
  const pairs = extractCommentsWithFunctions(content);

  if (pairs.length === 0 && !fileComment) {
    return null; // no comments found — caller will use fallback
  }

  const parts = [];
  if (fileComment) parts.push(fileComment);

  pairs.slice(0, 12).forEach(p => {
    parts.push(`${p.fn}: ${p.comment}`);
  });

  // Keywords: function names + meaningful words from comments
  const fnNames = pairs.map(p => p.fn.toLowerCase());

  const stopWords = new Set([
    'this', 'that', 'with', 'from', 'when', 'then', 'will', 'should',
    'returns', 'return', 'param', 'and', 'the', 'for', 'are', 'used',
    'called', 'each', 'all', 'any', 'into', 'after', 'before', 'based',
  ]);

  const commentWords = pairs
    .flatMap(p => p.comment.toLowerCase().split(/\W+/))
    .filter(w => w.length > 4 && !stopWords.has(w));

  const keywords = [...new Set([...fnNames, ...commentWords])].slice(0, 12);

  return {
    summary: parts.join('\n'),
    keywords,
  };
}

// ─────────────────────────────────────────
// Step 3: Fallback — exports/functions header (no comments found)
// ─────────────────────────────────────────

/**
 * Fallback for files with no comment blocks.
 * Uses extracted structure to build a structural header.
 * Still zero API cost.
 */
export function buildFallbackSummary(extracted) {
  const parts = [];

  if (extracted.classNames?.length > 0) {
    parts.push(`Classes: ${extracted.classNames.join(', ')}.`);
  }
  if (extracted.functions.length > 0) {
    parts.push(`Functions: ${extracted.functions.join(', ')}.`);
  }
  if (extracted.exports.length > 0) {
    parts.push(`Exports: ${extracted.exports.join(', ')}.`);
  }
  if (extracted.imports.length > 0) {
    parts.push(`Imports from: ${extracted.imports.slice(0, 10).join(', ')}.`);
  }
  if (extracted.variables.length > 0) {
    parts.push(`Key variables: ${extracted.variables.join(', ')}.`);
  }

  return {
    summary: parts.join('\n') || `File: ${extracted.path}`,
    keywords: [
      ...extracted.functions.slice(0, 5),
      ...extracted.exports.slice(0, 3),
      ...(extracted.classNames || []).slice(0, 2),
    ].map(k => k.toLowerCase()).filter(Boolean),
  };
}

// ─────────────────────────────────────────
// Step 4: Extract structure for cache sig
// ─────────────────────────────────────────

/**
 * Extracts structural elements (functions, imports, exports) from file.
 * Used only for structureSig cache invalidation in sync.js.
 * Not sent to any API.
 */
export function extractFileStructure(filePath, content) {
  const lines = content.split('\n');
  const extracted = {
    path: filePath,
    functions: [],
    classNames: [],
    imports: [],
    exports: [],
    variables: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (
      trimmed.match(/^(export\s+)?(async\s+)?function\s+\w+/) ||
      trimmed.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/) ||
      trimmed.match(/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?function/)
    ) {
      const match = trimmed.match(/(?:function|const)\s+(\w+)/);
      if (match) extracted.functions.push(match[1]);
    }

    if (trimmed.match(/^(export\s+)?(default\s+)?class\s+\w+/)) {
      const match = trimmed.match(/class\s+(\w+)/);
      if (match) extracted.classNames.push(match[1]);
    }

    if (trimmed.startsWith('import ')) {
      const match = trimmed.match(/from\s+['"](.+)['"]/);
      if (match) extracted.imports.push(match[1]);
    }

    if (trimmed.startsWith('export ')) {
      const match = trimmed.match(/export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/);
      if (match) extracted.exports.push(match[1]);
    }

    if (trimmed.match(/^(const|let)\s+\w+\s*=\s*(create|createSlice|useState|useReducer|atom)/)) {
      const match = trimmed.match(/^(?:const|let)\s+(\w+)/);
      if (match) extracted.variables.push(match[1]);
    }
  }

  extracted.functions = [...new Set(extracted.functions)].slice(0, 50);
  extracted.classNames = [...new Set(extracted.classNames)].slice(0, 20);
  extracted.imports = [...new Set(extracted.imports)].slice(0, 30);
  extracted.exports = [...new Set(extracted.exports)].slice(0, 30);
  extracted.variables = [...new Set(extracted.variables)].slice(0, 30);

  return extracted;
}

// ─────────────────────────────────────────
// Format content for RAAG KB
// ─────────────────────────────────────────

/**
 * Prepends summary block to raw source.
 * RAAG gets: summary + keywords + raw source.
 * matcher.js extracts summary only before sending to Claude.
 */
export function prependSummary(content, summary, keywords, filePath) {
  return [
    `=== FILE: ${filePath} ===`,
    '',
    summary,
    '',
    `=== KEYWORDS: ${keywords.join(', ')} ===`,
    '',
    `=== SOURCE CODE ===`,
    content,
  ].join('\n');
}

// ─────────────────────────────────────────
// Cache helpers
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

async function ensureKBAndRAG(projectPath, raag) {
  let projConfig = getProjectRaag(projectPath);
  const projectName = path.basename(projectPath);

  if (projConfig && projConfig.kbId && projConfig.ragId) {
    raag.kbId = projConfig.kbId;
    raag.ragId = projConfig.ragId;

    try {
      const status = await raag.getRAGStatus(projConfig.ragId);
      if (status.status === 'ready' && status.total_chunks > 0) {
        return { ...projConfig, needsFullBuild: false };
      }
      console.log(chalk.yellow(`\n  ⚠  RAG model has 0 chunks. Will rebuild after upload.`));
      return { ...projConfig, needsFullBuild: true };
    } catch (err) {
      if (err.message.includes('404')) {
        console.log(chalk.yellow(`\n  ⚠  RAG model no longer exists in RAAG. Re-creating...`));
        const cachePath = path.join(projectPath, CACHE_FILENAME);
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      } else {
        throw err;
      }
    }
  }

  console.log(chalk.gray(`\n  Creating KB "${projectName}" in RAAG...`));
  const kb = await raag.createKB(projectName, `Codebase index for ${projectName}`);
  raag.kbId = kb.id;
  console.log(chalk.green(`  ✅ KB created: ${kb.name} (${kb.id})`));

  projConfig = { kbId: kb.id, ragId: null, kbName: projectName, needsFullBuild: true };
  return projConfig;
}

async function buildRAGAfterUpload(projectPath, raag, projConfig) {
  const projectName = projConfig.kbName || path.basename(projectPath);

  console.log(chalk.gray(`\n  Building RAG model on ${projectName}...`));
  const rag = await raag.buildRAG(`${projectName}-search`, [raag.kbId]);
  raag.ragId = rag.id;
  console.log(chalk.green(`  ✅ RAG model created: ${rag.id}`));

  console.log(chalk.gray(`  Waiting for RAG build to complete...`));
  await raag.waitForReady(rag.id);
  console.log(chalk.green(`  ✅ RAG model ready`));

  const fullConfig = { kbId: raag.kbId, ragId: rag.id, kbName: projectName };
  writeProjectFiles(projectPath, fullConfig);

  return fullConfig;
}

// ─────────────────────────────────────────
// Write .claude/commands/enhance.md
// ─────────────────────────────────────────

function writeProjectFiles(projectPath, projConfig) {
  const claudeDir = path.join(projectPath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'raag.json'), JSON.stringify({
    kb: projConfig.kbName,
    kbId: projConfig.kbId,
    ragId: projConfig.ragId,
  }, null, 2) + '\n');

  const commandsDir = path.join(claudeDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });

  const content = `# Enhance Prompt

Run this command first — do not explore the project yourself:

\`\`\`bash
enhance "$ARGUMENTS"
\`\`\`

---

## Step 1 — Evaluate the output

After running the command, check what came back:

**If the enhanced prompt is specific** (mentions actual file paths, function names, variable names, or exact error locations) → go to Step 2.

**If the enhanced prompt is vague** (generic debugging advice, no file references, or the score is below 40%) → do NOT proceed. Go to Step 1a.

### Step 1a — Ask clarifying questions first

When context is thin, ask the user these before doing anything:

- What exact behaviour are you seeing vs what you expect?
- Which file or feature area does this involve?
- Did this break after a recent change? If so, what changed?
- Have you seen any error messages or logs?

Wait for answers. Then build an enhanced prompt yourself using their answers + the RAAG output. Show it to the user before proceeding.

---

## Step 2 — Validate the enhanced prompt

Show the enhanced prompt to the user exactly as returned (or as you built it in Step 1a).

Then ask:

> "Does this capture what you're trying to do? Confirm to proceed, or tell me what to adjust."

**Check before confirming:**
- Does it reference real files from this codebase?
- Does it describe the actual problem, not a generic version of it?
- Is the expected behaviour clearly stated?

If any of these are missing, flag it to the user and ask for the missing piece before proceeding.

---

## Step 3 — Execute only after confirmation

Once the user confirms:

1. Read only the files mentioned in the enhanced prompt
2. Trace the specific functions or logic paths referenced
3. Provide targeted fixes — do not do a broad codebase scan
4. Do NOT re-run enhance or explore beyond what the prompt specifies
`;

  fs.writeFileSync(path.join(commandsDir, 'enhance.md'), content);
}

// ─────────────────────────────────────────
// Main: Build Index + Upload to RAAG
// Zero Claude calls — comment extraction only
// ─────────────────────────────────────────

export async function buildIndex(projectPath, options = {}) {
  const { force = false } = options;

  if (!fs.existsSync(projectPath)) {
    console.error(`Project path not found: ${projectPath}`);
    process.exit(1);
  }

  const raag = getRaagClient(projectPath);
  if (!raag) {
    console.error(chalk.red('  RAAG not configured. Run any enhance command to set up API key.'));
    process.exit(1);
  }

  const kbConfig = await ensureKBAndRAG(projectPath, raag);
  const needsFullBuild = kbConfig.needsFullBuild || !kbConfig.ragId;
  const cache = (force || needsFullBuild) ? {} : loadCache(projectPath);

  const pattern = `**/*.{${FILE_EXTENSIONS.join(',')}}`;
  const ignore = SKIP_DIRS.map(d => `**/${d}/**`);

  const files = await glob(pattern, {
    cwd: projectPath,
    ignore,
    absolute: true,
  });

  console.log(`  Found ${files.length} files in ${projectPath}\n`);

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
    console.log(chalk.gray('  No new files to index. Syncing to RAAG for deletion detection...\n'));

    const filesToSync = [];
    for (const filePath of files) {
      const relativePath = path.relative(projectPath, filePath);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.trim().length < 50) continue;
        const cachedSummary = cache[relativePath]?.summary || '';
        const cachedKeywords = cache[relativePath]?.keywords || [];
        const withSummary = cachedSummary
          ? prependSummary(content, cachedSummary, cachedKeywords, relativePath)
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

  // Process files in parallel batches
  // Comment extraction — no API calls, runs at full CPU speed
  const totalBatches = Math.ceil(toIndex.length / PARALLEL_LIMIT);
  const filesToSync = [];
  const newCache = { ...cache };

  for (let i = 0; i < toIndex.length; i += PARALLEL_LIMIT) {
    const batch = toIndex.slice(i, i + PARALLEL_LIMIT);
    const batchNum = Math.floor(i / PARALLEL_LIMIT) + 1;

    process.stdout.write(chalk.gray(`  📦 Batch ${batchNum}/${totalBatches} — ${batch.length} files... `));

    const results = batch.map(({ relativePath, content, mtime }) => {
      // Primary: extract developer-written comments
      const commentResult = buildSummaryFromComments(relativePath, content);

      // Fallback: structural header if no comments found
      const extracted = extractFileStructure(relativePath, content);
      const { summary, keywords } = commentResult || buildFallbackSummary(extracted);

      // structureSig for cache invalidation
      const structureSig = [
        ...extracted.functions,
        ...extracted.imports,
        ...extracted.exports,
      ].join('|');

      const contentWithSummary = prependSummary(content, summary, keywords, relativePath);

      return {
        relativePath,
        summary,
        keywords,
        contentWithSummary,
        cache: { mtime, structureSig, summary, keywords },
      };
    });

    for (const r of results) {
      filesToSync.push({ path: r.relativePath, content: r.contentWithSummary });
      newCache[r.relativePath] = r.cache;
    }

    saveCache(projectPath, newCache);
    console.log(chalk.green('done'));
  }

  // Include unchanged files in sync (needed for RAAG deletion detection)
  for (const filePath of files) {
    const relativePath = path.relative(projectPath, filePath);
    if (filesToSync.some(f => f.path === relativePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim().length < 50) continue;

      const cachedSummary = cache[relativePath]?.summary || '';
      const cachedKeywords = cache[relativePath]?.keywords || [];
      const withSummary = cachedSummary
        ? prependSummary(content, cachedSummary, cachedKeywords, relativePath)
        : content;

      filesToSync.push({ path: relativePath, content: withSummary });
    } catch {
      // Skip unreadable files
    }
  }

  console.log('');
  console.log(chalk.bold(`  🔄 Uploading ${filesToSync.length} files to RAAG...`));

  try {
    const syncResult = await raag.syncFiles(filesToSync, true);
    console.log(
      chalk.green(`  ✅ Sync complete: `) +
      chalk.gray(`${syncResult.added?.length || 0} added, `) +
      chalk.gray(`${syncResult.updated?.length || 0} updated, `) +
      chalk.gray(`${syncResult.deleted?.length || 0} deleted`)
    );

    if (needsFullBuild) {
      await buildRAGAfterUpload(projectPath, raag, kbConfig);
    } else if (syncResult.rebuild_triggered) {
      console.log(chalk.gray('  🔨 RAG incremental rebuild triggered'));
      console.log(chalk.gray('  Waiting for rebuild...'));
      await raag.waitForReady();
      console.log(chalk.green('  ✅ RAG rebuild complete'));
    } else {
      const hasChanges =
        (syncResult.added?.length || 0) +
        (syncResult.updated?.length || 0) +
        (syncResult.deleted?.length || 0) > 0;

      if (hasChanges) {
        console.log(chalk.gray('  🔨 Triggering RAG rebuild...'));
        try {
          await raag.triggerRebuild();
          console.log(chalk.gray('  Waiting for rebuild...'));
          await raag.waitForReady();
          console.log(chalk.green('  ✅ RAG rebuild complete'));
        } catch (err) {
          console.log(chalk.yellow(`  ⚠  Incremental rebuild failed, doing full rebuild...`));
          await buildRAGAfterUpload(projectPath, raag, kbConfig);
        }
      }
    }
  } catch (err) {
    console.error(chalk.red(`  ✗ RAAG sync failed: ${err.message}`));
    process.exit(1);
  }

  console.log('');
  console.log(chalk.green('  ✅ Index complete'));
  console.log(chalk.gray(`     Files indexed : ${toIndex.length}`));
  console.log(chalk.gray(`     Files synced  : ${filesToSync.length}`));
  console.log(chalk.gray(`     Unchanged     : ${unchanged}`));
  console.log(chalk.gray(`     Skipped       : ${skipped}`));
  console.log(chalk.gray(`     Claude calls  : 0`));
  console.log('');
}