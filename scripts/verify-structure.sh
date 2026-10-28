#!/bin/bash

echo "🔍 Verifying canonical Command Hub structure..."

canonical=(
  "services/gateway/src/frontend/command-hub"
  "services/gateway/dist/frontend/command-hub"
)

for dir in "${canonical[@]}"; do
  if [ -d "$dir" ]; then
    echo "✅ Exists: $dir"
  else
    echo "❌ Missing: $dir"
  fi
done

forbidden=(
  "services/gateway/src/static/command-hub"
  "services/gateway/public/command-hub"
  "services/gateway/frontend/command-hub"
)

for dir in "${forbidden[@]}"; do
  if [ -d "$dir" ]; then
    echo "❌ Forbidden directory found: $dir"
  else
    echo "✅ Clean: $dir"
  fi
done
