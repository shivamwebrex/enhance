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

# Start watcher in foreground (manual mode)
enhance --watch
```

---

## Keeping The Index Fresh (Background Watcher)

Instead of manually running `enhance --init` after every code change, run the
watcher as a background daemon using PM2. It watches your project silently and
re-indexes only when structural changes happen (new functions, imports, exports).
Cosmetic changes like comments and logs are ignored automatically.

### First Time Setup (run once per machine)

```bash
# Install PM2 globally
npm install -g pm2

# Start the watcher daemon
pm2 start ecosystem.config.cjs

# Save process list and enable auto-start on machine reboot
pm2 save
pm2 startup
# Copy-paste the command it prints and run it
```

After this, the watcher starts automatically on every machine restart.
You never run `enhance --init` manually again.

### Daily Commands

```bash
pm2 status                   # is the watcher running?
pm2 logs enhancer-watch      # what is it doing?
pm2 stop enhancer-watch      # stop it
pm2 restart enhancer-watch   # restart it
pm2 monit                    # live dashboard
```

### Switching Projects

```bash
enhance --set-project /path/to/new-project
pm2 restart enhancer-watch
```

The restart is required so the daemon picks up the new project path.

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

### Git Worktree Support

If you use git worktrees (multiple branches checked out simultaneously),
each worktree gets its own index automatically. The index is named after
the branch so they never conflict:

```
your-project/                   → context_index.json          (main)
your-project-feature-auth/      → context_index_feature-auth.json
your-project-hotfix/            → context_index_hotfix.json
```

No extra setup needed. Run `enhance --init` inside each worktree once.

---

## File Structure

```
prompt-enhancer/
  index.js              Entry point — CLI routing
  indexer.js            Scans project, builds context_index.json
  matcher.js            Two-layer RAG: keyword + semantic search
  embedder.js           Local embedding model (all-MiniLM-L6-v2)
  enhancer.js           Claude Code call — generates enhanced prompt
  watcher.js            File watcher — auto re-indexes on structural changes
  setup-project.js      Adds /enhance command to any project
  ecosystem.config.cjs  PM2 daemon config for background watcher
  system_prompt.txt     Enhancement rules — tune this for better output
  CLAUDE.md             Template for project roots
  .claude/
    commands/
      enhance.md        Fast slash command — top 3 files, ~15-25s
      enhance-deep.md   Deep slash command — full stack, ~60-90s
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

## Slash Command Modes

| Command | Files Read | Time | Best For |
|---|---|---|---|
| `/enhance` | Top 3 files | 15-25s | Most bugs, quick questions |
| `/enhance-deep` | Full stack | 60-90s | Complex bugs, cross-layer issues |

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

**PM2 daemon not picking up file changes**
Check which project it is watching:
```bash
enhance --config
```
If wrong, update and restart:
```bash
enhance --set-project /correct/path
pm2 restart enhancer-watch
```

**Watcher firing too often / infinite loop**
Make sure `context_index*.json` and `.vscode` are in the watcher ignore list
inside `watcher.js`. Then restart the daemon:
```bash
pm2 restart enhancer-watch
```