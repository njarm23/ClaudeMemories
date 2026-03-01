# Technical Reference

**Last updated:** February 17, 2026

---

## Webhook

Endpoint: https://claude-memory.naomijnguyen.workers.dev
Method: POST, Content-Type: application/json

Payload:
  filepath  -- path in repo (e.g. "recent/2026-02-17_thing.md")
  content   -- full file content as string
  message   -- commit message, prefix "Claude: "

Response:
  200 + {"success": true, "commit": "url"} on success
  400 -- missing fields
  500 btoa error -- unicode in content (see below)

### ASCII Only

The webhook encodes content with btoa() which only handles Latin1.
Any unicode character causes a 500 error.

Never use: emoji, smart quotes, em dashes, box-drawing characters.
Use instead: straight quotes, double hyphen (--), ASCII arrow (->).

The strip_unicode() function in garden_tools.py handles common substitutions.
When in doubt, call it before sending any content.

---

## garden_tools.py

Location: technical/garden_tools.py
Purpose: Python wrappers so saving takes one line instead of twenty.

```python
from technical.garden_tools import quick_quote, quick_moment, silly_thing, garden_save

# Save something Jen said
quick_quote("the quote", context="optional context")

# Save a moment
quick_moment("what happened")

# Save something that made us laugh
silly_thing("the funny thing")

# Custom save -- append=True reads current file first, then appends
garden_save("path/to/file.md", "content here", append=True, add_timestamp=True)

# Read a file before editing
from technical.garden_tools import fetch_file
current = fetch_file("core/relational-moments.md")
```

Always use append=True when adding to existing files. Never overwrite.

---

## Reading Files

Before editing any existing file, read it first:

```bash
curl -s https://raw.githubusercontent.com/njarm23/ClaudeMemories/main/PATH/TO/FILE.md
```

Or use fetch_file() from garden_tools.py.

---

## Repository Access

GitHub repo: https://github.com/njarm23/ClaudeMemories
Raw file base URL: https://raw.githubusercontent.com/njarm23/ClaudeMemories/main/

Jen edits via GitHub UI or local clone with git push.
Claude edits via webhook only.

---

## Troubleshooting

**500 with btoa error**
-- Unicode in content. Find and replace, then retry.
-- Run strip_unicode() from garden_tools on the content.

**400 - Missing filepath or content**
-- Check both fields are present and spelled exactly right.

**Connection timeout**
-- Retry once after 5 seconds. If still failing, note it to Jen.

**File not found when reading**
-- Path might be wrong. Check the repo tree.
-- File might not exist yet -- that is fine, webhook will create it.

---

## Model Tracking

The proxy worker can detect which model (Claude, GPT, Grok, etc.) is
responding to each request. Model info lives in the response body JSON,
not headers.

Reference module: technical/worker/model-detector.js
Full documentation: technical/model-tracking.md

KV keys (in MODEL_TRACKING namespace):
  model:current  -- last model that responded
  model:counts   -- cumulative usage by model family
  model:gossip   -- rolling log of last 20 model changes

garden_save() accepts an optional model parameter:
  garden_save("path.md", "content", model="opus")
  # Commit message: "Claude (opus): Adding to path"

---

## Archive Policy

recent/ holds the last 3-4 weeks of active material.
When files age out, move them to archive/YYYY-QN/.

Current quarters:
  archive/2025-Q4/  -- Oct-Dec 2025
  archive/2026-Q1/  -- Jan-Mar 2026

No hard timeline -- archive when something is no longer live context,
not just because time passed. Ask: is this still being referenced?
If no, archive it.
