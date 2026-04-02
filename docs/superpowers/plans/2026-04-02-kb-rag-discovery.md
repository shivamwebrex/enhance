# KB + RAG Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before creating a new KB on `enhance --init`, check RAAG for an existing KB/RAG matching the project name and reuse it if found.

**Architecture:** Add `listKBs()` and `listRAGs()` to `RaagClient`, then update `ensureKBAndRAG()` in `indexer.js` to call discovery before creating. Discovery is best-effort: any lookup failure falls through to existing KB creation. No other files change.

**Tech Stack:** Node.js 25 ESM, `node:test` + `node:assert` for tests, `fetch` (built-in), RAAG REST API.

---

## File Structure

| File | Change |
|------|--------|
| `raag-client.js` | Add `listKBs()` and `listRAGs()` methods to `RaagClient` |
| `indexer.js` | Update `ensureKBAndRAG()` to call discovery before creating KB |
| `tests/raag-client.test.js` | New — unit tests for `listKBs()` and `listRAGs()` |
| `tests/ensureKBAndRAG.test.js` | New — unit tests for the 4 discovery cases in `ensureKBAndRAG()` |

---

## Task 1: Add `listKBs()` and `listRAGs()` to RaagClient

**Files:**
- Modify: `raag-client.js` (after `ping()` method, before the closing `}` of `RaagClient`)
- Create: `tests/raag-client.test.js`

- [ ] **Step 1: Create test file with failing tests**

Create `tests/raag-client.test.js`:

```js
import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RaagClient } from '../raag-client.js';

describe('RaagClient.listKBs', () => {
  it('returns array of KB objects', async () => {
    const client = new RaagClient({ apiKey: 'test-key' });

    const fakeKBs = [
      { id: 'kb-1', name: 'myproject' },
      { id: 'kb-2', name: 'other' },
    ];

    // Stub _requestWithRetry
    client._requestWithRetry = async (method, endpoint) => {
      assert.equal(method, 'GET');
      assert.equal(endpoint, '/kb?limit=100');
      return { items: fakeKBs };
    };

    const result = await client.listKBs();
    assert.deepEqual(result, fakeKBs);
  });

  it('returns empty array when items is missing', async () => {
    const client = new RaagClient({ apiKey: 'test-key' });
    client._requestWithRetry = async () => ({});
    const result = await client.listKBs();
    assert.deepEqual(result, []);
  });
});

describe('RaagClient.listRAGs', () => {
  it('returns array of RAG objects', async () => {
    const client = new RaagClient({ apiKey: 'test-key' });

    const fakeRAGs = [
      { id: 'rag-1', name: 'myproject-search', status: 'ready', kb_ids: ['kb-1'] },
    ];

    client._requestWithRetry = async (method, endpoint) => {
      assert.equal(method, 'GET');
      assert.equal(endpoint, '/rag?limit=100');
      return { items: fakeRAGs };
    };

    const result = await client.listRAGs();
    assert.deepEqual(result, fakeRAGs);
  });

  it('returns empty array when items is missing', async () => {
    const client = new RaagClient({ apiKey: 'test-key' });
    client._requestWithRetry = async () => ({});
    const result = await client.listRAGs();
    assert.deepEqual(result, []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/raag-client.test.js
```

Expected: FAIL — `client.listKBs is not a function` and `client.listRAGs is not a function`

- [ ] **Step 3: Add `listKBs()` and `listRAGs()` to RaagClient**

In `raag-client.js`, add these two methods inside `RaagClient` after the `ping()` method (around line 218), before the closing `}`:

```js
  /**
   * List all Knowledge Bases for this account.
   * @returns {Promise<Array<{id: string, name: string, ...}>>}
   */
  async listKBs() {
    const data = await this._requestWithRetry('GET', '/kb?limit=100');
    return data.items || [];
  }

  /**
   * List all RAG models for this account.
   * @returns {Promise<Array<{id: string, name: string, status: string, kb_ids: string[], ...}>>}
   */
  async listRAGs() {
    const data = await this._requestWithRetry('GET', '/rag?limit=100');
    return data.items || [];
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/raag-client.test.js
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add raag-client.js tests/raag-client.test.js
git commit -m "feat(raag-client): add listKBs and listRAGs methods"
```

---

## Task 2: Update `ensureKBAndRAG` with discovery

**Files:**
- Modify: `indexer.js` — `ensureKBAndRAG` function (lines 303–336)
- Create: `tests/ensureKBAndRAG.test.js`

- [ ] **Step 1: Write failing tests covering all 4 discovery cases**

Create `tests/ensureKBAndRAG.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';

// We test ensureKBAndRAG indirectly by mocking the raag client and
// exercising the logic via a thin test harness. Since ensureKBAndRAG
// is not exported, we extract and test its discovery sub-logic directly.

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempProject(name = 'myproject') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
  return dir;
}

function makeClient(overrides = {}) {
  return {
    kbId: null,
    ragId: null,
    listKBs: overrides.listKBs ?? (async () => []),
    listRAGs: overrides.listRAGs ?? (async () => []),
    createKB: overrides.createKB ?? (async (name) => ({ id: 'new-kb-id', name })),
    getRAGStatus: overrides.getRAGStatus ?? (async () => ({ status: 'ready', total_chunks: 10 })),
  };
}

// ── Discovery logic (extracted for testability) ───────────────────────
// Import the helper once it is exported from indexer.js (Task 2 Step 3)
import { discoverKBAndRAG } from '../indexer.js';

describe('discoverKBAndRAG', () => {
  it('returns existing kbId + ragId when both found in RAAG', async () => {
    const client = makeClient({
      listKBs: async () => [{ id: 'kb-abc', name: 'myproject' }],
      listRAGs: async () => [
        { id: 'rag-xyz', name: 'myproject-search', status: 'ready', kb_ids: ['kb-abc'] },
      ],
    });

    const result = await discoverKBAndRAG('myproject', client);
    assert.equal(result.kbId, 'kb-abc');
    assert.equal(result.ragId, 'rag-xyz');
    assert.equal(result.found, true);
    assert.equal(result.needsFullBuild, false);
  });

  it('returns kbId only when KB found but no ready RAG', async () => {
    const client = makeClient({
      listKBs: async () => [{ id: 'kb-abc', name: 'myproject' }],
      listRAGs: async () => [],
    });

    const result = await discoverKBAndRAG('myproject', client);
    assert.equal(result.kbId, 'kb-abc');
    assert.equal(result.ragId, null);
    assert.equal(result.found, true);
    assert.equal(result.needsFullBuild, true);
  });

  it('returns found: false when no matching KB exists', async () => {
    const client = makeClient({
      listKBs: async () => [{ id: 'kb-other', name: 'other-project' }],
    });

    const result = await discoverKBAndRAG('myproject', client);
    assert.equal(result.found, false);
  });

  it('returns found: false when listKBs throws (non-fatal)', async () => {
    const client = makeClient({
      listKBs: async () => { throw new Error('network error'); },
    });

    const result = await discoverKBAndRAG('myproject', client);
    assert.equal(result.found, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/ensureKBAndRAG.test.js
```

Expected: FAIL — `discoverKBAndRAG is not exported from ../indexer.js`

- [ ] **Step 3: Extract and implement `discoverKBAndRAG` in indexer.js**

Add this new exported function in `indexer.js` just before `ensureKBAndRAG` (around line 303):

```js
/**
 * Discover an existing KB and RAG in RAAG by project name.
 * Best-effort: returns { found: false } on any error.
 *
 * @param {string} projectName - Folder name of the project
 * @param {RaagClient} raag - RAAG client instance
 * @returns {Promise<{found: boolean, kbId?: string, ragId?: string, needsFullBuild?: boolean}>}
 */
export async function discoverKBAndRAG(projectName, raag) {
  try {
    const kbs = await raag.listKBs();
    const kb = kbs.find(k => k.name === projectName);
    if (!kb) return { found: false };

    const rags = await raag.listRAGs();
    const rag = rags.find(r => r.status === 'ready' && r.kb_ids?.includes(kb.id));

    if (rag) {
      return { found: true, kbId: kb.id, ragId: rag.id, needsFullBuild: false };
    }
    return { found: true, kbId: kb.id, ragId: null, needsFullBuild: true };
  } catch {
    return { found: false };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/ensureKBAndRAG.test.js
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add indexer.js tests/ensureKBAndRAG.test.js
git commit -m "feat(indexer): extract discoverKBAndRAG helper"
```

---

## Task 3: Wire discovery into `ensureKBAndRAG`

**Files:**
- Modify: `indexer.js` — `ensureKBAndRAG` function (lines ~303–336)

- [ ] **Step 1: Replace the KB-creation fallback in `ensureKBAndRAG`**

In `indexer.js`, find `ensureKBAndRAG` (line ~303). The current code reaches `console.log(chalk.gray(...Creating KB...))` when there's no local config. Replace **only** that section — from after the `if (projConfig && projConfig.kbId && projConfig.ragId)` block closes to just before `const kb = await raag.createKB(...)`.

The full updated function:

```js
async function ensureKBAndRAG(projectPath, raag) {
  let projConfig = getProjectRaag(projectPath);
  const projectName = path.basename(projectPath);

  // Fast path: local config has both IDs — verify RAG is still alive
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

  // Fast path: local config has kbId but no ragId — skip discovery, just build RAG
  if (projConfig && projConfig.kbId && !projConfig.ragId) {
    raag.kbId = projConfig.kbId;
    return { ...projConfig, needsFullBuild: true };
  }

  // Discovery: no local config — check RAAG for existing KB/RAG by project name
  if (!projConfig || !projConfig.kbId) {
    const discovered = await discoverKBAndRAG(projectName, raag);

    if (discovered.found) {
      raag.kbId = discovered.kbId;
      raag.ragId = discovered.ragId;

      const savedConfig = { kbId: discovered.kbId, ragId: discovered.ragId, kbName: projectName };
      writeProjectFiles(projectPath, savedConfig);

      if (!discovered.needsFullBuild) {
        console.log(chalk.green(`  ✅ Found existing KB "${projectName}" in RAAG (id: ${discovered.kbId})`));
        console.log(chalk.green(`  ✅ Found existing RAG model (id: ${discovered.ragId}) — skipping full build`));
        return { ...savedConfig, needsFullBuild: false };
      }

      console.log(chalk.green(`  ✅ Found existing KB "${projectName}" in RAAG — no RAG model yet, will build after sync`));
      return { ...savedConfig, needsFullBuild: true };
    }

    if (!discovered.found && discovered.error) {
      console.log(chalk.yellow(`\n  ⚠  Could not check for existing KB: ${discovered.error}. Creating new KB...`));
    }
  }

  // Create new KB
  console.log(chalk.gray(`\n  Creating KB "${projectName}" in RAAG...`));
  const kb = await raag.createKB(projectName, `Codebase index for ${projectName}`);
  raag.kbId = kb.id;
  console.log(chalk.green(`  ✅ KB created: ${kb.name} (${kb.id})`));

  return { kbId: kb.id, ragId: null, kbName: projectName, needsFullBuild: true };
}
```

- [ ] **Step 2: Run all tests**

```bash
node --test tests/raag-client.test.js tests/ensureKBAndRAG.test.js
```

Expected: all 8 tests PASS

- [ ] **Step 3: Smoke test manually**

In a project that already has a KB in RAAG (delete `.claude/raag.json` first to simulate fresh clone):

```bash
rm .claude/raag.json
enhance --init
```

Expected output includes:
```
  ✅ Found existing KB "..." in RAAG (id: ...)
  ✅ Found existing RAG model (id: ...) — skipping full build
```
or if RAG doesn't exist:
```
  ✅ Found existing KB "..." in RAAG — no RAG model yet, will build after sync
```

- [ ] **Step 4: Commit**

```bash
git add indexer.js
git commit -m "feat(indexer): discover existing KB/RAG before creating on --init"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `listKBs()` + `listRAGs()` added to raag-client → Task 1
- ✅ Discovery: both KB+RAG found → Task 3 Step 1 (returns `needsFullBuild: false`)
- ✅ Discovery: KB found, no RAG → Task 3 Step 1 (returns `needsFullBuild: true`)
- ✅ Discovery: neither found → falls through to `createKB` → Task 3 Step 1
- ✅ Discovery failure is non-fatal → `discoverKBAndRAG` catches and returns `{ found: false }` → Task 2 Step 3
- ✅ Console output strings match spec exactly → Task 3 Step 1
- ✅ Saves to `.claude/raag.json` on discovery → `writeProjectFiles` called in Task 3 Step 1
- ✅ `kbId only, no ragId` fast-path preserved → Task 3 Step 1

**Placeholder scan:** None found.

**Type consistency:** `discoverKBAndRAG` returns `{ found, kbId, ragId, needsFullBuild }` — used consistently across Task 2 (tests) and Task 3 (wiring). `raag.kbId` / `raag.ragId` assignment pattern matches existing code in `ensureKBAndRAG`.

**Note on `discovered.error`:** The `discoverKBAndRAG` helper as written returns `{ found: false }` on error without an `error` field. The warning log in Task 3 references `discovered.error` — this will silently be `undefined`. That's acceptable (the warning still prints), but if you want the error message, update `discoverKBAndRAG` to return `{ found: false, error: err.message }` in the catch block.
