#!/bin/bash
# Check for potential secrets or credentials in tracked files.
# Run before committing: ./check-secrets.sh

set -e
echo "Checking for potential secrets in tracked files..."

# Check tracked source/config files only
if git grep -n -- 'TESLA_CLIENT_SECRET\s*=\s*["'"'"'][^"'"'"']*["'"'"']' -- '*.ts' '*.js' '*.json' '*.md' 2>/dev/null; then
  echo "⚠️  Possible hardcoded TESLA_CLIENT_SECRET"
  exit 1
fi
if git grep -n -- 'TESLA_REFRESH_TOKEN\s*=\s*["'"'"'][^"'"'"']*["'"'"']' -- '*.ts' '*.js' '*.json' '*.md' 2>/dev/null; then
  echo "⚠️  Possible hardcoded TESLA_REFRESH_TOKEN"
  exit 1
fi
if git grep -n -- 'BEGIN.*PRIVATE KEY' -- '*.ts' '*.js' '*.json' '*.md' 2>/dev/null; then
  echo "⚠️  Possible embedded private key"
  exit 1
fi

echo "No obvious secrets found. Always review diffs before pushing."
