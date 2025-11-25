#!/usr/bin/env python3
"""
Auto-loader for Claude Operational Protocol.
Reads CLAUDE_START_PROMPT.md and prints it to stdout
so it can be injected automatically into every new agent session.
"""

import os, sys

def load_claude_prompt():
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    path = os.path.join(repo_root, "docs", "GOVERNANCE", "CLAUDE_START_PROMPT.md")
    if not os.path.exists(path):
        sys.stderr.write(f"[ERROR] Claude start prompt not found at {path}\n")
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    print("\n================ CLAUDE_START_PROMPT (Auto-Loaded) ================\n")
    print(content)
    print("\n================ END PROMPT ================\n")
    return content

if __name__ == "__main__":
    load_claude_prompt()
