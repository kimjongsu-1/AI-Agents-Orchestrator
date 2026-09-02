#!/usr/bin/env bash
set -o pipefail

target="$1"
NODE_BIN="${NODE:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  if [ -x "/Users/h2o/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
    NODE_BIN="/Users/h2o/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  fi
fi

if [ -z "$target" ]; then
  echo "usage: ./scripts/agent-check.sh <changed-file>"
  exit 2
fi

case "$target" in
  *.js)
    "$NODE_BIN" --check "$target" 2>&1 | tail -60
    exit ${PIPESTATUS[0]}
    ;;
  *.py)
    python3 -m py_compile "$target" 2>&1 | tail -60
    exit ${PIPESTATUS[0]}
    ;;
  *.sh)
    bash -n "$target" 2>&1 | tail -60
    exit ${PIPESTATUS[0]}
    ;;
  *)
    echo "전용 체크가 없는 파일입니다: $target"
    echo "필요하면 관련 테스트 또는 린트만 좁게 실행하세요."
    ;;
esac
