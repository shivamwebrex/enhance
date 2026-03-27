/**
 * raag-client.js
 * ---------------
 * Primary API client for RAAG. Enhance is fully dependent on RAAG
 * for semantic search — no local fallback.
 *
 * Features:
 * - Timeout (10s default) on all requests via AbortController
 * - Retry with exponential backoff (2 retries) on transient failures
 * - JSON response validation
 * - Methods for KB creation, RAG build, file sync, and query
 */

import { loadConfig, getProjectRaag } from './config.js';

const DEFAULT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const RETRY_BACKOFFS = [1000, 2000];

// ─────────────────────────────────────────
// RAAG Client
// ─────────────────────────────────────────

class RaagClient {
  /**
   * @param {{ apiKey: string, kbId?: string, ragId?: string }} opts
   */
  constructor({ apiKey, kbId = null, ragId = null }) {
    this.apiUrl = 'https://raag.zoxa.ai/api';
    this.apiKey = apiKey;
    this.kbId = kbId;
    this.ragId = ragId;
  }

  /**
   * Core authenticated request with timeout.
   */
  async _request(method, endpoint, body = null, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const url = `${this.apiUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const opts = { method, headers, signal: controller.signal };
    if (body) opts.body = JSON.stringify(body);

    try {
      const res = await fetch(url, opts);
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`RAAG API error ${res.status}: ${text}`);
      }

      const data = await res.json();
      if (data === null || typeof data !== 'object') {
        throw new Error(`RAAG API returned invalid JSON from ${endpoint}`);
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`RAAG API timeout after ${timeoutMs}ms: ${method} ${endpoint}`);
      }
      throw err;
    }
  }

  /**
   * Request with retry logic — retries on network errors and 5xx.
   */
  async _requestWithRetry(method, endpoint, body = null, timeoutMs = DEFAULT_TIMEOUT_MS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._request(method, endpoint, body, timeoutMs);
      } catch (err) {
        const isRetryable =
          err.message.includes('timeout') ||
          err.message.includes('fetch failed') ||
          err.message.includes('ECONNREFUSED') ||
          /RAAG API error 5\d\d/.test(err.message);

        if (!isRetryable || attempt === MAX_RETRIES) throw err;
        await new Promise(r => setTimeout(r, RETRY_BACKOFFS[attempt]));
      }
    }
  }

  // ─── KB Operations ────────────────────

  /**
   * Create a new Knowledge Base.
   * Returns existing KB if name already exists.
   * @param {string} name - KB name (typically project folder name)
   * @param {string} [description] - Optional description
   * @returns {Promise<{id: string, domain: string, name: string, ...}>}
   */
  async createKB(name, description = null) {
    const body = { name };
    if (description) body.description = description;
    return this._requestWithRetry('POST', '/kb', body);
  }

  /**
   * Batch sync files to KB.
   * @param {Array<{path: string, content: string}>} files
   * @param {boolean} deleteMissing - Delete files not in the list
   * @returns {Promise<{added: string[], updated: string[], deleted: string[], unchanged: number, rebuild_triggered: boolean}>}
   */
  async syncFiles(files, deleteMissing = false) {
    if (!this.kbId) throw new Error('kbId not set — run enhance --init first');

    const body = { files, delete_missing: deleteMissing };
    if (this.ragId) body.rag_id = this.ragId;

    // Sync can be large — give it more time
    return this._requestWithRetry('POST', `/kb/${this.kbId}/sync`, body, 60000);
  }

  // ─── RAG Operations ───────────────────

  /**
   * Build a new RAG model from KBs.
   * @param {string} name - RAG model name
   * @param {string[]} kbIds - Knowledge base IDs to include
   * @returns {Promise<{id: string, status: string, ...}>}
   */
  async buildRAG(name, kbIds) {
    return this._requestWithRetry('POST', '/rag/build', {
      name,
      kb_ids: kbIds,
      smart_chunking: true,
      remove_links: true,
      remove_images: true,
      remove_html_tags: true,
    });
  }

  /**
   * Get RAG model status.
   */
  async getRAGStatus(ragId = null) {
    const id = ragId || this.ragId;
    if (!id) throw new Error('ragId not set — run enhance --init first');
    return this._requestWithRetry('GET', `/rag/${id}`);
  }

  /**
   * Semantic search over the RAG model.
   * @param {string} query - Search query
   * @param {number} topK - Number of results
   * @returns {Promise<{results: Array<{source: string, content: string, score: number}>, total: number}>}
   */
  async queryFiles(query, topK = 5) {
    if (!this.ragId) throw new Error('ragId not set — run enhance --init first');

    const data = await this._requestWithRetry(
      'POST', `/rag/${this.ragId}/query`,
      { query, top_k: topK },
      QUERY_TIMEOUT_MS,
    );

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error('RAAG query: response missing "results" array');
    }
    return data;
  }

  /**
   * Trigger incremental rebuild after file sync
   */
  async triggerRebuild(sources = null) {
    if (!this.ragId) throw new Error('ragId not set');
    return this._requestWithRetry(
      'POST', `/rag/${this.ragId}/incremental-rebuild`,
      sources ? { sources } : {},
    );
  }

  /**
   * Poll until RAG model build is ready.
   * @param {string} [ragId] - Override ragId
   * @param {number} [pollMs=2000]
   * @param {number} [timeoutMs=900000] - 15 minute timeout
   */
  async waitForReady(ragId = null, pollMs = 2000, timeoutMs = 300000) {
    const id = ragId || this.ragId;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const status = await this.getRAGStatus(id);
      if (status.status === 'ready') return status;
      if (status.status === 'failed') {
        throw new Error(`RAG build failed: ${status.error_message || 'unknown error'}`);
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error('RAG build timed out after 5 minutes');
  }

  /**
   * Test connection + auth. Returns true if RAAG is reachable and key is valid.
   */
  async ping() {
    try {
      // Use /kb list as a lightweight auth check
      await this._request('GET', '/kb?limit=1', null, 5000);
      return true;
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────
// Factory
// ─────────────────────────────────────────

/**
 * Get a RaagClient from saved config.
 * @param {string} [projectPath] - Optional project to load KB/RAG IDs for
 * @returns {RaagClient|null} - null if API key not configured
 */
export function getRaagClient(projectPath = null) {
  const config = loadConfig();

  if (!config.apiKey) return null;

  const opts = {
    apiKey: config.apiKey,
  };

  // Load per-project KB/RAG IDs from .claude/raag.json
  if (projectPath) {
    const proj = getProjectRaag(projectPath);
    if (proj) {
      opts.kbId = proj.kbId;
      opts.ragId = proj.ragId;
    }
  }

  return new RaagClient(opts);
}

/**
 * Create a RaagClient with just an API key (for initial setup/validation).
 */
export function createClientWithKey(apiKey) {
  return new RaagClient({ apiKey });
}

export { RaagClient };
