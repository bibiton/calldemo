#!/usr/bin/env bash
# 草稿・未實測 —— 日常一鍵部署：檢查 → migration → Worker → Pages → smoke →（失敗）rollback
# 用法：bash scripts/deploy.sh <staging|production>
source "$(dirname "$0")/lib.sh"
load_env "${1:-}"
require_tools
cd "$ROOT"

pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test
ok "型別檢查與測試通過"

PREV_VERSION="$(wr deployments list --env "$ENV_NAME" --json 2>/dev/null | jq -r '.[0].versions[0].version_id // empty' || true)"
info "目前版本：${PREV_VERSION:-（無，首次部署）}"

wr d1 migrations apply "$D1_NAME" --remote --env "$ENV_NAME"
ok "D1 migration 完成"

export GIT_SHA="$(git rev-parse --short HEAD)"
wr deploy --env "$ENV_NAME" --var "VERSION:$GIT_SHA"
ok "Worker 已部署（$GIT_SHA）"

for app in "${APPS[@]}"; do
  pnpm --filter "$app" build --mode "$ENV_NAME"
  wrangler pages deploy "apps/$app/dist" --project-name "qcs-$app$SUFFIX" --branch main --commit-hash "$GIT_SHA"
  ok "Pages qcs-$app$SUFFIX 已部署"
done

if bash "$ROOT/scripts/smoke.sh" "$ENV_NAME"; then
  ok "smoke test 通過，部署完成"
else
  if [[ -n "$PREV_VERSION" ]]; then
    wr rollback "$PREV_VERSION" --env "$ENV_NAME" -y
    die "smoke test 失敗，已自動回滾 Worker 到 $PREV_VERSION（Pages 請依 docs/08 §4.3 回滾）"
  fi
  die "smoke test 失敗（首次部署，無可回滾版本）"
fi
