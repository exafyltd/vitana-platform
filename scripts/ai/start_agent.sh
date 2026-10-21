#!/bin/bash
# Auto-load Claude governance rules before launching an agent

python3 scripts/ai/load_claude_prompt.py > /tmp/CLAUDE_CONTEXT.txt
export CLAUDE_CONTEXT=$(cat /tmp/CLAUDE_CONTEXT.txt)

# Push COP to OASIS for tracking
python3 scripts/ai/oasis_cop_register.py

# Run the agent (stub for now)
python3 scripts/ai/run_claude_agent.py
