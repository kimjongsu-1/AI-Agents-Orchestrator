#!/usr/bin/env bash
set -o pipefail

git diff --stat
git diff -U2 -- "$@" | sed -n '1,260p'
