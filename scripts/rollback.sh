#!/usr/bin/env bash
# 草稿・未對 Cloudflare 實測 —— 回滾 production Worker（含 DO 程式碼、Queue consumer、Cron）
# 用法：bash scripts/rollback.sh [production] [version-id]
source "$(dirname "$0")/lib.sh"
load_env "${1:-production}"
require_tools
assert_call_name "$WORKER_NAME"
if [[ -n "${2:-}" ]]; then wr rollback "$2" --env "$ENV_NAME" -y
else wr rollback --env "$ENV_NAME" -y; fi
ok "Worker $WORKER_NAME 已回滾"
info "D1 不回滾（migration 只做向下相容）。Pages 回滾：dashboard → call-<app>-production → Deployments → Rollback"
