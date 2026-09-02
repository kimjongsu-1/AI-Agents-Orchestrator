#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="/Users/h2o/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
./node_modules/.bin/electron .
