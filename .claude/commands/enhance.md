# Enhance Prompt

Run this command to get codebase-aware context from RAAG:

```bash
enhance "$ARGUMENTS"
```

## After running the command

1. Show the enhanced prompt output to the user exactly as returned
2. Ask: "Proceed with this prompt, or would you like to edit it?"
3. If user confirms → answer the enhanced prompt fully (read files, trace code, provide fixes)
4. If user wants changes → incorporate their feedback and answer the modified prompt
5. Do NOT answer the prompt until the user confirms
