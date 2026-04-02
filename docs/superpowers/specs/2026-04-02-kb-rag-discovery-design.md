# Design: KB + RAG Discovery on Init

**Date:** 2026-04-02  
**Branch:** comment-extract  
**Files affected:** `raag-client.js`, `indexer.js`

---

## Problem

`enhance --init` always creates a new KB when no local `.claude/raag.json` exists. On a fresh clone or new machine, this produces a duplicate KB in RAAG for the same project. The user must manually clean up orphaned KBs.

## Goal

Before creating a KB, check RAAG for an existing KB matching the project name. If found, reuse it. Also look for a ready RAG model built from that KB. If found, skip the full build entirely and proceed directly to change detection + sync.

---

## Architecture

No new files. Two methods added to `RaagClient`, one updated function in `indexer.js`.

### raag-client.js

Add two list methods:

**`listKBs()`**
- `GET /api/kb?limit=100`
- Returns array of KB objects `{ id, name, ... }`
- Uses `_requestWithRetry` with `DEFAULT_TIMEOUT_MS`

**`listRAGs()`**
- `GET /api/rag?limit=100`
- Returns array of RAG objects `{ id, name, status, kb_ids, ... }`
- Uses `_requestWithRetry` with `DEFAULT_TIMEOUT_MS`

Pagination is omitted — projects are unlikely to have >100 KBs/RAGs per account.

### indexer.js — `ensureKBAndRAG`

Updated decision flow:

```
1. Load projConfig from .claude/raag.json

2. If projConfig.kbId + projConfig.ragId:
     → Verify RAG status (existing fast-path, unchanged)

3. If projConfig.kbId, no ragId:
     → Skip to step 5 (reuse kbId, needsFullBuild: true)

4. NEW — If no kbId in local config:
     a. Call listKBs() → find KB where kb.name === projectName
     b. If found → call listRAGs() → find first ready RAG where rag.kb_ids includes kb.id
     c. Both found → save to .claude/raag.json, return { needsFullBuild: false }
     d. KB found, no ready RAG → save kbId only, return { needsFullBuild: true }
     e. No KB found → create new KB (existing behavior)

5. If needsFullBuild → sync + buildRAGAfterUpload (unchanged)
```

---

## Data Flow

```
enhance --init
  └─ buildIndex()
       └─ ensureKBAndRAG()
            ├─ [fast path] local raag.json has kbId+ragId → verify status → done
            ├─ [new] no local config → listKBs() + listRAGs() → populate IDs
            │    ├─ found both  → needsFullBuild: false → sync only
            │    ├─ found KB    → needsFullBuild: true  → sync + build RAG
            │    └─ found none  → create KB             → sync + build RAG
            └─ [existing] create KB if not found
```

---

## Error Handling

- If `listKBs()` or `listRAGs()` throws (network, auth, 5xx): catch the error, log a yellow warning, fall through to KB creation. Discovery is best-effort; a lookup failure must never block `--init`.
- Matching is by exact `kb.name === projectName` (case-sensitive, same as creation).
- If multiple KBs match the name, use the first result (most recently created by API default).
- If multiple ready RAGs reference the KB, use the first ready one found.

---

## Console Output

Discovery success (both found):
```
  Found existing KB "myproject" in RAAG (id: abc-123)
  Found existing RAG model (id: xyz-456) — skipping full build
```

KB found, no RAG:
```
  Found existing KB "myproject" in RAAG — no RAG model yet, will build after sync
```

Discovery lookup failed (non-fatal):
```
  ⚠  Could not check for existing KB: <error message>. Creating new KB...
```

---

## What Does NOT Change

- `sync.js` — untouched
- `buildRAGAfterUpload` — untouched
- `buildIndex` — untouched (calls `ensureKBAndRAG` the same way)
- Cache logic — untouched
- All other raag-client methods — untouched

---

## Out of Scope

- Pagination for accounts with >100 KBs/RAGs
- Interactive KB selection if multiple name matches exist
- Discovery during `enhance` (query path) — only `--init` is affected
