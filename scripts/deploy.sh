#!/usr/bin/env bash
# 一鍵部署到 production（唯一環境，ADR-049）：
#   本機檢查（typecheck、pnpm test、pnpm e2e）→ migration → API Worker → 5 個前端 Worker → smoke →（失敗）回滾 Worker
# 用法：bash scripts/deploy.sh [production]
#   SKIP_E2E=1 可略過 Playwright（只在剛於本機跑過 pnpm e2e 時使用）
source "$(dirname "$0")/lib.sh"
load_env "${1:-production}"
require_tools
check_toml_names "$API_DIR/wrangler.toml"
print_plan "deploy "
cd "$ROOT"
grep -q "__[A-Z0-9]*_ID_${ID_TAG}__" "$API_DIR/wrangler.toml" && die "wrangler.toml 仍有 D1／KV id 佔位：請先執行 scripts/bootstrap.sh"

pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test
if [[ "${SKIP_E2E:-0}" == "1" ]]; then info "SKIP_E2E=1：略過 pnpm e2e"; else pnpm e2e; fi
ok "型別檢查、測試、E2E 通過"

# deployments list 由舊到新（2026-10-27 實測），取最後一筆＝目前生效的版本（含當時的 secrets）
PREV_VERSION="$(wr deployments list --env "$ENV_NAME" --json 2>/dev/null | jq -r '.[-1].versions[0].version_id // empty' || true)"
info "目前版本：${PREV_VERSION:-（無，首次部署）}"

wr d1 migrations apply "$D1_NAME" --remote --env "$ENV_NAME"
ok "D1 migration 完成"

GIT_SHA="$(git rev-parse --short HEAD)"; export GIT_SHA
wr deploy --env "$ENV_NAME" --var "VERSION:$GIT_SHA"
ok "Worker $WORKER_NAME 已部署（$GIT_SHA）"
sync_secret ACCESS_ALLOWED_EMAILS "$ACCESS_ALLOWED_EMAILS"   # 名單改了只要改 cf.env 再部署

for app in "${APPS[@]}"; do
  p="$(front_worker "$app")"; assert_call_name "$p"; assert_call_host "$(app_host "$app")"
  check_toml_names "$ROOT/apps/$app/wrangler.toml" 2
  # 總後台同源呼叫 /api/*（ADR-047，經 Access；Worker route 優先於自訂網域）；其他 SPA 直連 call-api
  base="https://$API_HOST"; [[ "$app" == "admin" ]] && base=""
  # VITE_AUDIO_BASE：門店後台試聽讀 call-display 的語音包；VITE_STORE_BASE：面板配對 QR 指向門店後台
  VITE_API_BASE="$base" \
  VITE_AUDIO_BASE="https://$(app_host display)/audio/" \
  VITE_STORE_BASE="https://$(app_host store)" \
    pnpm --filter "@qcs/$app" build --mode "$ENV_NAME"
  WR_CWD="$ROOT/apps/$app" cfw deploy --env "$ENV_NAME" --message "deploy.sh $GIT_SHA"
  ok "前端 $p 已部署 → https://$(app_host "$app")"
done

if bash "$ROOT/scripts/smoke.sh" "$ENV_NAME"; then
  ok "smoke test 通過，部署完成。接著請依 docs/10 C 段在正式網址做手機／電視實機驗證"
else
  if [[ -n "$PREV_VERSION" ]]; then
    wr rollback "$PREV_VERSION" --env "$ENV_NAME" -y
    die "smoke test 失敗，已自動回滾 Worker 到 $PREV_VERSION（前端如需回滾：bash scripts/rollback.sh production --frontends）"
  fi
  die "smoke test 失敗（首次部署，無可回滾版本）"
fi
