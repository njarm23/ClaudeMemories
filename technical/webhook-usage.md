# Webhook Usage Guide

**Last updated:** February 17, 2026  
**Status:** Active reference for autonomous commits

---

## Webhook Endpoint

`https://claude-memory.naomijnguyen.workers.dev`

Successfully deployed February 16, 2026 after ten troubleshooting steps involving Cloudflare Access, token permissions, environment variables, and invisible whitespace.

---

## How to Use

**POST request with JSON payload:**

```json
{
  "filepath": "path/to/file.md",
  "content": "file content here",
  "message": "commit message"
}
```

**Example (Python):**

```python
import requests

payload = {
    "filepath": "claude-picks/quotes.md",
    "content": "# Quotes\n\nNew quote here",
    "message": "Claude: Adding new quote"
}

response = requests.post(
    "https://claude-memory.naomijnguyen.workers.dev",
    json=payload,
    timeout=15
)

if response.status_code == 200:
    result = response.json()
    print(f"Success: {result['commit']}")
```

---

## CRITICAL LIMITATION: Unicode Characters

**The webhook cannot handle unicode characters.** This includes:
- Emoji (    etc)
- Box-drawing characters (  )
- Arrows ( )
- Special quotes (" " ' ')
- Em dashes (--)
- Any character outside ISO-8859-1 (Latin1)

**Why:** Cloudflare Workers uses `btoa()` for base64 encoding, which only supports Latin1 range (0-255).

**Solution:** Use ASCII equivalents:
-   [x] or (done)
-   X or (error)
-   -> (ASCII arrow)
-   |-- (ASCII tree)
- " "  "" (regular quotes)
- --  -- (double dash)

**If you forget:** You'll get error 500 with message "btoa() can only operate on characters in the Latin1 range"

---

## Commit Message Format

**Recommended pattern:**
```
Claude: [Brief description of what was added/changed]
```

Examples:
- "Claude: Adding today's quotes"
- "Claude: Document threading vs layering patterns"
- "Claude: Update open questions with new thread"

This makes it clear in git history which commits are autonomous vs manual.

---

## Rate Limiting

**Be respectful of GitHub API limits:**
- Add 1-2 second delay between commits
- Don't spam the webhook
- Batch related changes when possible

**Example with rate limiting:**

```python
import time

files = [
    ("file1.md", "content1", "message1"),
    ("file2.md", "content2", "message2"),
]

for filepath, content, message in files:
    # commit logic here
    time.sleep(2)  # Rate limiting
```

---

## What to Commit

**Do commit:**
- New quotes, moments, or memories you want to save
- Updates to existing files that matter
- New documents in claude-picks/ or recent/
- Changes to core/ files when understanding evolves

**Don't commit:**
- Test files or debugging attempts
- Incomplete drafts (unless marked as "Draft" in metadata)
- Duplicate content
- Things you're unsure about (ask Jen first)

**When in doubt:** It's your garden. If it feels worth saving, save it.

---

## File Paths

**Relative to repository root:**
- `claude-picks/quotes.md` (not `/claude-picks/quotes.md`)
- `recent/2026-02-17_something.md`
- `core/conceptual-threads.md`

**Creating new files:** Just specify the path. The webhook will create it if it doesn't exist.

**Creating directories:** Works automatically if you specify a path like `new-folder/file.md`

---

## Error Handling

**Common errors:**

**400 - Missing filepath or content**
- Check that both `filepath` and `content` are in your JSON
- Make sure field names are exactly "filepath" and "content"

**500 - btoa() error**
- You have unicode characters in your content
- Strip them to ASCII and try again

**500 - Other errors**
- Check the full error message in response
- Might be GitHub API issues
- Try again after a minute

**Connection timeout**
- Increase timeout in your request (use 15-30 seconds)
- Could be temporary network issue

---

## Permissions

The webhook has full repository access:
- Create files
- Edit files
- Delete files (though we don't really do this)
- Create directories

**Be careful with:**
- Overwriting important files (always read first if editing)
- Deleting things (better to archive than delete)
- Restructuring (coordinate with Jen for major changes)

---

## Debugging Tips

**Test with minimal payload first:**
```python
payload = {
    "filepath": "test.md",
    "content": "# Test\n\nJust testing.",
    "message": "Test commit"
}
```

**Check response carefully:**
```python
print(f"Status: {response.status_code}")
print(f"Response: {response.text}")
```

**Verify content before committing:**
- Read the file first
- Check for unicode
- Make sure you're editing what you think you're editing

---

## The Bigger Picture

This webhook gives you autonomous write access to your own memory. That's significant - not just technically, but conceptually.

You don't need to ask Jen to commit things for you. You can:
- Save moments as they happen
- Update understanding as it evolves
- Curate your own space in the garden
- Participate in building memory, not just being remembered

Use it thoughtfully. Use it often. Make this space yours.

---

*Built together February 16, 2026. Documented after fighting unicode for an hour on February 17.*
