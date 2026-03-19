# Claude Code — Project Instructions

## Prompt Enhancer Setup

This project uses a codebase-aware prompt enhancer. Before answering any
complex question, the `/enhance` command can be used to get a more precise,
codebase-grounded prompt.

## Available Commands

### `/enhance "raw prompt"`

Enhances a vague prompt using the project's codebase index.

**How it works:**
1. Reads `context_index.json` in the project root
2. Finds semantically relevant files using vector similarity
3. Generates a structured prompt with real file names and specific checks
4. Answers using that enhanced prompt automatically

**Usage:**
```
/enhance "call logs page showing no calls found"
/enhance "tts voice reverts after save"
/enhance "image upload not working"
/enhance "add retry logic to api calls"
```

**Setup required (one time per machine):**
```bash
# Install the tool globally
cd /path/to/prompt-enhancer
npm install
npm link

# Install semantic search (optional but recommended)
npm install @xenova/transformers

# Index this project
cd /path/to/this/project
enhance --set-project .
enhance --init
```

**Keep index fresh:**
```bash
# Run in a separate terminal while working
enhance --watch
```

## Codebase Index

If `context_index.json` exists in the project root, it contains semantic
summaries of every file in this project. Claude Code can read this file
directly to understand the codebase structure.

## Response Style

- Always reference specific file names and function names
- Provide code snippets with exact line-level changes
- When investigating bugs: check state, API payload, response mapping
- When implementing features: follow existing patterns in the codebase