#!/usr/bin/env bash
# 部署後在正式網址驗證（ADR-049：沒有 staging，部署後直接驗 production）
# 用法：bash scripts/smoke.sh [production]
# 只發 HTTPS GET，不需要 Cloudflare token，所以不讀 cf.env。
source "$(dirname "$0")/lib.sh"
[[ "${1:-production}" == "production" ]] || die "只有 production 一個環境（ADR-049）"
API="https://$API_HOST"
SHA="${GIT_SHA:-$(git -C "$ROOT" rev-parse --short HEAD)}"

# a. 健康檢查與版本
body="$(curl -fsS "$API/health")" || die "health 失敗"
[[ "$(jq -r .version <<<"$body")" == "$SHA" ]] || die "health 版本不符：$body"
ok "health $SHA"

# b. WebSocket：smoke 門店店長連線須收到 hello，送 ping 須收到 pong（帳密：~/.config/queue-call-system/smoke.json，bootstrap 建立）
node "$ROOT/scripts/smoke-ws.mjs" "$API" || die "WebSocket smoke 失敗"

# c. 前端首頁
for app in "${APPS[@]}"; do
  host="$(app_host "$app")"
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$host/")"
  # call-admin 受 Access 保護，未登入回 302 屬正常。回 200＝Access 尚未設定（業主還沒給名單）：
  # 靜態頁可見但 API 仍由 Worker 驗 Access JWT 擋下（見 d），所以只警示、不判定部署失敗
  if [[ "$app" == "admin" && "$code" == "200" ]]; then info "警示：$host 回 200，Cloudflare Access 尚未保護總後台（docs/10 步驟 11）"
  elif [[ "$app" == "admin" ]]; then [[ "$code" == "302" ]] || die "$host 回應 $code（預期 302 導向 Access 登入）"
  else [[ "$code" == "200" ]] || die "$host 回應 $code"; fi
done
ok "5 個前端可連線"

# d. 總後台同源 API 也在 Access 後面（ADR-047：call-admin.jjoy.ai/api/* → Worker route）
code="$(curl -s -o /dev/null -w '%{http_code}' "https://$ADMIN_HOST/api/admin/me")"
[[ "$code" == "302" || "$code" == "401" || "$code" == "403" ]] || die "https://$ADMIN_HOST/api/admin/me 回應 $code（未登入應被擋）"
# e. 直打 API 網域（前面沒有 Access）的總後台路由：Worker 必須自己驗 Access JWT 而回 401（安全審查 M-3）
code="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/admin/me")"
[[ "$code" == "401" ]] || die "$API/api/admin/me 回應 $code（沒有 Access JWT 必須 401）"
ok "API 網域的總後台路由未授權回 401"
ok "call-admin 的 /api/* 未登入被擋（$code）"

# e. 媒體網域：CORS 預檢只看標頭，不需要實際檔案（未授權來源不得回 allow-origin）
hdr="$(curl -s -o /dev/null -D - -X OPTIONS -H "Origin: https://$(app_host display)" -H "Access-Control-Request-Method: GET" "https://$MEDIA_HOST/ads/x")"
grep -qi "^access-control-allow-origin: https://$(app_host display)" <<<"$hdr" \
  && ok "call-media CORS 允許 call-display" \
  || info "call-media CORS 預檢未回 allow-origin（請依 docs/10 步驟 12 手動確認）"
