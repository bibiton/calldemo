#!/usr/bin/env bash
# 共用函式（ADR-049：只有 production 一個環境、jjoy.ai、call- 前綴）
#
# 憑證：只讀 ~/.config/queue-call-system/cf.env（CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、CF_ZONE_ID、ACCESS_ALLOWED_EMAILS）。
#   - 不使用、不讀取、不覆寫全域 `wrangler login`：wrangler 一律經 cfw() 執行，HOME／XDG_CONFIG_HOME 指到本次執行的暫存目錄，
#     並以環境變數帶入 token（wrangler 4.153 原始碼：環境變數的 token 優先於已存的 OAuth 登入；
#     CLOUDFLARE_API_KEY＋CLOUDFLARE_EMAIL 又優先於 token，所以 cfw() 會清掉這兩個）。
#   - 任何函式都不印出 token；不要在這些腳本加 `set -x`。
# 安全閘：共用帳號上還有其他產品（noah／ecshop／pos／reserve），所有會建立或修改的資源名稱都先過 assert_call_name／assert_call_host。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
CF_ENV_FILE="$HOME/.config/queue-call-system/cf.env"

ENV_NAME="production"
DOMAIN="jjoy.ai"
APPS=(admin store staff display customer)

WORKER_NAME="call-api-$ENV_NAME"
D1_NAME="call-db-$ENV_NAME"
KV_NAME="call-license-$ENV_NAME"
R2_NAME="call-media-$ENV_NAME"
QUEUES=("call-history-$ENV_NAME" "call-push-$ENV_NAME" "call-history-dlq-$ENV_NAME" "call-push-dlq-$ENV_NAME")
AE_DATASET="call_usage_$ENV_NAME"
ACCESS_APP_NAME="call-admin"
API_HOST="call-api.$DOMAIN"
ADMIN_HOST="call-admin.$DOMAIN"
MEDIA_HOST="call-media.$DOMAIN"
ID_TAG="PRODUCTION"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
info() { printf '• %s\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 安全閘 ----------
assert_call_name() {  # $1=資源名稱（Worker／D1／KV／R2／Queue／Pages／Access 應用）
  [[ "${1:-}" =~ ^call-[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
    || die "安全閘：拒絕操作「${1:-}」——本專案資源名稱必須以 call- 開頭（共用帳號，ADR-049）"
}
assert_call_host() {  # $1=主機名稱，只允許 call-*.jjoy.ai
  local re="^call-[a-z0-9]([a-z0-9-]*[a-z0-9])?\\.${DOMAIN//./\\.}$"
  [[ "${1:-}" =~ $re ]] || die "安全閘：拒絕操作網域「${1:-}」——只允許 call-*.$DOMAIN（共用 zone，ADR-049）"
}
assert_call_dataset() {  # Analytics Engine dataset 只能用底線
  [[ "${1:-}" =~ ^call_[a-z0-9_]+$ ]] || die "安全閘：拒絕 AE dataset「${1:-}」——必須以 call_ 開頭"
}

app_sub()       { if [[ "$1" == customer ]]; then echo "call-q"; else echo "call-$1"; fi; }
app_host()      { echo "$(app_sub "$1").$DOMAIN"; }
front_worker()  { echo "$(app_sub "$1")-$ENV_NAME"; }   # 前端 assets-only Worker（ADR-050，原 Pages 專案）

# 檢查 wrangler.toml 的 [env.production*] 區段：Worker／D1／R2／Queue 名稱、route 網域、AE dataset 都必須屬於本專案
check_toml_names() {  # $1=wrangler.toml 路徑 $2=至少要讀到的名稱數（API 8；前端 2）
  local toml="$1" min="${2:-8}" kind val n=0 worker=""
  [[ -f "$toml" ]] || die "找不到 $toml"
  while IFS=$'\t' read -r kind val; do
    case "$kind" in
      W) assert_call_name "$val"; worker="$val" ;;
      N) assert_call_name "$val" ;;
      H) assert_call_host "$val" ;;
      D) assert_call_dataset "$val" ;;
      Z) die "wrangler.toml 的 zone_name 必須是 jjoy.ai（讀到 $val）" ;;
    esac
    n=$((n + 1))
  done < <(awk '
    function q(s) { if (match(s, /"[^"]*"/)) return substr(s, RSTART + 1, RLENGTH - 2); return "" }
    /^[[:space:]]*\[/ { h = $0; gsub(/[[:space:]]/, "", h); next }
    h !~ /^\[+env\.production[].]/ { next }
    h == "[env.production]" && /^[[:space:]]*name[[:space:]]*=/ { print "W\t" q($0) }
    /^[[:space:]]*(database_name|bucket_name|queue|dead_letter_queue)[[:space:]]*=/ { print "N\t" q($0) }
    /^[[:space:]]*dataset[[:space:]]*=/ { print "D\t" q($0) }
    /pattern[[:space:]]*=/ { s = $0; sub(/.*pattern[[:space:]]*=[[:space:]]*/, "", s); p = q(s); sub(/\/.*/, "", p); print "H\t" p }
    /^[[:space:]]*vars[[:space:]]*=/ { s = $0; while (match(s, /https:\/\/[^",\/ ]+/)) { print "H\t" substr(s, RSTART + 8, RLENGTH - 8); s = substr(s, RSTART + RLENGTH) } }
    /zone_name[[:space:]]*=/ { s = $0; sub(/.*zone_name[[:space:]]*=[[:space:]]*/, "", s); if (q(s) != "jjoy.ai") print "Z\t" q(s) }
  ' "$toml")
  [[ -n "$worker" ]] || die "wrangler.toml 找不到 [env.production] 的 Worker 名稱"
  (( n >= min )) || die "wrangler.toml 的 [env.production] 區段讀不到預期的資源名稱（只讀到 $n 個）"
}

# ---------- 憑證 ----------
load_env() {
  local arg="${1:-production}"
  [[ "$arg" == "production" ]] || die "只有 production 一個環境（ADR-049，已無 staging）。用法：$0 [production]"
  [[ -f "$CF_ENV_FILE" ]] || die "找不到 $CF_ENV_FILE（格式見 scripts/config.example.env；本腳本不使用 wrangler login）"
  local mode; mode="$(stat -c %a "$CF_ENV_FILE" 2>/dev/null || stat -f %Lp "$CF_ENV_FILE")"
  [[ "$mode" =~ ^[0-7]?[0-7]00$ ]] || die "$CF_ENV_FILE 權限 $mode 過寬，請執行：chmod 600 $CF_ENV_FILE"
  unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CF_ZONE_ID ACCESS_ALLOWED_EMAILS PUSH_CONTACT AE_API_TOKEN ACCESS_AUD ACCESS_TEAM_DOMAIN
  # shellcheck disable=SC1090
  source "$CF_ENV_FILE"
  # 只在 cfw()／cf_api() 內傳給 wrangler 與 curl；不讓 pnpm、測試、建置等子行程繼承
  export -n CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CF_ZONE_ID ACCESS_ALLOWED_EMAILS 2>/dev/null || true
  export -n PUSH_CONTACT AE_API_TOKEN ACCESS_AUD ACCESS_TEAM_DOMAIN 2>/dev/null || true
  local v
  for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CF_ZONE_ID; do
    [[ -n "${!v:-}" ]] || die "$CF_ENV_FILE 缺少 $v"
  done
  [[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || die "CLOUDFLARE_ACCOUNT_ID 格式不對（應為 32 位十六進位）"
  [[ "$CF_ZONE_ID" =~ ^[0-9a-f]{32}$ ]] || die "CF_ZONE_ID 格式不對（應為 32 位十六進位）"
  ACCESS_ALLOWED_EMAILS="$(normalize_emails "${ACCESS_ALLOWED_EMAILS:-}")"
  PUSH_CONTACT="${PUSH_CONTACT:-}"
  if [[ -z "$PUSH_CONTACT" && -n "$ACCESS_ALLOWED_EMAILS" ]]; then PUSH_CONTACT="mailto:${ACCESS_ALLOWED_EMAILS%%,*}"; fi
  local n; for n in "$WORKER_NAME" "$D1_NAME" "$KV_NAME" "$R2_NAME" "${QUEUES[@]}" "$ACCESS_APP_NAME"; do assert_call_name "$n"; done
  assert_call_dataset "$AE_DATASET"
  assert_call_host "$API_HOST"; assert_call_host "$ADMIN_HOST"; assert_call_host "$MEDIA_HOST"
}

# 逗號分隔 email → 去空白、轉小寫、驗格式（也擋掉會破壞 SQL／JSON 的字元）
normalize_emails() {
  local out="" e
  local -a list
  IFS=',' read -ra list <<<"${1:-}"
  for e in "${list[@]}"; do
    e="$(printf '%s' "$e" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    [[ -z "$e" ]] && continue
    [[ "$e" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "ACCESS_ALLOWED_EMAILS 內有格式不正確的 email：$e"
    out+="${out:+,}$e"
  done
  printf '%s' "$out"
}

require_tools() {
  local t
  for t in node pnpm jq openssl curl; do
    command -v "$t" >/dev/null || die "缺少工具：$t"
  done
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 20 )) || die "需要 Node 20 以上（目前 $(node -v)）"
  WRANGLER="$API_DIR/node_modules/.bin/wrangler"
  [[ -x "$WRANGLER" ]] || WRANGLER="$(command -v wrangler || true)"
  [[ -n "$WRANGLER" ]] || die "找不到 wrangler（請先 pnpm install）"
  WR_HOME="$(mktemp -d "${TMPDIR:-/tmp}/call-wrangler.XXXXXX")"
  trap 'rm -rf "$WR_HOME"' EXIT
  cfw whoami 2>/dev/null | grep -q "$CLOUDFLARE_ACCOUNT_ID" \
    || die "cf.env 的 token 無效或無法存取 CLOUDFLARE_ACCOUNT_ID（token 需含 Account Settings Read）"
  ok "Cloudflare token 驗證通過（未使用全域 wrangler login）"
}

# 隔離的 wrangler：暫存 HOME，token 只從環境變數帶入（不經命令列，ps 看不到）。
# 預設在暫存目錄執行（帳號層級指令不會讀到 wrangler.toml）；wr() 則在 apps/api 執行。
cfw() {
  (
    unset CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL
    export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
    export HOME="$WR_HOME" XDG_CONFIG_HOME="$WR_HOME/config" WRANGLER_SEND_METRICS=false
    cd "${WR_CWD:-$WR_HOME}"
    exec "$WRANGLER" "$@"
  )
}
wr() { WR_CWD="$API_DIR" cfw "$@"; }

# Cloudflare REST API。路徑只允許本帳號／本 zone；token 經 stdin 傳給 curl（不出現在命令列）。
# 輸出回應 JSON；網路錯誤不中止（輸出空字串），由呼叫端以 api_ok 判斷並改印手動步驟。
cf_api() {  # $1=method $2=path $3=JSON body（選填）
  local m="$1" p="$2" body="${3:-}"
  [[ "$p" == "/accounts/$CLOUDFLARE_ACCOUNT_ID/"* || "$p" == "/zones/$CF_ZONE_ID/"* ]] \
    || die "安全閘：API 路徑必須在本帳號或本 zone 之下：$p"
  local -a args=(-sS -X "$m" "https://api.cloudflare.com/client/v4$p" -H "content-type: application/json")
  [[ -n "$body" ]] && args+=(--data "$body")
  printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" | curl --config - "${args[@]}" || true
}
api_ok() { jq -e '.success == true' >/dev/null 2>&1 <<<"$1"; }

# 執行前列出「會建立或修改」的全部資源與網域，逐一過安全閘（任何一個不是 call- 就整個中止，什麼都還沒動）
print_plan() {  # $1=動作說明
  local n app
  info "${1:-本次}會建立或修改的 Cloudflare 資源（全部 call- 前綴；不刪除任何資源，不碰其他產品）："
  for n in "$WORKER_NAME" "$D1_NAME" "$KV_NAME" "$R2_NAME" "${QUEUES[@]}"; do assert_call_name "$n"; printf '    - %s\n' "$n"; done
  for app in "${APPS[@]}"; do n="$(front_worker "$app")"; assert_call_name "$n"; printf '    - 前端 Worker %s → https://%s\n' "$n" "$(app_host "$app")"; assert_call_host "$(app_host "$app")"; done
  assert_call_dataset "$AE_DATASET"; printf '    - Analytics Engine %s\n' "$AE_DATASET"
  assert_call_name "$ACCESS_APP_NAME"; printf '    - Access 應用 %s（%s）\n' "$ACCESS_APP_NAME" "$ADMIN_HOST"
  printf '    - 網域 %s（Worker）、%s/api/*（Worker route）、%s（R2）\n' "$API_HOST" "$ADMIN_HOST" "$MEDIA_HOST"
  ok "資源清單通過 call- 安全閘"
}

# Worker secret：覆寫（只用於可安全重設的值，例如 email 名單、AUD）。金鑰類用 bootstrap 的 put_secret（不覆蓋）。
sync_secret() {  # $1=名稱 $2=值（空值略過）
  [[ -n "${2:-}" ]] || { info "secret $1 未提供，略過"; return 0; }
  printf '%s' "$2" | wr secret put "$1" --env "$ENV_NAME" >/dev/null && ok "secret $1 已同步"
}
