/**
 * enhancer.js
 * -----------
 * Takes raw prompt + matched file contexts.
 * Calls Claude Code via spawn + stdin (same pattern as indexer.js)
 * for true async non-blocking execution.
 *
 * Using spawn instead of execSync:
 *   - Non-blocking — doesn't freeze the process
 *   - No shell argument length limits
 *   - Same pattern that achieves true parallelism in indexer.js
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'system_prompt.txt');

// ─────────────────────────────────────────
// Load System Prompt
// ─────────────────────────────────────────

function loadSystemPrompt() {
  if (!fs.existsSync(SYSTEM_PROMPT_PATH)) {
    throw new Error(`system_prompt.txt not found at ${SYSTEM_PROMPT_PATH}`);
  }
  return fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
}

// ─────────────────────────────────────────
// Build Full Prompt
// ─────────────────────────────────────────

function buildFullPrompt(systemPrompt, rawPrompt, codebaseContext) {
  return `${systemPrompt}

═══════════════════════════════════════════
CODEBASE CONTEXT (from project index)
═══════════════════════════════════════════

${codebaseContext}

═══════════════════════════════════════════
RAW PROMPT FROM DEVELOPER
═══════════════════════════════════════════

${rawPrompt}

═══════════════════════════════════════════
OUTPUT: Enhanced prompt only. No explanation. No preamble.
═══════════════════════════════════════════`;
}

// ─────────────────────────────────────────
// Call Claude via spawn + stdin
// Same pattern as indexer.js askClaudeSpawn
// ─────────────────────────────────────────

function callClaude(fullPrompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

    const child = spawn('claude', ['-p', '-'], {
      shell: true,
      windowsHide: true,
    });

    // 60s timeout
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      resolve({ success: false, error: 'Claude call timed out after 60s' });
    }, 60000);

    // Write prompt to stdin
    child.stdin.write(fullPrompt, 'utf8');
    child.stdin.end();

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      const output = stdout.trim();

      if (!output) {
        resolve({ success: false, error: 'Claude returned empty output' });
        return;
      }

      resolve({ success: true, output });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

// ─────────────────────────────────────────
// Parse Claude output
// ─────────────────────────────────────────

function parseOutput(output) {
  if (output.startsWith('NEEDS_MORE_CONTEXT:')) {
    return {
      type: 'needs_context',
      question: output.replace('NEEDS_MORE_CONTEXT:', '').trim(),
      enhanced: null,
    };
  }

  return {
    type: 'enhanced',
    question: null,
    enhanced: output,
  };
}

// ─────────────────────────────────────────
// Main: Enhance Prompt
// ─────────────────────────────────────────

export async function enhancePrompt(rawPrompt, codebaseContext) {
  let systemPrompt;
  try {
    systemPrompt = loadSystemPrompt();
  } catch (err) {
    return { success: false, error: err.message };
  }

  const fullPrompt = buildFullPrompt(systemPrompt, rawPrompt, codebaseContext);
  const result = await callClaude(fullPrompt);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const parsed = parseOutput(result.output);

  return {
    success: true,
    ...parsed,
  };
}