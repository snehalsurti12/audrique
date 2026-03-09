#!/usr/bin/env bash
# vault-start.sh — Start/unseal persistent Vault in Docker + auto-unseal via macOS Keychain
#
# Vault runs as a Docker container with a named volume for persistent storage.
# Unseal key + root token stored in macOS Keychain (encrypted by OS).
#
# Usage:
#   ./scripts/vault-start.sh              # Start or unseal Vault
#   ./scripts/vault-start.sh --stop       # Stop Vault container
#   ./scripts/vault-start.sh --status     # Check Vault status
#
# First run: creates container, initializes, stores keys in Keychain, enables KV v2.
# After Docker restart: starts container, auto-unseals from Keychain.
# Data persists in Docker volume 'audrique-vault-data'.

set -e

CONTAINER_NAME="vault-dev"
VAULT_IMAGE="hashicorp/vault:1.17"
VOLUME_NAME="audrique-vault-data"
VAULT_ADDR="http://127.0.0.1:8200"
KEYCHAIN_SERVICE="audrique-vault"
KEYCHAIN_UNSEAL_ACCOUNT="unseal-key"
KEYCHAIN_TOKEN_ACCOUNT="root-token"

# ── Stop mode ──
if [ "$1" = "--stop" ]; then
  docker stop "$CONTAINER_NAME" 2>/dev/null && echo "[vault] Stopped." || echo "[vault] Not running."
  exit 0
fi

# ── Status mode ──
if [ "$1" = "--status" ]; then
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
    echo "[vault] Container not running."
    exit 1
  fi
  HEALTH=$(curl -sf "$VAULT_ADDR/v1/sys/health" 2>/dev/null)
  if [ -z "$HEALTH" ]; then
    echo "[vault] Container running but Vault not responding."
    exit 1
  fi
  SEALED=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sealed', True))")
  if [ "$SEALED" = "True" ]; then
    echo "[vault] Running but SEALED."
  else
    echo "[vault] Running and unsealed."
  fi
  exit 0
fi

# ── Ensure Docker is running ──
if ! docker info > /dev/null 2>&1; then
  echo "[vault] ERROR: Docker is not running. Start Docker Desktop first."
  exit 1
fi

# ── Start or ensure container is running ──
RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c "^${CONTAINER_NAME}$" || true)
if [ "$RUNNING" = "0" ]; then
  # Check if container exists but is stopped
  EXISTS=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -c "^${CONTAINER_NAME}$" || true)
  if [ "$EXISTS" = "1" ]; then
    echo "[vault] Starting existing container..."
    docker start "$CONTAINER_NAME" > /dev/null
  else
    echo "[vault] Creating new persistent Vault container..."
    docker run -d \
      --name "$CONTAINER_NAME" \
      --restart unless-stopped \
      -p 8200:8200 \
      -v "$VOLUME_NAME":/vault/file \
      -e 'VAULT_LOCAL_CONFIG={"storage":{"file":{"path":"/vault/file"}},"listener":{"tcp":{"address":"0.0.0.0:8200","tls_disable":1}},"disable_mlock":true,"ui":true}' \
      -e 'VAULT_ADDR=http://127.0.0.1:8200' \
      --cap-add=IPC_LOCK \
      "$VAULT_IMAGE" server > /dev/null
  fi

  # Wait for Vault to be ready
  for i in $(seq 1 30); do
    if curl -sf "$VAULT_ADDR/v1/sys/seal-status" > /dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

# ── Check if initialized ──
INIT_STATUS=$(curl -sf "$VAULT_ADDR/v1/sys/init" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('initialized', False))" 2>/dev/null || echo "error")

if [ "$INIT_STATUS" = "False" ]; then
  echo "[vault] First run — initializing..."

  INIT_RESP=$(curl -sf -X PUT "$VAULT_ADDR/v1/sys/init" -d '{"secret_shares":1,"secret_threshold":1}')
  UNSEAL_KEY=$(echo "$INIT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['keys'][0])")
  ROOT_TOKEN=$(echo "$INIT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['root_token'])")

  # Store in macOS Keychain
  security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_UNSEAL_ACCOUNT" -w "$UNSEAL_KEY" -U 2>/dev/null
  security add-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_TOKEN_ACCOUNT" -w "$ROOT_TOKEN" -U 2>/dev/null
  echo "[vault] Keys stored in macOS Keychain (service: $KEYCHAIN_SERVICE)"

  # Unseal
  curl -sf -X PUT "$VAULT_ADDR/v1/sys/unseal" -d "{\"key\":\"$UNSEAL_KEY\"}" > /dev/null
  echo "[vault] Unsealed."

  # Enable KV v2
  curl -sf -X POST "$VAULT_ADDR/v1/sys/mounts/secret" \
    -H "X-Vault-Token: $ROOT_TOKEN" \
    -d '{"type":"kv","options":{"version":"2"}}' > /dev/null 2>&1 || true
  echo "[vault] KV v2 secrets engine enabled."

  echo ""
  echo "  Vault initialized! Root token: $ROOT_TOKEN"
  echo "  Seed your secrets once — they persist forever."
elif [ "$INIT_STATUS" = "True" ]; then
  # Check if sealed
  SEALED=$(curl -sf "$VAULT_ADDR/v1/sys/seal-status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('sealed', True))" 2>/dev/null)
  if [ "$SEALED" = "True" ]; then
    echo "[vault] Unsealing from Keychain..."
    UNSEAL_KEY=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_UNSEAL_ACCOUNT" -w 2>/dev/null)
    if [ -z "$UNSEAL_KEY" ]; then
      echo "[vault] ERROR: No unseal key in Keychain."
      exit 1
    fi
    curl -sf -X PUT "$VAULT_ADDR/v1/sys/unseal" -d "{\"key\":\"$UNSEAL_KEY\"}" > /dev/null
    echo "[vault] Unsealed."
  else
    echo "[vault] Already running and unsealed."
  fi
else
  echo "[vault] ERROR: Could not reach Vault at $VAULT_ADDR"
  exit 1
fi

TOKEN=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_TOKEN_ACCOUNT" -w 2>/dev/null)
echo ""
echo "  export VAULT_ADDR=$VAULT_ADDR"
echo "  export VAULT_TOKEN=$TOKEN"
