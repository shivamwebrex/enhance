# Enhance Prompt

Run this command first — do not explore the project yourself:

```bash
enhance "$ARGUMENTS"
```

---

## Step 1 — Evaluate the output

After running the command, check what came back:

**If the enhanced prompt is specific** (mentions actual file paths, function names, variable names, or exact error locations) → go to Step 2.

**If the enhanced prompt is vague** (generic debugging advice, no file references, or the score is below 40%) → do NOT proceed. Go to Step 1a.

### Step 1a — Ask clarifying questions first

When context is thin, ask the user these before doing anything:

- What exact behaviour are you seeing vs what you expect?
- Which file or feature area does this involve?
- Did this break after a recent change? If so, what changed?
- Have you seen any error messages or logs?

Wait for answers. Then build an enhanced prompt yourself using their answers + the RAAG output. Show it to the user before proceeding.

---

## Step 2 — Validate the enhanced prompt

Show the enhanced prompt to the user exactly as returned (or as you built it in Step 1a).

Then ask:

> "Does this capture what you're trying to do? Confirm to proceed, or tell me what to adjust."

**Check before confirming:**
- Does it reference real files from this codebase?
- Does it describe the actual problem, not a generic version of it?
- Is the expected behaviour clearly stated?

If any of these are missing, flag it to the user and ask for the missing piece before proceeding.

---

## Step 3 — Execute only after confirmation

Once the user confirms:

1. Read only the files mentioned in the enhanced prompt
2. Trace the specific functions or logic paths referenced
3. Provide targeted fixes — do not do a broad codebase scan
4. Do NOT re-run enhance or explore beyond what the prompt specifies