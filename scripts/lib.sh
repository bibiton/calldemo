#!/usr/bin/env bash
# 草稿・未實測 —— 共用函式
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
APPS=(admin store staff display customer)

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
info() { printf '• %s\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

load_env() {
  ENV_NAME="${1:-}"
  [[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "production" ]] || die "用法：$0 <staging|production>"
  local cfg="$ROOT/scripts/config.$ENV_NAME.env"
  [[ -f "$cfg" ]] || die "找不到 $cfg（請由 config.example.env 複製）"
  # shellcheck disable=SC1090
  source "$cfg"
  if [[ "$ENV_NAME" == "staging" ]]; then
    SUFFIX="-staging"; HOST_BASE="staging.$DOMAIN"; ID_TAG="STAGING"
  else
    SUFFIX="";         HOST_BASE="$DOMAIN";         ID_TAG="PRODUCTION"
  fi
  D1_NAME="qcs-db$SUFFIX"; KV_NAME="qcs-license$SUFFIX"; R2_NAME="qcs-media$SUFFIX"
  QUEUES=("qcs-history$SUFFIX" "qcs-push$SUFFIX" "qcs-history-dlq$SUFFIX" "qcs-push-dlq$SUFFIX")
  WORKER_NAME="qcs-api$SUFFIX"
}

require_tools() {
  for t in node pnpm wrangler jq openssl curl; do
    command -v "$t" >/dev/null || die "缺少工具：$t"
  done
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 20 )) || die "需要 Node 20 以上（目前 $(node -v)）"
  wrangler whoami >/dev/null 2>&1 || die "尚未登入：請先執行 wrangler login"
}

wr() { (cd "$API_DIR" && wrangler "$@"); }
