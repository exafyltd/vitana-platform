#!/usr/bin/env python3
"""
Stub runner that would normally launch Claude or another agent.
For now, it simply prints the COP context that has been auto-loaded.
"""
import os

def main():
    context = os.environ.get("CLAUDE_CONTEXT")
    print("\n[CLAUDE CONTEXT RECEIVED]")
    print(context[:500] + "...\n")  # print first 500 chars only
    print("[END OF CONTEXT]\n")

if __name__ == "__main__":
    main()
