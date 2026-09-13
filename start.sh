#!/usr/bin/env bash
# macOS / Linux 启动脚本（等价于 node start.cjs）
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$DIR/start.cjs" "$@"
