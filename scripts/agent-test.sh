#!/usr/bin/env bash
set -o pipefail

if [ -f package.json ]; then
  if grep -q '"test"' package.json; then
    npm test 2>&1 | tail -120
    exit ${PIPESTATUS[0]}
  fi
fi

if [ -f pyproject.toml ] || [ -d tests ]; then
  python3 -m pytest -q --tb=line 2>&1 | tail -120
  exit ${PIPESTATUS[0]}
fi

echo "테스트 명령을 찾지 못했습니다. package.json 또는 pytest 구성을 확인하세요."
