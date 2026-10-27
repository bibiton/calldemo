#!/usr/bin/env bash
# 回滾 production：API Worker（含 DO 程式碼、Queue consumer、Cron）；加 --frontends 一併把 5 個前端 Worker 回到各自上一版
# 用法：bash scripts/rollback.sh [production] [version-id] [--frontends]
#   不帶 version-id：API Worker 回到上一版（wrangler rollback 預設）。version-id 可由 wrangler versions list 查（輸出不含機密）。
# D1 不回滾（migration 只做向下相容，docs/08 §5）。
source "$(dirname "$0")/lib.sh"
FRONT=0; ARGS=()
for a in "$@"; do if [[ "$a" == "--frontends" ]]; then FRONT=1; else ARGS+=("$a"); fi; done
load_env "${ARGS[0]:-production}"
require_tools
assert_call_name "$WORKER_NAME"
VER="${ARGS[1]:-}"
[[ -z "$VER" || "$VER" =~ ^[0-9a-f-]{36}$ ]] || die "version-id 格式不對：$VER"
if [[ -n "$VER" ]]; then wr rollback "$VER" --env "$ENV_NAME" -y -m "rollback.sh"
else wr rollback --env "$ENV_NAME" -y -m "rollback.sh"; fi
ok "Worker $WORKER_NAME 已回滾${VER:+ 到 $VER}"
if (( FRONT )); then
  for app in "${APPS[@]}"; do
    p="$(front_worker "$app")"; assert_call_name "$p"
    WR_CWD="$ROOT/apps/$app" cfw rollback --env "$ENV_NAME" -y -m "rollback.sh" && ok "前端 $p 已回滾到上一版"
  done
else
  info "前端未回滾（需要時加 --frontends）"
fi
info "D1 不回滾（migration 只做向下相容）"
