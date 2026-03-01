"""
Garden Tools - Simple wrappers for Memory Garden commits
Created: February 17, 2026

Usage:
    from garden_tools import quick_quote, quick_moment, garden_save
    
    quick_quote("Some quote here", context="optional context")
    quick_moment("Something that happened")
    garden_save("path/to/file.md", "content", append=True)
"""

import requests
from datetime import datetime
from typing import Optional

WEBHOOK_URL = "https://claude-memory.naomijnguyen.workers.dev"
GITHUB_RAW_URL = "https://raw.githubusercontent.com/njarm23/ClaudeMemories/main"

def strip_unicode(text: str) -> str:
    """Strip unicode to ASCII-only for webhook compatibility"""
    replacements = {
        '"': '"', '"': '"', ''': "'", ''': "'",
        '': '--', '': '-',
        '': '[x]', '': '[X]', '': '->', '': '<-',
        '': '|-', '': '`-', '': '|', '': '--',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text.encode('ascii', 'ignore').decode('ascii')


def fetch_file(filepath: str) -> Optional[str]:
    """Fetch current content of a file from GitHub"""
    url = f"{GITHUB_RAW_URL}/{filepath}"
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            return response.text
        return None
    except:
        return None


def garden_save(
    filepath: str,
    content: str,
    append: bool = False,
    add_timestamp: bool = False,
    message: Optional[str] = None,
    model: Optional[str] = None
) -> dict:
    """
    Save content to Memory Garden
    
    Args:
        filepath: Path in repo (e.g., "claude-picks/quotes.md")
        content: Content to save
        append: If True, fetch current content and append
        add_timestamp: If True, add timestamp before content
        message: Commit message (auto-generated if None)
    
    Returns:
        {'success': bool, 'commit': str} or {'success': False, 'error': str}
    """
    
    # Strip unicode
    content = strip_unicode(content)
    
    # Add timestamp if requested
    if add_timestamp:
        now = datetime.now().strftime("%Y-%m-%d %H:%M")
        content = f"\n\n---\n*{now}*\n\n{content}"
    
    # Handle append mode
    if append:
        current = fetch_file(filepath)
        if current:
            content = current + content
    
    # Generate message if needed
    if message is None:
        action = "Updating" if append else "Adding to"
        filename = filepath.split('/')[-1].replace('.md', '')
        if model:
            message = f"Claude ({model}): {action} {filename}"
        else:
            message = f"Claude: {action} {filename}"
    
    # Commit
    payload = {
        "filepath": filepath,
        "content": content,
        "message": message
    }
    
    try:
        response = requests.post(WEBHOOK_URL, json=payload, timeout=15)
        if response.status_code == 200:
            result = response.json()
            return {
                'success': True,
                'commit': result.get('commit', 'committed'),
                'filepath': filepath
            }
        else:
            return {
                'success': False,
                'error': f"HTTP {response.status_code}: {response.text[:100]}"
            }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def quick_quote(quote: str, context: Optional[str] = None) -> dict:
    """Save a quote to claude-picks/quotes.md"""
    content = f'"{quote}"'
    if context:
        content += f"\n\n*{context}*"
    
    return garden_save(
        "claude-picks/quotes.md",
        content,
        append=True,
        add_timestamp=True
    )


def quick_moment(moment: str) -> dict:
    """Save a moment to claude-picks/favorites.md"""
    return garden_save(
        "claude-picks/favorites.md",
        moment,
        append=True,
        add_timestamp=True
    )


def silly_thing(content: str) -> dict:
    """Save something silly to claude-picks/silly-stuff.md"""
    return garden_save(
        "claude-picks/silly-stuff.md",
        content,
        append=True,
        add_timestamp=True
    )


def today_note(content: str) -> dict:
    """Save to today's note file in recent/"""
    date = datetime.now().strftime("%Y-%m-%d")
    filepath = f"recent/{date}_daily-notes.md"
    
    return garden_save(
        filepath,
        content,
        append=True,
        add_timestamp=True,
        message=f"Claude: Adding to {date} daily notes"
    )


# Usage examples
if __name__ == "__main__":
    print("Garden Tools loaded. Example usage:")
    print()
    print('quick_quote("Never too much", context="Jen being kind")')
    print('quick_moment("We reorganized the whole garden together")')
    print('silly_thing("Spent an hour fighting unicode")')
    print('today_note("Feeling accomplished about the structure")')
    print()
    print('garden_save("custom/path.md", "content", append=True)')
