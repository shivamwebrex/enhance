# Claude Code — Project Instructions

## Enhance — Codebase-Aware Prompt Enhancement

This project uses Enhance, powered by [RAAG](https://raag.zoxa.ai), to turn
vague prompts into precise, file-specific instructions.

## Available Commands

### `/enhance "raw prompt"`

Enhances a vague prompt using RAAG semantic search over the codebase.

**How it works:**
1. Queries RAAG for the top 5 relevant file chunks
2. Formats them as context for Claude
3. Claude generates a structured prompt with real file names and specific checks
4. Answers using that enhanced prompt automatically

**Usage:**
```
/enhance "call logs page showing no calls found"
/enhance "tts voice reverts after save"
/enhance "add retry logic to api calls"
```

**Setup (one time):**
```bash
cd /path/to/enhance
npm install && npm link
enhance --init /path/to/this/project
```

**Keep index fresh:**
```bash
enhance --watch
```

## Response Style

- Always reference specific file names and function names
- Provide code snippets with exact line-level changes
- When investigating bugs: check state, API payload, response mapping
- When implementing features: follow existing patterns in the codebase
