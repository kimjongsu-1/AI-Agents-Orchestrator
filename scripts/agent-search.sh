#!/usr/bin/env bash
set -o pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: ./scripts/agent-search.sh <keyword>"
  exit 2
fi

rg -n --hidden \
  --glob '!node_modules/**' \
  --glob '!.git/**' \
  --glob '!dist/**' \
  --glob '!build/**' \
  "$1" | sed -n '1,120p'
