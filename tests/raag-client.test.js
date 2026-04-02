import { describe, it, before, after } from 'node:test';
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
