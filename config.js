/**
 * config.js
 * ---------
 * Manages persistent config for prompt-enhancer.
 * Stores default project path so team never types it again.
 * 
 * Usage:
 *   enhance --set-project /path/to/project   → saves default project
 *   enhance --set-project                    → shows current config
 *   enhance "raw prompt"                     → uses saved project automatically
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ─────────────────────────────────────────
// Default config shape
// ─────────────────────────────────────────

const DEFAULT_CONFIG = {
  projectPath: null,       // Default project to index and match against
  model: 'claude',         // Future: support other models
  topK: 5,                 // Number of files to retrieve
  createdAt: null,
  updatedAt: null,
};

// ─────────────────────────────────────────
// Load config
// ─────────────────────────────────────────

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ─────────────────────────────────────────
// Save config
// ─────────────────────────────────────────

export function saveConfig(updates) {
  const current = loadConfig();
  const updated = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
    createdAt: current.createdAt || new Date().toISOString(),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

// ─────────────────────────────────────────
// Set default project path
// ─────────────────────────────────────────

export function setProjectPath(projectPath) {
  // Resolve to absolute path
  const absolutePath = path.resolve(projectPath);

  // Validate it exists
  if (!fs.existsSync(absolutePath)) {
    return {
      success: false,
      error: `Path does not exist: ${absolutePath}`,
    };
  }

  // Save
  const config = saveConfig({ projectPath: absolutePath });

  return {
    success: true,
    projectPath: absolutePath,
    config,
  };
}

// ─────────────────────────────────────────
// Get default project path
// ─────────────────────────────────────────

export function getProjectPath() {
  const config = loadConfig();
  return config.projectPath || null;
}