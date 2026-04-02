/**
 * enhancer.js
 * -----------
 * Takes raw prompt + matched file summaries (never source code).
 * Calls Claude via spawn + stdin with --no-session-persistence
 * so enhancement calls never appear in local Claude history.
 *
 * This is the ONLY file in the project that calls Claude.
 * One call per enhance invocation. Context capped at ~3,000 tokens.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'system_prompt.txt');

// Hard cap on context sent to Claude
// Prevents runaway tokens if RAAG returns unexpectedly large chunks
// ~3,000 tokens × 4 chars/token = 12,000 chars
const MAX_CONTEXT_CHARS = 12000;

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
// Cap context size
// ─────────────────────────────────────────

function capContext(context) {
  if (context.length <= MAX_CONTEXT_CHARS) return context;
  return context.slice(0, MAX_CONTEXT_CHARS) + '\n\n[Context truncated — showing top matches only]';
}

// ─────────────────────────────────────────
// Build Full Prompt
// ─────────────────────────────────────────

function buildFullPrompt(systemPrompt, rawPrompt, codebaseContext) {
  const safeContext = capContext(codebaseContext);

  return `${systemPrompt}

═══════════════════════════════════════════
CODEBASE CONTEXT (from project index)
═══════════════════════════════════════════

${safeContext}

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
// --no-session-persistence: zero history entries
// ─────────────────────────────────────────

function callClaude(fullPrompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

    const child = spawn('claude', ['-p', '--no-session-persistence', '-'], {
      shell: true,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      resolve({ success: false, error: 'Claude call timed out after 60s' });
    }, 60000);

    child.stdin.write(fullPrompt, 'utf8');
    child.stdin.end();

    child.stdout.on('data', (data) => { stdout += data.toString(); });

    child.on('close', () => {
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