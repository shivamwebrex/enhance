import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { discoverKBAndRAG } from '../indexer.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeClient(overrides = {}) {
  return {
    listKBs: overrides.listKBs ?? (async () => []),
    listRAGs: overrides.listRAGs ?? (async () => []),
  };
}

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

  it('returns found: false when listRAGs throws (non-fatal)', async () => {
    const client = makeClient({
      listKBs: async () => [{ id: 'kb-abc', name: 'myproject' }],
      listRAGs: async () => { throw new Error('network error'); },
    });

    const result = await discoverKBAndRAG('myproject', client);
    assert.equal(result.found, false);
  });
});
