#!/usr/bin/env bash
set -o pipefail

if [ -f package.json ]; then
  if grep -q '"build"' package.json; then
    npm run build 2>&1 | grep -Ei "error|err|failed|warning|fatal|오류|실패|경고" | tail -120
    exit ${PIPESTATUS[0]}
  fi
fi

if [ -f gradlew ]; then
  ./gradlew assembleDebug 2>&1 | grep -Ei "error|failed|exception|warning|오류|실패|경고" | tail -160
  exit ${PIPESTATUS[0]}
fi

echo "빌드 명령을 찾지 못했습니다. package.json 또는 gradlew 구성을 확인하세요."
