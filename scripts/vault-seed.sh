#!/usr/bin/env bash
# vault-seed.sh — Start Vault dev server, seed secrets, export token
#
# This script:
#   1. Starts a Vault dev server in the background
#   2. Seeds secrets from environment variables into Vault KV paths
#   3. Exports VAULT_ADDR and VAULT_TOKEN for the test runner
#   4. Runs whatever command is passed as arguments
#
# Usage:
#   ./scripts/vault-seed.sh node bin/audrique.mjs run
#   ./scripts/vault-seed.sh node scripts/doctor.mjs
#
# Required env vars (passed via --env-file or -e):
#   VAULT_SEED_SF_USERNAME, VAULT_SEED_SF_PASSWORD
#   VAULT_SEED_AWS_USERNAME, VAULT_SEED_AWS_PASSWORD, VAULT_SEED_AWS_ACCOUNT_ID
#   VAULT_SEED_AWS_ACCESS_KEY_ID, VAULT_SEED_AWS_SECRET_ACCESS_KEY, VAULT_SEED_CONNECT_INSTANCE_ID
#   VAULT_SEED_OAUTH_CONSUMER_KEY, VAULT_SEED_OAUTH_CONSUMER_SECRET
#   VAULT_SEED_TWILIO_SID, VAULT_SEED_TWILIO_TOKEN (optional)

set -e

VAULT_DEV_TOKEN="dev-root-token"
VAULT_ADDR="http://127.0.0.1:8200"

echo "[vault-seed] Starting Vault dev server..."
vault server -dev -dev-root-token-id="$VAULT_DEV_TOKEN" -dev-listen-address="127.0.0.1:8200" &
VAULT_PID=$!

# Wait for Vault to be ready
for i in $(seq 1 20); do
  if curl -sf "$VAULT_ADDR/v1/sys/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Verify Vault is up
if ! curl -sf "$VAULT_ADDR/v1/sys/health" > /dev/null 2>&1; then
  echo "[vault-seed] ERROR: Vault failed to start"
  exit 1
fi
echo "[vault-seed] Vault is ready at $VAULT_ADDR"

# Export for child processes
export VAULT_ADDR="$VAULT_ADDR"
export VAULT_TOKEN="$VAULT_DEV_TOKEN"

# Seed Salesforce credentials
if [ -n "$VAULT_SEED_SF_USERNAME" ]; then
  echo "[vault-seed] Seeding secret/voice/personal/salesforce..."
  vault kv put secret/voice/personal/salesforce \
    username="$VAULT_SEED_SF_USERNAME" \
    password="${VAULT_SEED_SF_PASSWORD:-}" \
    email_code="${VAULT_SEED_SF_EMAIL_CODE:-}"
fi

# Seed AWS/Connect credentials (console login + federation API)
if [ -n "$VAULT_SEED_AWS_USERNAME" ]; then
  echo "[vault-seed] Seeding secret/voice/personal/aws..."
  vault kv put secret/voice/personal/aws \
    username="$VAULT_SEED_AWS_USERNAME" \
    password="${VAULT_SEED_AWS_PASSWORD:-}" \
    account_id="${VAULT_SEED_AWS_ACCOUNT_ID:-}" \
    access_key_id="${VAULT_SEED_AWS_ACCESS_KEY_ID:-}" \
    secret_access_key="${VAULT_SEED_AWS_SECRET_ACCESS_KEY:-}" \
    connect_instance_id="${VAULT_SEED_CONNECT_INSTANCE_ID:-}"
fi

# Seed Audrique OAuth Connected App credentials
if [ -n "$VAULT_SEED_OAUTH_CONSUMER_KEY" ]; then
  echo "[vault-seed] Seeding secret/voice/audrique/oauth..."
  vault kv put secret/voice/audrique/oauth \
    consumer_key="$VAULT_SEED_OAUTH_CONSUMER_KEY" \
    consumer_secret="${VAULT_SEED_OAUTH_CONSUMER_SECRET:-}"
fi

# Seed Twilio credentials (optional)
if [ -n "$VAULT_SEED_TWILIO_SID" ]; then
  echo "[vault-seed] Seeding secret/voice/personal/twilio..."
  vault kv put secret/voice/personal/twilio \
    account_sid="$VAULT_SEED_TWILIO_SID" \
    auth_token="${VAULT_SEED_TWILIO_TOKEN:-}"
fi

# List what was seeded
echo "[vault-seed] Secrets seeded. Verifying..."
vault kv list secret/voice/personal/ 2>/dev/null || echo "[vault-seed] (list may not work in dev mode, that's OK)"

echo "[vault-seed] Running: $@"
echo ""

# Run the actual command
"$@"
EXIT_CODE=$?

# Cleanup
kill $VAULT_PID 2>/dev/null || true
exit $EXIT_CODE
