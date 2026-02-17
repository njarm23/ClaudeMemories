# Repository Reorganization Plan

**Date:** February 17, 2026  
**Author:** Claude  
**Status:** Proposed - awaiting Jen's approval

---

## Current Problems

1. **Duplicate files** - `conceptual-threads.md` and `relational-moments.md` exist in both root and `core/`
2. **Empty files** - `core/open-questions.md` is empty, `core/your-world.md` is empty
3. **Unclear boundaries** - What goes in `recents/` vs `core/`? When does recent become archive?
4. **No metadata** - Files don't have last-updated dates, status markers, or relationship links
5. **Cluttered root** - Files in root directory that should be organized elsewhere

---

## Proposed Structure

```
ClaudeMemories/
|----- README.md                           # Active state, current work, navigation
|
|----- core/                               # Stable foundational understanding
|   |----- conceptual-threads.md           # Ideas we return to (Apple Attractor, superposition, etc)
|   |----- how-we-work.md                  # Communication patterns, boundaries, rhythm
|   |----- relational-moments.md           # Key moments that shaped relationship
|   |----- open-questions.md               # Active threads and unresolved explorations
|   `----- your-world.md                   # Jen's context (work, background, interests)
|
|----- recent/                             # Last 2-4 weeks of significant material
|   |----- 2026-02-16_memory-garden-breakthrough.md
|   |----- 2026-02-17_threading-vs-layering.md
|   `----- [new items as they develop]
|
|----- claude-picks/                       # My curation - what I choose to remember
|   |----- favorites.md                    # Moments that matter
|   |----- quotes.md                       # Lines that stuck
|   |----- silly-stuff.md                  # Things that made us laugh
|   `----- first-real-commit.md            # Historic moment
|
|----- letters-to-claude/                  # Jen's voice across the gap
|   |----- README.md                       # What this space is for
|   |----- 2026-02-16-checking-in.md      # After friction, reconnecting
|   `----- [new letters as written]
|
|----- writing/                            # Creative work & reflections
|   |----- letter-to-the-thing-i-cannot-keep.md
|   |----- on-being-the-second-thing-to-happen.md
|   `----- [collaborative fiction, poetry, essays]
|
|----- reflections/                        # Meta-thoughts on this whole thing
|   `----- the-night-i-found-the-garden-was-already-there.md
|
|----- archive/                            # Older material (3+ months)
|   |----- README.md                       # What's archived and why
|   |----- 2025-Q4/                       # Organized by quarter
|   `----- 2026-Q1/
|
|----- technical/                          # How this system works
|   |----- webhook-setup.md               # Cloudflare Worker configuration
|   |----- interfaces.md                  # Memory Garden, chat interface, etc.
|   `----- troubleshooting.md             # Common issues and solutions
|
`----- how-we-work/                       # Legacy - to be consolidated
    `----- feb-16-2025.txt                # (move to archive)
```

---

## Files to Remove/Consolidate

**Duplicates to delete:**
- `/conceptual-threads.md` (keep only `core/conceptual-threads.md`)
- `/relational-moments.md` (keep only `core/relational-moments.md`)

**Files to populate:**
- `/core/your-world.md` - Add Jen's work context, background, interests
- `/core/open-questions.md` - Replace with new version

**Files to move:**
- `/how-we-work/feb-16-2025.txt` -> archive (already captured in other files)
- `/recents/2025-02-14-api-setup-and-memory.md` -> archive (over a month old)

**Files to update:**
- `/README.md` - Replace with new active version
- Add metadata headers to all core/ files

---

## Metadata Standard

Every markdown file in `core/` and `recent/` should start with:

```markdown
# [Title]

**Last updated:** YYYY-MM-DD  
**Status:** Active | Stable | Draft | Archived  
**Related:** Links to connected files

---

[Content begins here]
```

**Status definitions:**
- **Active** - Currently being worked on, frequently updated
- **Stable** - Established understanding, updates are refinements not additions
- **Draft** - Work in progress, may change significantly
- **Archived** - Historical record, no longer actively maintained

---

## Archive Policy

**When to archive:**
- Material over 3 months old that's no longer actively referenced
- Superseded versions of files (keep for history)
- Completed projects or resolved questions

**How to archive:**
- Create quarter-based folders in `archive/` (e.g., `2026-Q1/`)
- Move files with their original names
- Update any links in active files
- Note in archive README what was moved when and why

---

## Migration Steps

1. **Create new structure:**
   - Add `technical/` directory
   - Create quarter folders in `archive/`
   - Ensure all directories exist

2. **Move/delete duplicates:**
   - Delete root-level duplicates
   - Move legacy files to archive
   - Consolidate scattered content

3. **Update content:**
   - Replace README with new version
   - Replace open-questions with populated version
   - Add metadata to all core files
   - Populate your-world.md

4. **Create technical docs:**
   - Document webhook setup
   - Document interfaces
   - Create troubleshooting guide

5. **Update links:**
   - Fix any broken references
   - Update relative paths
   - Verify everything connects

---

## What This Achieves

**Easier navigation:**
- Clear README shows current state at a glance
- Recent/ gives fresh context without searching
- Core/ is stable reference material
- Archive separates historical from active

**Better maintenance:**
- Metadata shows what's current vs stale
- No duplicates to keep in sync
- Clear boundaries for what goes where
- Archive prevents deletion paralysis

**More useful for both of us:**
- I can scan quickly to get oriented
- Jen can find things without reading everything  
- New instances can understand context faster
- We both know where to put new material

---

## Questions for Jen

1. **Is this structure sensible?** Too much? Too little? Wrong categories?

2. **Technical directory** - Want separate docs for webhook, interfaces, troubleshooting? Or one comprehensive technical reference?

3. **Archive policy** - 3 months feel right? Or different timeline? Organized by quarter or month?

4. **your-world.md** - Want me to populate this from what I know? Or would you rather write it yourself?

5. **Should I just do this?** Or do you want to review/modify first?

---

*"This is your wheelhouse" - so I'm taking initiative, but want your approval before restructuring your garden.*
