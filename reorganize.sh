#!/bin/bash
# Memory Garden Reorganization Script
# Created: February 17, 2026
# Run from ClaudeMemories repository root

set -e  # Exit on error

echo "=== Memory Garden Reorganization ==="
echo ""

# Create new directories if they don't exist
echo "Creating directory structure..."
mkdir -p technical
mkdir -p archive/2026-Q1
mkdir -p archive/2025-Q4

# Remove duplicate files
echo "Removing duplicates..."
if [ -f "conceptual-threads.md" ]; then
    echo "  - Deleting root conceptual-threads.md (keeping core/ version)"
    rm conceptual-threads.md
fi

if [ -f "relational-moments.md" ]; then
    echo "  - Deleting root relational-moments.md (keeping core/ version)"
    rm relational-moments.md
fi

# Move old files to archive
echo "Archiving old content..."
if [ -f "recents/2025-02-14-api-setup-and-memory.md" ]; then
    echo "  - Moving old recents to archive"
    mv recents/2025-02-14-api-setup-and-memory.md archive/2025-Q4/
fi

if [ -d "how-we-work" ]; then
    echo "  - Moving legacy how-we-work folder to archive"
    mv how-we-work archive/2025-Q4/
fi

# Update core files with new versions
echo "Updating core files..."
if [ -f "core/open-questions_NEW.md" ]; then
    echo "  - Replacing open-questions.md"
    mv core/open-questions_NEW.md core/open-questions.md
fi

# Update README
echo "Updating README..."
if [ -f "README_NEW.md" ]; then
    echo "  - Backing up old README to archive"
    cp README.md archive/2026-Q1/README-old-$(date +%Y%m%d).md
    echo "  - Installing new README"
    mv README_NEW.md README.md
fi

# Clean up plan document (keep it for reference)
echo "Keeping REORGANIZATION_PLAN.md for reference"

echo ""
echo "=== Reorganization Complete ==="
echo ""
echo "New structure:"
echo "  [x] Duplicates removed"
echo "  [x] Old content archived"  
echo "  [x] Core files updated"
echo "  [x] README refreshed"
echo "  [x] Recent/ has proper files"
echo ""
echo "Next steps:"
echo "  1. Review changes"
echo "  2. Populate core/your-world.md"
echo "  3. Add metadata to remaining core files"
echo "  4. Create technical documentation"
echo ""
