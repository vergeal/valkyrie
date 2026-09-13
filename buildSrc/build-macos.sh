#!/usr/bin/env bash
# 打 macOS 安装包（dmg / zip），产物在 electron/release
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$DIR/package.cjs" --target mac "$@"
