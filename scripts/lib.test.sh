#!/usr/bin/env bash
# scripts/lib.sh 的自我測試（不連網、不碰 Cloudflare、不讀真正的 cf.env）：bash scripts/lib.test.sh
# 涵蓋：call- 安全閘、wrangler.toml 名稱檢查、cf.env 載入規則、API 路徑閘門與 token 不進命令列。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/lib.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

check() {  # $1=預期 ok|fail $2=說明 其餘=要在子 shell 執行的 bash 程式碼
  local want="$1" desc="$2"; shift 2
  local got=fail
  if HOME="$TMP/home" bash -c "source '$LIB'; $*" >/dev/null 2>&1; then got=ok; fi
  # set -e 已由 lib.sh 開啟：die 會讓子 shell 以非 0 結束
  if [[ "$got" == "$want" ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "✘ $desc（預期 $want，實際 $got）"; fi
}
mkdir -p "$TMP/home/.config/queue-call-system"

# 1. 資源名稱安全閘
check ok   "Worker 名稱"          'assert_call_name call-api-production'
check ok   "DLQ 名稱"             'assert_call_name call-push-dlq-production'
check ok   "Access 應用名稱"       'assert_call_name call-admin'
check fail "舊前綴 qcs-"          'assert_call_name qcs-api'
check fail "其他產品 noah-"        'assert_call_name noah-api-production'
check fail "空字串"               'assert_call_name ""'
check fail "只有前綴"             'assert_call_name call-'
check fail "前綴不在開頭"          'assert_call_name xcall-api'
check fail "大寫"                 'assert_call_name call-API'
check fail "夾帶指令字元"          'assert_call_name "call-db; rm -rf /"'
check fail "結尾連字號"            'assert_call_name call-db-'

# 2. 網域安全閘
check ok   "call-admin.jjoy.ai"   'assert_call_host call-admin.jjoy.ai'
check ok   "call-q.jjoy.ai"       'assert_call_host call-q.jjoy.ai'
check fail "其他產品子網域"        'assert_call_host noah.jjoy.ai'
check fail "根網域"               'assert_call_host jjoy.ai'
check fail "後綴偽造"             'assert_call_host call-admin.jjoy.ai.evil.com'
check fail "點號不是萬用字元"       'assert_call_host call-adminXjjoyXai'
check fail "其他網域"             'assert_call_host call-admin.example.com'
check ok   "AE dataset"           'assert_call_dataset call_usage_production'
check fail "AE dataset 舊名"       'assert_call_dataset qcs_usage'

# 3. 名稱對應
check ok   "顧客頁 → call-q"       '[[ "$(app_host customer)" == call-q.jjoy.ai && "$(front_worker customer)" == call-q-production ]]'
check ok   "總後台 Pages 專案"     '[[ "$(front_worker admin)" == call-admin-production ]]'

# 4. wrangler.toml 檢查（[env.local] 的 qcs-*-local 不在檢查範圍）
TOML="$HERE/../apps/api/wrangler.toml"
check ok   "實際 wrangler.toml 通過" "check_toml_names '$TOML'"
bad() { sed "$1" "$TOML" >"$TMP/bad.toml"; }
bad 's/bucket_name = "call-media-production"/bucket_name = "noah-media"/'; check fail "production bucket 非 call-" "check_toml_names '$TMP/bad.toml'"
bad 's/name = "call-api-production"/name = "qcs-api"/';                   check fail "production Worker 非 call-" "check_toml_names '$TMP/bad.toml'"
bad 's#call-admin.jjoy.ai/api/\*#noah.jjoy.ai/api/*#';                    check fail "route 指到別的產品"       "check_toml_names '$TMP/bad.toml'"
bad 's/dead_letter_queue = "call-push-dlq-production"/dead_letter_queue = "pos-dlq"/'; check fail "DLQ 非 call-" "check_toml_names '$TMP/bad.toml'"
# AE binding 目前在 toml 內為註解（帳號未啟用 AE）；取消註解後的樣子：附加一段 dataset 非 call_ 的 binding
{ cat "$TOML"; printf '[[env.production.analytics_engine_datasets]]\nbinding = "USAGE"\ndataset = "qcs_usage"\n'; } >"$TMP/bad.toml"
check fail "AE dataset 非 call_"       "check_toml_names '$TMP/bad.toml'"
{ cat "$TOML"; printf '[[env.production.analytics_engine_datasets]]\nbinding = "USAGE"\ndataset = "call_usage_production"\n'; } >"$TMP/ok.toml"
check ok   "AE dataset call_（取消註解後）" "check_toml_names '$TMP/ok.toml'"
bad 's/^\[env.production\]/[env.prod]/';                                  check fail "找不到 production 區段"    "check_toml_names '$TMP/bad.toml'"

# 5. cf.env 載入（假檔、假值；絕不讀真正的檔案——HOME 指到暫存目錄）
CF="$TMP/home/.config/queue-call-system/cf.env"
A=0123456789abcdef0123456789abcdef
write_cf() { printf '%s\n' "$@" >"$CF"; chmod 600 "$CF"; }
write_cf "CLOUDFLARE_API_TOKEN=fake-token-for-test" "CLOUDFLARE_ACCOUNT_ID=$A" "CF_ZONE_ID=$A" "ACCESS_ALLOWED_EMAILS=' Boss@Co.example , ops@co.example'"
check fail "拒絕 staging"           'load_env staging'
check ok   "預設 production"        'load_env'
check ok   "email 正規化"           'load_env; [[ "$ACCESS_ALLOWED_EMAILS" == "boss@co.example,ops@co.example" ]]'
check ok   "PUSH_CONTACT 預設第一位"  'load_env; [[ "$PUSH_CONTACT" == "mailto:boss@co.example" ]]'
check ok   "token 不匯出給子行程"     'load_env; [[ -z "$(bash -c "echo \${CLOUDFLARE_API_TOKEN:-}")" ]]'
check ok   "token 匯出版本也被收回"   'printf "export CLOUDFLARE_API_TOKEN=t\nexport CLOUDFLARE_ACCOUNT_ID='$A'\nexport CF_ZONE_ID='$A'\n" >"'"$CF"'"; load_env; [[ -z "$(bash -c "echo \${CLOUDFLARE_API_TOKEN:-}")" ]]'
write_cf "CLOUDFLARE_API_TOKEN=t" "CLOUDFLARE_ACCOUNT_ID=$A" "CF_ZONE_ID=$A"
check ok   "名單可先空白"            'load_env; [[ -z "$ACCESS_ALLOWED_EMAILS" && -z "$PUSH_CONTACT" ]]'
write_cf "CLOUDFLARE_API_TOKEN=t" "CLOUDFLARE_ACCOUNT_ID=$A" "CF_ZONE_ID=$A" "ACCESS_ALLOWED_EMAILS=\"a@b.example,x'); DROP TABLE users;--\""
check fail "email 格式不對"          'load_env'
write_cf "CLOUDFLARE_ACCOUNT_ID=$A" "CF_ZONE_ID=$A"
check fail "缺 token"               'load_env'
write_cf "CLOUDFLARE_API_TOKEN=t" "CLOUDFLARE_ACCOUNT_ID=not-an-id" "CF_ZONE_ID=$A"
check fail "account id 格式"        'load_env'
write_cf "CLOUDFLARE_API_TOKEN=t" "CLOUDFLARE_ACCOUNT_ID=$A" "CF_ZONE_ID=$A"; chmod 644 "$CF"
check fail "權限過寬"               'load_env'
rm -f "$CF"
check fail "檔案不存在"             'load_env'

# 6. API 路徑閘門＋token 不出現在 curl 命令列（假 curl 記錄參數與 stdin）
mkdir -p "$TMP/bin"
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CURL_ARGS"; cat >"$CURL_STDIN"; echo '{"success":true}'
EOF
chmod +x "$TMP/bin/curl"
api() { echo "export PATH='$TMP/bin':\$PATH CURL_ARGS='$TMP/args' CURL_STDIN='$TMP/stdin'; CLOUDFLARE_API_TOKEN=secret-xyz CLOUDFLARE_ACCOUNT_ID=$A CF_ZONE_ID=$A; $1"; }
check ok   "本帳號路徑可呼叫"        "$(api "cf_api GET /accounts/$A/pages/projects >/dev/null")"
check ok   "token 不在命令列、在 stdin" "$(api "cf_api GET /zones/$A/dns_records >/dev/null; ! grep -q secret-xyz '$TMP/args' && grep -q 'Bearer secret-xyz' '$TMP/stdin'")"
rm -f "$TMP/args"
check fail "其他帳號被擋"            "$(api "cf_api GET /accounts/ffffffffffffffffffffffffffffffff/workers/scripts")"
check ok   "被擋時沒有呼叫 curl"      "[[ ! -e '$TMP/args' ]]"
check fail "其他 zone 被擋"          "$(api "cf_api DELETE /zones/ffffffffffffffffffffffffffffffff/dns_records/1")"
check fail "非 accounts/zones 路徑"   "$(api "cf_api GET /user/tokens")"

echo "lib.test.sh：$PASS 通過，$FAIL 失敗"
(( FAIL == 0 ))
