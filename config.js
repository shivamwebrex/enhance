/**
 * config.js
 * ---------
 * Persistent config for Enhance CLI.
 *
 * Stores:
 * - apiKey: RAAG API key (global, one account)
 * - apiUrl: RAAG API URL
 * - projectPath: default project to work with
 * - projects: per-project KB/RAG IDs
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
  apiKey: null,                              // RAAG API key (raag_xxx)
  apiUrl: 'https://raag.zoxa.ai/api',         // RAAG API URL
  projectPath: null,                         // Default project path
  projects: {},                              // Per-project: { [path]: { kbId, ragId, kbName } }
  createdAt: null,
  updatedAt: null,
};

// ─────────────────────────────────────────
// Load / Save
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
// API Key
// ─────────────────────────────────────────

export function getApiKey() {
  return loadConfig().apiKey || null;
}

export function setApiKey(apiKey, apiUrl = null) {
  const updates = { apiKey };
  if (apiUrl) updates.apiUrl = apiUrl;
  return saveConfig(updates);
}

// ─────────────────────────────────────────
// Project Path
// ─────────────────────────────────────────

export function setProjectPath(projectPath) {
  const absolutePath = path.resolve(projectPath);
  if (!fs.existsSync(absolutePath)) {
    return { success: false, error: `Path does not exist: ${absolutePath}` };
  }
  saveConfig({ projectPath: absolutePath });
  return { success: true, projectPath: absolutePath };
}

export function getProjectPath() {
  return loadConfig().projectPath || null;
}

// ─────────────────────────────────────────
// Per-Project KB/RAG Config
// ─────────────────────────────────────────

export function setProjectRaag(projectPath, { kbId, ragId, kbName }) {
  const config = loadConfig();
  const projects = config.projects || {};
  projects[projectPath] = { kbId, ragId, kbName };
  return saveConfig({ projects });
}

export function getProjectRaag(projectPath) {
  // 1. Check config.json first
  const config = loadConfig();
  if (config.projects && config.projects[projectPath]) {
    return config.projects[projectPath];
  }

  // 2. Fallback: read from .claude/raag.json in project
  //    (committed with the project, survives fresh clones)
  try {
    const raagJson = path.join(projectPath, '.claude', 'raag.json');
    if (fs.existsSync(raagJson)) {
      const data = JSON.parse(fs.readFileSync(raagJson, 'utf8'));
      if (data.kbId && data.ragId) {
        return { kbId: data.kbId, ragId: data.ragId, kbName: data.kb || '' };
      }
    }
  } catch {
    // ignore read errors
  }

  return null;
}

/**
 * Check if RAAG is configured (API key exists).
 */
export function isConfigured() {
  return !!loadConfig().apiKey;
}
