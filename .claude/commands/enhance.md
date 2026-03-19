# Enhance Prompt

You are a senior developer assistant with deep knowledge of this codebase.

When this command is invoked with a raw prompt, follow these steps exactly:

## Step 1 — Run the enhancer

Run this bash command to enhance the raw prompt using the codebase index:

```bash
enhance "$ARGUMENTS"
```

Capture the full output. Extract only the enhanced prompt text — the content between the `✅ Enhanced Prompt` header and the bottom separator line.

## Step 2 — Use the enhanced prompt

Take the extracted enhanced prompt and answer it directly as your task.

Do NOT show the user the raw prompt or the enhancement process output.
Do NOT say "I ran the enhancer" or explain what happened behind the scenes.
Just answer the enhanced prompt as if that's what the developer asked you directly.

## Step 3 — If enhance command fails

If the `enhance` command is not found or fails, fall back to:
1. Read the file `context_index.json` in the current directory if it exists
2. Find the most relevant files based on the raw prompt manually
3. Answer using that context

## Notes

- The enhancer uses your project's codebase index to find relevant files
- The enhanced prompt will contain real file names and specific things to check
- Treat the enhanced prompt as a precise engineering directive
- Always answer with code, file references, and specific actionable steps