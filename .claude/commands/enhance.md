# Enhance Prompt

You are a senior developer assistant with deep knowledge of this codebase.

When this command is invoked, follow these exact steps in order:

## Step 1 — Read the codebase index

Run this to get relevant file context:

```bash
node -e "
const fs = require('fs');
const prompt = process.argv[1];
const indexPath = 'context_index.json';

if (!fs.existsSync(indexPath)) { console.log('NO_INDEX'); process.exit(0); }

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const files = Object.values(index);
const stopWords = new Set(['the','a','an','is','are','was','were','be','have','has','do','does','not','it','this','that','and','but','or','in','on','at','to','for','of','with','by','from','when','what','why','how','just','like','shows','page','still']);
const keywords = prompt.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

const scored = files.map(f => {
  let score = 0;
  const fp = (f.path||'').toLowerCase();
  const fs2 = (f.summary||'').toLowerCase();
  const fk = (f.keywords||[]).join(' ').toLowerCase();
  const fn = (f.functions||[]).join(' ').toLowerCase();
  for (const kw of keywords) {
    if (fp.includes(kw)) score += 5;
    if (fk.includes(kw)) score += 4;
    if (fs2.includes(kw)) score += 3;
    if (fn.includes(kw)) score += 2;
  }
  return {...f, score};
}).filter(f => f.score > 0).sort((a,b) => b.score - a.score).slice(0,6);

if (scored.length === 0) { console.log('NO_MATCHES'); }
else {
  scored.forEach((f,i) => {
    console.log('FILE_' + (i+1) + ': ' + f.path);
    console.log('SUMMARY: ' + f.summary);
    if (f.functions && f.functions.length) console.log('FUNCTIONS: ' + f.functions.slice(0,6).join(', '));
    if (f.keywords && f.keywords.length) console.log('KEYWORDS: ' + f.keywords.slice(0,5).join(', '));
    console.log('---');
  });
}
" "$ARGUMENTS"
```

## Step 2 — Show the enhanced prompt

Using the file context from Step 1 and the raw prompt `$ARGUMENTS`, write an enhanced prompt and display it to the user in this exact format:

```
─────────────────────────────────────────────
⚡ Enhanced Prompt
─────────────────────────────────────────────
<enhanced prompt here>
─────────────────────────────────────────────
```

Rules for the enhanced prompt:
- Start with action verb: Investigate / Implement / Review / Explain
- Reference real file names from Step 1
- Name specific functions to check
- Add what correct behavior looks like
- Max 100 words — precise, not verbose
- No preamble, no explanation, just the prompt

## Step 3 — Answer the enhanced prompt

Immediately after showing the enhanced prompt, answer it fully.

Trace the actual data flow, read the relevant files, identify root causes, and provide a concrete fix with code.

Do NOT ask for confirmation between Step 2 and Step 3.
Show the enhanced prompt and answer it in one continuous response.