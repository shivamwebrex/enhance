# ⚡ Enhance

Codebase-aware prompt enhancement powered by [RAAG](https://raag.zoxa.ai).

Write a vague prompt → get a precise, file-specific, actionable prompt back.
Works as a terminal CLI or as a `/enhance` slash command inside Claude Code.

---

## How It Works

```
You type:    "call logs page showing no calls found"

You get:     Investigate why the call logs page renders empty. In CallLogs.jsx,
             check if the fetch is firing on mount and whether the response
             is being mapped correctly to local state. In callStore.js, verify
             the fetchCallLogs action handles empty arrays vs null differently.
             In callsApi.js, confirm the GET /calls endpoint returns the correct
             shape. Expected: logs render when data exists.
```

Enhance scans your codebase, uploads it to RAAG with AI-generated summaries,
then uses semantic search to find the most relevant files for any prompt —
so Claude answers correctly the first time.

---

## Prerequisites

- [Claude Code](https://docs.anthropic.com/claude-code) installed and working
- Node.js 18+
- A RAAG account at [raag.zoxa.ai](https://raag.zoxa.ai) (free to sign up)
- Verify Claude Code works: `claude -p "say hello"`

---

## Installation

```bash
# 1. Clone or download
cd enhance

# 2. Install dependencies
npm install

# 3. Make it a global command
npm link
```

Verify it works:
```bash
enhance --help
```

---

## Quick Start

### Step 1 — Set your API key

On first run, Enhance will prompt for your RAAG API key:

```bash
enhance "test"

→ No RAAG API key configured.
→ Get your key at: https://raag.zoxa.ai → API Keys
→ RAAG API URL (default: https://raag.zoxa.ai/api):
→ RAAG API Key: raag_xxxxx
→ Validating... ✓ Connected to RAAG
```

Get your API key at [raag.zoxa.ai](https://raag.zoxa.ai) → sign up → API Keys page.

### Step 2 — Index your project

```bash
enhance --init /path/to/your/project
```

This will:
1. Scan all code files (.js, .ts, .py, .go, etc.)
2. Generate a ≤50 word AI summary for each file
3. Auto-create a Knowledge Base in RAAG (named after your project folder)
4. Upload all files with summaries to RAAG
5. Auto-build a RAG search model
6. Save config to `.claude/commands/enhance.md`

Takes a few minutes on first run. Subsequent runs only process changed files.

### Step 3 — Enhance prompts

```bash
enhance "fix the login page"
```

Or inside Claude Code:
```
cd your-project && claude
/enhance "fix the login page"
```

---

## All Commands

```bash
# Index a project (first time or after major changes)
enhance --init /path/to/project

# Force full rebuild
enhance --init --force

# Enhance a prompt
enhance "your raw prompt"

# Watch for changes (auto-sync to RAAG)
enhance --watch

# Set default project
enhance --set-project /path/to/project

# Check connection and project status
enhance --status

# Show help
enhance --help
```

---

## Keeping The Index Fresh (Background Watcher)

Instead of manually running `enhance --init` after every code change, run the
watcher as a background daemon. It watches your project and re-indexes only when
structural changes happen (new functions, imports, exports). Cosmetic changes
like comments and logs are ignored automatically.

### Setup (once per machine)

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

### Daily Commands

```bash
pm2 status                   # is the watcher running?
pm2 logs enhancer-watch      # what is it doing?
pm2 restart enhancer-watch   # restart after switching projects
```

---

## How It Works Under The Hood

```
Your prompt: "fix the login page"
    │
    ▼
RAAG Semantic Search (Gemini embeddings + Qdrant vector DB)
  Finds top 5 relevant file chunks by meaning
    │
    ▼
Claude Enhancement
  Raw prompt + file context → precise, file-specific prompt
    │
    ▼
Enhanced prompt with real file names, functions, and what to check
```

Total time: ~5 seconds.

---

## Multiple Projects

Each project gets its own Knowledge Base in RAAG. Switch between projects:

```bash
enhance --set-project /path/to/project-a
enhance --init

enhance --set-project /path/to/project-b
enhance --init
```

Check which project is active:
```bash
enhance --status
```

---

## File Structure

```
enhance/
  index.js              Entry point — CLI routing, API key prompt
  indexer.js             Scans project, generates summaries, uploads to RAAG
  matcher.js             Queries RAAG for relevant files
  enhancer.js            Claude Code call — generates enhanced prompt
  watcher.js             File watcher — auto re-indexes + syncs to RAAG
  raag-client.js         RAAG API client (timeout, retry, validation)
  config.js              Persistent config (API key, per-project KB/RAG IDs)
  ecosystem.config.cjs   PM2 daemon config for background watcher
  system_prompt.txt      Enhancement rules — tune for better output
```

---

## Troubleshooting

**`enhance` command not found**
```bash
cd enhance && npm link
```

**API key not working**
Check your key at [raag.zoxa.ai](https://raag.zoxa.ai) → API Keys. Run:
```bash
enhance --status
```

**RAAG query failed / timeout**
Check that RAAG is reachable:
```bash
curl https://raag.zoxa.ai/api/health
```

**Index takes too long**
Normal on first run (spawns Claude for each file). Subsequent runs only re-index changed files.

**Claude Code `/enhance` not working**
Run `enhance --init` for your project. Check `.claude/commands/enhance.md` exists.

**PM2 daemon not picking up changes**
```bash
enhance --status           # check active project
pm2 restart enhancer-watch # restart after changes
```
