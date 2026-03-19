# ⚡ Prompt Enhancer

Codebase-aware prompt enhancement for your dev team.

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

It reads your codebase, finds the most relevant files, and uses them to write
a precise prompt — so Claude answers correctly the first time.

---

## Prerequisites

- [Claude Code](https://docs.anthropic.com/claude-code) installed and working
- Node.js 18+
- Verify Claude Code works: `claude -p "say hello"`

---

## Installation

```bash
# 1. Clone this repo
git clone <repo-url>
cd prompt-enhancer

# 2. Install dependencies
npm install

# 3. Make it a global command
npm link

# 4. (Optional but recommended) Install semantic search
npm install @xenova/transformers
```

Verify it works:
```bash
enhance --help
```

---

## Setup For Your Project

Run this once per project:

```bash
enhance --setup /path/to/your/project
```

This automatically:
- Creates `.claude/commands/enhance.md` in your project
- Creates `CLAUDE.md` in your project root
- Sets your project as the default

Then build the codebase index:

```bash
enhance --init
```

This scans every file, generates summaries, and stores them in
`context_index.json` inside your project. Takes a few minutes on first run.

---

## Usage

### Option 1 — Inside Claude Code (recommended, zero friction)

```bash
cd your-project
claude
```

Then type:
```
/enhance "call logs page showing no calls found"
/enhance "tts voice reverts after page reload"
/enhance "add retry logic to websocket connection"
```

Claude Code runs the enhancer, gets the precise prompt, and answers it directly.
No copy paste. No terminal switching.

### Option 2 — Terminal CLI

```bash
enhance "call logs page showing no calls found"
```

Copy the enhanced prompt and paste it wherever you use Claude.

---

## All Commands

```bash
# Setup a project (run once per project)
enhance --setup /path/to/project

# Build codebase index (run once, then after major changes)
enhance --init

# Force rebuild index from scratch
enhance --init --force

# Enhance a prompt directly
enhance "your raw prompt"

# Check current config
enhance --config

# Set default project manually
enhance --set-project /path/to/project
```

---

## Keeping The Index Fresh

Re-run `enhance --init` after significant code changes.

---

## Working On Multiple Projects

Each project gets its own `context_index.json`. Switch between projects:

```bash
# Switch to project A
enhance --setup /path/to/project-a
enhance --init

# Switch to project B
enhance --setup /path/to/project-b
enhance --init
```

---

## File Structure

```
prompt-enhancer/
  index.js          Entry point — CLI routing
  indexer.js        Scans project, builds context_index.json
  matcher.js        Two-layer RAG: keyword + semantic search
  embedder.js       Local embedding model (all-MiniLM-L6-v2)
  enhancer.js       Claude Code call — generates enhanced prompt
  setup-project.js  Adds /enhance command to any project
  system_prompt.txt Enhancement rules — tune this for better output
  CLAUDE.md         Template for project roots
  .claude/
    commands/
      enhance.md    Claude Code slash command definition
```

---

## How The RAG Works

```
Your prompt
    │
    ▼
Layer 1: Keyword scoring
  Finds 15 candidate files from index
  Fast, no API, no model (~0s)
    │
    ▼
Layer 2: Semantic search (if @xenova/transformers installed)
  Embeds your prompt as a 384-dim vector
  Compares against stored file vectors
  Picks true top 5 by meaning, not just word overlap (~0.1s)
    │
    ▼
Claude Enhancement
  Raw prompt + top 5 file contexts → precise structured prompt (~5s)
    │
    ▼
Enhanced prompt
```

Total time: 5-7 seconds.

---

## Tuning Output Quality

Edit `system_prompt.txt` to change how prompts are enhanced.

The system prompt controls:
- Intent detection (bug / feature / review / explain)
- Output structure
- What gets added (file names, what to check, success criteria)

The better the system prompt, the better every enhanced prompt becomes.

---

## Troubleshooting

**`enhance` command not found**
```bash
cd prompt-enhancer && npm link
```

**`Fatal error: Cannot read properties of undefined`**
Your `context_index.json` is from an old version. Rebuild:
```bash
enhance --init --force
```

**`Semantic: ⚠ keyword only`**
Install `@xenova/transformers` then rebuild index:
```bash
npm install @xenova/transformers
enhance --init --force
```

**Claude Code `/enhance` not working**
Make sure you ran `enhance --setup /path/to/project` for that project.
Check `.claude/commands/enhance.md` exists in the project root.

**Index takes too long**
Normal on first run. Subsequent runs only re-index changed files.