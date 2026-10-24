#!/usr/bin/env bash
# Push backend secrets from .env.local.secrets (git-ignored) into Convex env.
# Usage: bash scripts/set-env.sh [path-to-secrets-file]
set -euo pipefail

FILE="${1:-.env.local.secrets}"
NAMES=(CREAO_DISPATCHER_KEY CREAO_OWNER_KEY CREAO_WEBHOOK_TOKEN NESSIE_API_KEY APIFY_TOKEN APIFY_WEBHOOK_TOKEN CO_TOKEN_SECRET)

if [[ ! -f "$FILE" ]]; then
  echo "Missing $FILE (copy .env.example and fill in values)" >&2
  exit 1
fi

for name in "${NAMES[@]}"; do
  value="$(grep -E "^${name}=" "$FILE" | head -n1 | cut -d= -f2- || true)"
  if [[ -z "$value" ]]; then
    echo "skip  $name (empty)"
    continue
  fi
  npx convex env set "$name" "$value" > /dev/null
  echo "set   $name"   # never echo the value
done
