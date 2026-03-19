/**
 * enhancer.js
 * -----------
 * Takes raw prompt + matched file contexts.
 * Makes a single Claude Code CLI call that:
 *   1. Semantically selects the most relevant files
 *   2. Generates the enhanced prompt grounded in real codebase context
 * 
 * Returns enhanced prompt string.
 */

import { execSync } from 'child_process';
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
// Build Full Prompt For Claude
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
// Call Claude Code CLI
// ─────────────────────────────────────────

function callClaude(fullPrompt) {
  try {
    const result = execSync(
      `claude -p ${JSON.stringify(fullPrompt)}`,
      {
        encoding: 'utf8',
        timeout: 60000, // 60s max
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return { success: true, output: result.trim() };
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';

    // Claude sometimes exits non-zero but still returns output
    if (stdout.trim().length > 0) {
      return { success: true, output: stdout.trim() };
    }

    return {
      success: false,
      error: stderr || err.message || 'Claude CLI call failed',
    };
  }
}

// ─────────────────────────────────────────
// Handle NEEDS_MORE_CONTEXT response
// ─────────────────────────────────────────

function parseOutput(output) {
  if (output.startsWith('NEEDS_MORE_CONTEXT:')) {
    const question = output.replace('NEEDS_MORE_CONTEXT:', '').trim();
    return {
      type: 'needs_context',
      question,
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
  // Load system prompt
  let systemPrompt;
  try {
    systemPrompt = loadSystemPrompt();
  } catch (err) {
    return { success: false, error: err.message };
  }

  // Build the full prompt
  const fullPrompt = buildFullPrompt(systemPrompt, rawPrompt, codebaseContext);

  // Call Claude
  const result = callClaude(fullPrompt);

  if (!result.success) {
    return {
      success: false,
      error: result.error,
    };
  }

  // Parse output
  const parsed = parseOutput(result.output);

  return {
    success: true,
    ...parsed,
  };
}