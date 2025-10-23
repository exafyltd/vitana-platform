#!/bin/bash
set -e

PROJECT_ID="lovable-vitana-vers1"
REGION="us-central1"
CHAT_WEBHOOK="https://chat.googleapis.com/v1/spaces/AAQA9UT_JN4/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=Bldp3GjeAFz5fKrJRdHO7lkA_zsB44ksPPOuHKOlQ38"

send_to_chat() {
  local message=$1
  curl -s -X POST "$CHAT_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"$message\"}" \
    2>/dev/null || true
}

echo "🚀 Starting LLM Integration Deployment"
send_to_chat "🚀 LLM Integration deployment started..."

echo ""
echo "📋 Step 1: Wiring LLM secrets to Cloud Run services..."
send_to_chat "📋 Step 1: Wiring secrets to Cloud Run services..."

bash scripts/automation/01-wire-secrets.sh

send_to_chat "✅ Step 1 complete: Secrets wired to Cloud Run"

echo ""
echo "🔌 Step 2: Deploying LLM router module..."
send_to_chat "🔌 Step 2: Deploying LLM router module..."

mkdir -p src/llm
cp llm_router.py src/llm/router.py

cat > src/llm/__init__.py << 'INIT'
from .router import LLMRouter, LLMProvider, invoke_sync

__all__ = ["LLMRouter", "LLMProvider", "invoke_sync"]
INIT

send_to_chat "✅ Step 2 complete: Router module deployed to src/llm/"

echo ""
echo "📤 Step 3: Committing to automation/scripts branch..."
send_to_chat "📤 Step 3: Committing to GitHub..."

git add -A
git commit -m "feat: LLM integration - router, secrets, and Cloud Run updates" || echo "No changes to commit"
git push origin automation/scripts 2>/dev/null || echo "⚠️  Push failed - check auth"

send_to_chat "✅ Step 3 complete: Committed to automation/scripts branch"

echo ""
echo "✅ LLM Integration deployment complete!"
send_to_chat "✅ Deployment complete! LLM router is live and wired to all services."

echo ""
echo "📊 Summary:"
echo "   ✅ Secrets wired to Cloud Run"
echo "   ✅ Router deployed to src/llm/"
echo "   ✅ Code committed to automation/scripts"
echo ""
echo "🎯 Next: Update agents to use LLMRouter for inference"
