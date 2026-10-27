#!/usr/bin/env bash
# 草稿・未實測 —— 部署後驗證
source "$(dirname "$0")/lib.sh"
load_env "${1:-}"
API="https://api.$HOST_BASE"
SHA="${GIT_SHA:-$(git -C "$ROOT" rev-parse --short HEAD)}"

# a. 健康檢查與版本
body="$(curl -fsS "$API/health")" || die "health 失敗"
[[ "$(jq -r .version <<<"$body")" == "$SHA" ]] || die "health 版本不符：$body"
ok "health $SHA"

# b. WebSocket：smoke 門店，送 ping 須收到 pong 與 hello（token 由 /smoke/token 以 SMOKE_SECRET 換取，待實作）
node "$ROOT/scripts/smoke-ws.mjs" "$API" || die "WebSocket smoke 失敗"
ok "WebSocket ping/pong"

# c. 前端首頁
for app in admin store staff display customer; do
  host="$app"; [[ "$app" == "customer" ]] && host="q"
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$host.$HOST_BASE/")"
  # admin 受 Access 保護，未登入回 302 屬正常
  [[ "$code" == "200" || ( "$app" == "admin" && "$code" == "302" ) ]] || die "$host 回應 $code"
done
ok "5 個前端可連線"
