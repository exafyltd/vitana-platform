#!/usr/bin/env bash
# =============================================================================
# Vitana Autopilot (OpenClaw Bridge) - Setup Script
# =============================================================================
#
# Sets up OpenClaw and the Vitana bridge on Ubuntu 22.04+.
# Run: bash scripts/setup.sh
#
# Prerequisites:
# - Ubuntu 22.04+ or Debian 12+
# - Node.js >= 22 (installed by this script if missing)
# - Access to SUPABASE_URL and SUPABASE_SERVICE_ROLE
#
# For health data tasks, also install Ollama:
#   curl -fsSL https://ollama.ai/install.sh | sh
#   ollama pull llama3.1:8b
# =============================================================================

set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-/opt/vitana-autopilot}"
BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Vitana Autopilot Setup ==="
echo "OpenClaw Home: $OPENCLAW_HOME"
echo "Bridge Dir:    $BRIDGE_DIR"
echo ""

# ---------------------------------------------------------------------------
# 1. System dependencies
# ---------------------------------------------------------------------------

echo "[1/6] Checking system dependencies..."

if ! command -v node &>/dev/null; then
  echo "  Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "  ERROR: Node.js >= 22 required (found v$(node -v))"
  exit 1
fi
echo "  Node.js $(node -v) ✓"

if ! command -v pnpm &>/dev/null; then
  echo "  Installing pnpm..."
  npm install -g pnpm@9
fi
echo "  pnpm $(pnpm -v) ✓"

# ---------------------------------------------------------------------------
# 2. OpenClaw CLI
# ---------------------------------------------------------------------------

echo "[2/6] Checking OpenClaw..."

if ! command -v openclaw &>/dev/null; then
  echo "  Installing OpenClaw CLI..."
  curl -fsSL https://openclaw.ai/install.sh | bash
fi
echo "  OpenClaw $(openclaw --version 2>/dev/null || echo 'installed') ✓"

# ---------------------------------------------------------------------------
# 3. OpenClaw onboarding
# ---------------------------------------------------------------------------

echo "[3/6] Configuring OpenClaw..."

sudo mkdir -p "$OPENCLAW_HOME"

# Configure for Vitana
openclaw config set llm.provider ollama 2>/dev/null || true
openclaw config set llm.model llama3.1:8b 2>/dev/null || true
openclaw config set workspace.isolation tenant_namespaces 2>/dev/null || true

# Disable risky skills
openclaw skills disable shell browser file 2>/dev/null || true

echo "  OpenClaw configured ✓"

# ---------------------------------------------------------------------------
# 4. Ollama (for health/PHI tasks)
# ---------------------------------------------------------------------------

echo "[4/6] Checking Ollama (local LLM for health data)..."

if ! command -v ollama &>/dev/null; then
  echo "  Installing Ollama..."
  curl -fsSL https://ollama.ai/install.sh | sh
fi

# Pull health model if not present
if ! ollama list 2>/dev/null | grep -q "llama3.1:8b"; then
  echo "  Pulling llama3.1:8b model (this may take a while)..."
  ollama pull llama3.1:8b
fi
echo "  Ollama ready ✓"

# ---------------------------------------------------------------------------
# 5. Bridge dependencies
# ---------------------------------------------------------------------------

echo "[5/6] Installing bridge dependencies..."

cd "$BRIDGE_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build

echo "  Bridge built ✓"

# ---------------------------------------------------------------------------
# 6. Systemd service (optional)
# ---------------------------------------------------------------------------

echo "[6/6] Setting up systemd service..."

SYSTEMD_FILE="/etc/systemd/system/vitana-autopilot.service"

if [ ! -f "$SYSTEMD_FILE" ]; then
  sudo tee "$SYSTEMD_FILE" > /dev/null <<UNIT
[Unit]
Description=Vitana Autopilot (OpenClaw Bridge)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$BRIDGE_DIR
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=OPENCLAW_HOME=$OPENCLAW_HOME
EnvironmentFile=-/opt/vitana-autopilot/.env

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  echo "  Systemd service created ✓"
  echo "  Start with: sudo systemctl start vitana-autopilot"
  echo "  Enable on boot: sudo systemctl enable vitana-autopilot"
else
  echo "  Systemd service already exists ✓"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Create /opt/vitana-autopilot/.env with:"
echo "     SUPABASE_URL=https://your-project.supabase.co"
echo "     SUPABASE_SERVICE_ROLE=your-service-role-key"
echo "     GATEWAY_URL=http://localhost:8080"
echo "     OPENCLAW_HOME=$OPENCLAW_HOME"
echo ""
echo "  2. Start the service:"
echo "     sudo systemctl start vitana-autopilot"
echo ""
echo "  3. Verify:"
echo "     curl http://localhost:8080/vitana-webhook/health"
echo ""
