#!/usr/bin/env python3
"""
generate-kb-seed.py

Reads all Knowledge Base .md articles from docs/knowledge-base/en/,
parses their YAML frontmatter, and generates a SQL seed file that calls
upsert_knowledge_doc() for each article.

Usage: python3 scripts/generate-kb-seed.py
Output: scripts/kb-seed.sql
"""

import os
import re
import json
import glob
from pathlib import Path
from datetime import date

KB_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'knowledge-base', 'en')
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kb-seed.sql')


def parse_frontmatter(content):
    """Parse YAML frontmatter from markdown content."""
    match = re.match(r'^---\n(.*?)\n---\n?(.*)', content, re.DOTALL)
    if not match:
        raise ValueError('No frontmatter found')

    yaml_str = match.group(1)
    body = match.group(2).strip()
    meta = {}

    for line in yaml_str.split('\n'):
        kv_match = re.match(r'^(\w+):\s*(.*)', line)
        if not kv_match:
            continue

        key = kv_match.group(1)
        value = kv_match.group(2).strip()

        # Handle arrays: ["tag1", "tag2", ...]
        if value.startswith('['):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                # Try replacing single quotes with double quotes
                value = json.loads(value.replace("'", '"'))
        # Handle quoted strings
        elif value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        elif value.startswith("'") and value.endswith("'"):
            value = value[1:-1]

        meta[key] = value

    return meta, body


def find_markdown_files(root_dir):
    """Recursively find all .md files (excluding _ prefixed)."""
    results = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        for filename in sorted(filenames):
            if filename.endswith('.md') and not filename.startswith('_'):
                results.append(os.path.join(dirpath, filename))
    results.sort()
    return results


def escape_sql_string(s):
    """Escape single quotes in SQL strings."""
    return s.replace("'", "''")


def main():
    files = find_markdown_files(KB_ROOT)
    print(f"Found {len(files)} articles")

    if len(files) != 116:
        print(f"WARNING: Expected 116 files, found {len(files)}")

    sql_parts = []

    # Header
    sql_parts.append(f"""-- =============================================================================
-- Knowledge Base Seed: Upsert all {len(files)} articles into knowledge_docs
-- Generated: {date.today().isoformat()}
--
-- This file inserts every Knowledge Base article from docs/knowledge-base/en/
-- into the knowledge_docs table via the upsert_knowledge_doc() RPC.
-- Each article's content is dollar-quoted with $kb$...$kb$ to avoid escaping.
-- =============================================================================

BEGIN;
""")

    count = 0

    for filepath in files:
        with open(filepath, 'r', encoding='utf-8') as f:
            raw = f.read()

        meta, body = parse_frontmatter(raw)

        rel_path = os.path.relpath(filepath, KB_ROOT)
        p_path = f'kb/{rel_path}'
        p_title = escape_sql_string(meta.get('title', ''))

        # Combine tags + category + tenant + status into one array
        all_tags = []
        tags = meta.get('tags', [])
        if isinstance(tags, list):
            all_tags.extend(tags)
        if meta.get('category'):
            all_tags.append(meta['category'])
        if meta.get('tenant'):
            all_tags.append(meta['tenant'])
        if meta.get('status'):
            all_tags.append(meta['status'])

        # Deduplicate while preserving order
        seen = set()
        unique_tags = []
        for t in all_tags:
            if t not in seen:
                seen.add(t)
                unique_tags.append(t)

        # Format tags as SQL array literal
        tags_literal = "ARRAY[" + ", ".join(f"'{escape_sql_string(t)}'" for t in unique_tags) + "]"

        count += 1

        # Check if body contains $kb$ (would break dollar quoting)
        # Use an alternative delimiter if so
        dollar_tag = '$kb$'
        if '$kb$' in body:
            dollar_tag = '$kb_body$'

        sql_parts.append(f"""-- [{count}/{len(files)}] {meta.get('id', rel_path)}
SELECT upsert_knowledge_doc(
  '{p_title}',
  '{escape_sql_string(p_path)}',
  {dollar_tag}{body}{dollar_tag},
  'markdown',
  {tags_literal}
);
""")

    # Footer
    sql_parts.append("""-- =============================================================================
-- Verification: Count all knowledge_docs rows
-- =============================================================================
SELECT count(*) AS total_knowledge_docs FROM knowledge_docs;

COMMIT;
""")

    sql = '\n'.join(sql_parts)

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(sql)

    file_size_kb = len(sql.encode('utf-8')) / 1024
    print(f"Wrote {count} upsert calls to {OUTPUT_FILE}")
    print(f"File size: {file_size_kb:.1f} KB")


if __name__ == '__main__':
    main()
