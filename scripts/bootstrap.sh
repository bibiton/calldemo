#!/usr/bin/env bash
# 首次建置 production（唯一環境，ADR-049），可重複執行（已存在即略過；既有金鑰類 secrets 不覆蓋）
# 用法：bash scripts/bootstrap.sh [production]
#   SKIP_DEPLOY=1：只建資源與設定，最後不執行 deploy.sh（之後再手動 bash scripts/deploy.sh）
# 憑證只讀 ~/.config/queue-call-system/cf.env；所有資源名稱先過 call- 安全閘（lib.sh）。
source "$(dirname "$0")/lib.sh"
load_env "${1:-production}"
require_tools
TOML="$API_DIR/wrangler.toml"
check_toml_names "$TOML"
ok "wrangler.toml 的 production 資源名稱皆為 call- 前綴"
print_plan "bootstrap "

fill_placeholder() {  # $1=佔位名 $2=實際 id
  local ph="__${1}_${ID_TAG}__"
  [[ "$2" =~ ^[0-9a-f-]{32,36}$ ]] || die "$1 取得的 id 格式不對：$2"
  if grep -q "$ph" "$TOML"; then
    sed -i.bak "s/$ph/$2/" "$TOML" && rm -f "$TOML.bak"; ok "wrangler.toml 寫入 $1=$2"
  else
    grep -q "$2" "$TOML" || die "wrangler.toml 的 $1 已填但與實際 id ($2) 不符，請人工確認"
    info "wrangler.toml 的 $1 已填，略過"
  fi
}

# 1. D1
assert_call_name "$D1_NAME"
d1_id() { cfw d1 list --json | jq -r --arg n "$D1_NAME" '.[] | select(.name==$n) | .uuid'; }
D1_ID="$(d1_id)"
if [[ -z "$D1_ID" ]]; then
  cfw d1 create "$D1_NAME" >/dev/null; D1_ID="$(d1_id)"; ok "D1 $D1_NAME 已建立"
else info "D1 $D1_NAME 已存在，略過"; fi
fill_placeholder D1_ID "$D1_ID"

# 2. KV（在暫存目錄執行，標題不會被加上 Worker 名稱前綴；若實際仍被加前綴，下面找不到會中止——未查證）
assert_call_name "$KV_NAME"
kv_id() { cfw kv namespace list | jq -r --arg n "$KV_NAME" '.[] | select(.title==$n) | .id'; }
KV_ID="$(kv_id)"
if [[ -z "$KV_ID" ]]; then
  cfw kv namespace create "$KV_NAME" >/dev/null; KV_ID="$(kv_id)"
  [[ -n "$KV_ID" ]] || die "KV 已建立但找不到標題為 $KV_NAME 的 namespace（可能被加了前綴），請到 dashboard 確認"
  ok "KV $KV_NAME 已建立"
else info "KV $KV_NAME 已存在，略過"; fi
fill_placeholder KV_ID "$KV_ID"

# 3. R2（媒體：ads／logo）＋ CORS ＋ 自訂網域 call-media.jjoy.ai；不開 r2.dev 公開網址（ADR-049）
assert_call_name "$R2_NAME"; assert_call_host "$MEDIA_HOST"
if cfw r2 bucket list | grep -qE "^name:[[:space:]]+$R2_NAME\$"; then info "R2 $R2_NAME 已存在，略過"
else cfw r2 bucket create "$R2_NAME" >/dev/null && ok "R2 $R2_NAME 已建立"; fi

CORS_FILE="$WR_HOME/r2-cors.json"
CORS_ORIGINS="$(for a in display store admin customer; do printf '"https://%s",' "$(app_host "$a")"; done)"
# CORS JSON 格式（rules[].allowed.origins/methods/headers、maxAgeSeconds）未查證，以 wrangler r2 bucket cors set 實際接受為準
printf '{"rules":[{"allowed":{"origins":[%s],"methods":["GET","HEAD"],"headers":["range"]},"exposeHeaders":["content-length","content-range","etag"],"maxAgeSeconds":86400}]}\n' \
  "${CORS_ORIGINS%,}" >"$CORS_FILE"
if cfw r2 bucket cors set "$R2_NAME" --file "$CORS_FILE" -y >/dev/null; then ok "R2 CORS：GET/HEAD 允許 call-display／call-store／call-admin／call-q"
else info "R2 CORS 設定失敗：請依 docs/10 步驟 10-3 在 dashboard 設定"; fi

if cfw r2 bucket domain list "$R2_NAME" 2>/dev/null | grep -q "$MEDIA_HOST"; then info "R2 自訂網域 $MEDIA_HOST 已綁定，略過"
elif cfw r2 bucket domain add "$R2_NAME" --domain "$MEDIA_HOST" --zone-id "$CF_ZONE_ID" --min-tls 1.2 -y >/dev/null; then
  ok "R2 自訂網域 $MEDIA_HOST 已綁定"
else
  info "R2 自訂網域無法自動綁定（token 權限不足？）。請手動：R2 → $R2_NAME → Settings → Custom Domains → Add → $MEDIA_HOST"
fi
info "r2.dev 公開網址維持關閉（本腳本不會執行 r2 bucket dev-url enable）；長期快取 Cache Rule 請依 docs/08 §6.1 手動建立"

# 4. Queues
QLIST="$(cfw queues list)"
for q in "${QUEUES[@]}"; do
  assert_call_name "$q"
  if grep -qE "(^|[^a-z0-9-])$q([^a-z0-9-]|\$)" <<<"$QLIST"; then info "Queue $q 已存在，略過"
  else cfw queues create "$q" >/dev/null && ok "Queue $q 已建立"; fi
done

# 5. 前端：5 個 assets-only Worker（ADR-050）。Worker 與 call-<sub>.jjoy.ai 自訂網域（含 DNS、憑證）由 deploy.sh 的
#    wrangler deploy 建立，這裡只檢查設定檔名稱與網域都是 call-
for app in "${APPS[@]}"; do
  check_toml_names "$ROOT/apps/$app/wrangler.toml" 2
  grep -q "name = \"$(front_worker "$app")\"" "$ROOT/apps/$app/wrangler.toml" || die "apps/$app/wrangler.toml 的 production 名稱不是 $(front_worker "$app")"
done
ok "5 個前端 Worker 設定檔通過 call- 安全閘"

# 6. D1 migration（wrangler 自己記錄已套用者）
wr d1 migrations apply "$D1_NAME" --remote --env "$ENV_NAME"
ok "D1 migration 完成"

# 7. 首次部署 Worker（建立 Worker、DO class、Queue consumer、Cron、call-api 自訂網域、call-admin/api/* route）
wr deploy --env "$ENV_NAME"
ok "Worker $WORKER_NAME 已部署"

# 8. Secrets：金鑰類不覆蓋（覆蓋 JWT／QR 金鑰會讓所有裝置登出、所有 QR 失效）
EXISTING="$(wr secret list --env "$ENV_NAME" 2>/dev/null | jq -r '.[].name' || true)"
put_secret() {  # $1=名稱 $2=值（空值略過）
  if [[ -z "${2:-}" ]]; then info "secret $1 沒有值，略過（填好 cf.env 後重跑）"
  elif grep -qx "$1" <<<"$EXISTING"; then info "secret $1 已存在，不覆蓋"
  else printf '%s' "$2" | wr secret put "$1" --env "$ENV_NAME" >/dev/null && ok "secret $1 已設定"; fi
}
put_secret JWT_SECRET     "$(openssl rand -base64 48)"
put_secret PHONE_PEPPER   "$(openssl rand -base64 48)"
put_secret QR_ROOT_SECRET "$(openssl rand -base64 48)"
put_secret VAPID_SUBJECT  "$PUSH_CONTACT"
if ! grep -qx VAPID_PRIVATE_KEY <<<"$EXISTING"; then
  VAPID_JSON="$(node -e '
    const {generateKeyPairSync}=require("crypto");
    const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"P-256"});
    const j=publicKey.export({format:"jwk"}); const d=privateKey.export({format:"jwk"}).d;
    const raw=Buffer.concat([Buffer.from([4]),Buffer.from(j.x,"base64url"),Buffer.from(j.y,"base64url")]);
    console.log(JSON.stringify({pub:raw.toString("base64url"),priv:d}));')"
  put_secret VAPID_PRIVATE_KEY "$(jq -r .priv <<<"$VAPID_JSON")"
  put_secret VAPID_PUBLIC_KEY  "$(jq -r .pub  <<<"$VAPID_JSON")"
  # 前端不需要建置期公鑰：顧客頁由 API（/api/s/:code/session 的 push.publicKey）取得
fi
# 用量計量（12-usage-metering）：AE SQL API 的帳號 id 與唯讀 token（Account Analytics Read）；AE_DATASET 是 wrangler.toml 的 var
sync_secret CF_ACCOUNT_ID "$CLOUDFLARE_ACCOUNT_ID"
sync_secret AE_API_TOKEN  "${AE_API_TOKEN:-}"

# 9. 網域：call-api／5 個前端由 wrangler.toml 的 custom_domain 在部署時建立（wrangler 會拒絕覆蓋既有的同名 DNS 紀錄）；
#    call-media 見步驟 3。Access 要在 call-admin 網域存在後才能由登入導向讀到 team domain，所以若 SKIP_DEPLOY=1，部署後再跑一次 bootstrap。
# 10. Cloudflare Access：應用 call-admin 保護 call-admin.jjoy.ai（整個 host，含同源 /api/*）；One-time PIN；Allow ACCESS_ALLOWED_EMAILS
#     端點與欄位（organizations、identity_providers、apps、apps/<id>/policies）未查證，失敗時改走 docs/10 步驟 11 手動設定
setup_access() {
  local A="/accounts/$CLOUDFLARE_ACCOUNT_ID/access" res team otp app_id aud include pol pid idps loc
  if [[ -z "$ACCESS_ALLOWED_EMAILS" ]]; then
    info "ACCESS_ALLOWED_EMAILS 未填：略過 Access 與平台管理員建立（業主提供名單後重跑 bootstrap 即可）"; return 0
  fi
  assert_call_name "$ACCESS_APP_NAME"; assert_call_host "$ADMIN_HOST"

  # 登入方式 One-time PIN（帳號層級設定；已存在就沿用，不修改其他登入方式）
  res="$(cf_api GET "$A/identity_providers")"
  if ! api_ok "$res"; then
    info "讀不到 Access 登入方式（token 缺 Access: Organizations, Identity Providers, and Groups Read）"
  else
    otp="$(jq -r '.result[]? | select(.type=="onetimepin") | .id' <<<"$res" | head -n1)"
    if [[ -z "$otp" ]]; then
      res="$(cf_api POST "$A/identity_providers" '{"name":"One-time PIN","type":"onetimepin","config":{}}')"
      otp="$(jq -r '.result.id // empty' <<<"$res" 2>/dev/null || true)"
      if [[ -n "$otp" ]]; then ok "Access 登入方式 One-time PIN 已啟用"
      else info "無法啟用 One-time PIN（$(jq -r '[.errors[]?.message]|join("; ")' <<<"$res" 2>/dev/null)）：token 缺 Access: Organizations, Identity Providers, and Groups Edit，或請手動 Zero Trust → Settings → Authentication → Login methods → One-time PIN"; fi
    else info "Access 登入方式 One-time PIN 已存在，沿用"; fi
  fi
  idps="[]"; [[ -n "${otp:-}" ]] && idps="$(jq -nc --arg i "$otp" '[$i]')"

  res="$(cf_api GET "$A/apps")"
  api_ok "$res" || { info "讀不到 Access 應用清單（token 缺 Access: Apps and Policies Read）：請依 docs/10 步驟 11 手動設定"; return 0; }
  app_id="$(jq -r --arg n "$ACCESS_APP_NAME" '.result[]? | select(.name==$n) | .id' <<<"$res" | head -n1)"
  if [[ -n "$app_id" ]]; then
    jq -e --arg n "$ACCESS_APP_NAME" --arg d "$ADMIN_HOST" '.result[] | select(.name==$n) | .domain == $d' >/dev/null <<<"$res" \
      || die "Access 應用 $ACCESS_APP_NAME 已存在但網域不是 $ADMIN_HOST，請人工確認（不自動修改）"
    aud="$(jq -r --arg n "$ACCESS_APP_NAME" '.result[] | select(.name==$n) | .aud' <<<"$res")"
    info "Access 應用 $ACCESS_APP_NAME 已存在，略過建立"
  else
    res="$(cf_api POST "$A/apps" "$(jq -nc --arg n "$ACCESS_APP_NAME" --arg d "$ADMIN_HOST" --argjson idp "$idps" \
      '{name:$n,domain:$d,type:"self_hosted",session_duration:"24h",allowed_idps:$idp,auto_redirect_to_identity:($idp|length==1),app_launcher_visible:false}')")"
    if ! api_ok "$res"; then
      info "無法建立 Access 應用（$(jq -r '[.errors[]?.message]|join("; ")' <<<"$res" 2>/dev/null)）：token 缺 Access: Apps and Policies Edit，或請依 docs/10 步驟 11 手動設定"; return 0
    fi
    app_id="$(jq -r .result.id <<<"$res")"; aud="$(jq -r .result.aud <<<"$res")"
    ok "Access 應用 $ACCESS_APP_NAME（$ADMIN_HOST）已建立"
  fi

  include="$(jq -nc --arg l "$ACCESS_ALLOWED_EMAILS" '$l | split(",") | map({email:{email:.}})')"
  pol="$(jq -nc --argjson inc "$include" '{name:"call-admin-allow",decision:"allow",include:$inc,precedence:1}')"
  res="$(cf_api GET "$A/apps/$app_id/policies")"
  pid="$(jq -r '.result[]? | select(.name=="call-admin-allow") | .id' <<<"$res" 2>/dev/null | head -n1 || true)"
  if [[ -n "$pid" ]]; then res="$(cf_api PUT "$A/apps/$app_id/policies/$pid" "$pol")"
  else res="$(cf_api POST "$A/apps/$app_id/policies" "$pol")"; fi
  if api_ok "$res"; then ok "Access policy call-admin-allow：Allow ACCESS_ALLOWED_EMAILS（$(tr ',' '\n' <<<"$ACCESS_ALLOWED_EMAILS" | wc -l | tr -d ' ') 人）"
  else info "Access policy 設定失敗（$(jq -r '[.errors[]?.message]|join("; ")' <<<"$res" 2>/dev/null)）：請手動 Policies → Allow → Emails"; fi
  sync_secret ACCESS_AUD "$aud"

  # team domain：cf.env 有就用；否則讀 organizations（需 Organizations Read）；再不行就看 Access 登入導向的主機名稱
  team="${ACCESS_TEAM_DOMAIN:-}"
  [[ -n "$team" ]] || team="$(jq -r '.result.auth_domain // empty' <<<"$(cf_api GET "$A/organizations")" 2>/dev/null || true)"
  if [[ -z "$team" ]]; then
    local i
    for i in 1 2 3 4 5 6; do
      loc="$(curl -s -o /dev/null -w '%{redirect_url}' "https://$ADMIN_HOST/" || true)"
      team="$(sed -nE 's#^https://([a-z0-9-]+\.cloudflareaccess\.com)/.*#\1#p' <<<"$loc")"
      [[ -n "$team" ]] && break; sleep 10
    done
  fi
  if [[ -n "$team" ]]; then sync_secret ACCESS_TEAM_DOMAIN "$team"
  else info "讀不到 Access team domain：請在 cf.env 填 ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com 後重跑"; fi
}
setup_access
sync_secret ACCESS_ALLOWED_EMAILS "$ACCESS_ALLOWED_EMAILS"
# Access 手動設定時，可把 AUD／team 填進 cf.env（選填）由這裡同步
if [[ -n "${ACCESS_AUD:-}" ]]; then sync_secret ACCESS_AUD "$ACCESS_AUD"; fi
if [[ -n "${ACCESS_TEAM_DOMAIN:-}" ]]; then sync_secret ACCESS_TEAM_DOMAIN "$ACCESS_TEAM_DOMAIN"; fi

# 11. 語音包隨 apps/display 的前端 Worker 部署（ADR-026、ADR-050），這裡只做檢查
if [[ -f "$ROOT/assets/audio/manifest.json" ]]; then
  n="$(find "$ROOT/assets/audio" -type f | wc -l)"
  (( n < 15000 )) || die "語音包 $n 檔，加上前端檔可能超過靜態資源 20,000 檔（Free）上限"
  ok "語音包 $n 檔，將隨 display 部署"
else
  info "找不到 assets/audio/manifest.json，面板將只能用 speechSynthesis 備援"
fi

# 12. 預設品牌、smoke 門店（＋smoke 店長，供 scripts/smoke-ws.mjs）、平台管理員（email 已在 lib.sh 驗證格式）
SMOKE_FILE="$HOME/.config/queue-call-system/smoke.json"
if [[ ! -f "$SMOKE_FILE" ]]; then
  ( umask 077; jq -nc --arg p "$(openssl rand -base64 24 | tr -d '/+=')" \
      '{storeId:"store_smoke",email:"smoke@call-smoke.invalid",password:$p}' >"$SMOKE_FILE" )
  ok "smoke 店長帳密已產生：$SMOKE_FILE（600，只用於部署驗證）"
fi
SMOKE_HASH="$(jq -r .password "$SMOKE_FILE" | node -e '
  const {pbkdf2Sync,randomBytes}=require("crypto"); let p="";
  process.stdin.on("data",d=>p+=d).on("end",()=>{p=p.trim(); const s=randomBytes(16);
  process.stdout.write(`pbkdf2$sha256$100000$${s.toString("base64")}$${pbkdf2Sync(p,s,100000,32,"sha256").toString("base64")}`);});')"
[[ "$SMOKE_HASH" =~ ^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$ ]] || die "smoke 店長密碼雜湊失敗"
NOW="$(date +%s)000"
SQL="INSERT OR IGNORE INTO brands(id,name,created_at,updated_at) VALUES('brand_default','預設品牌',$NOW,$NOW);"
SQL+="INSERT OR IGNORE INTO stores(id,brand_id,code,name,features,created_at,updated_at) VALUES('store_smoke','brand_default','SMOKE0','smoke 測試門店','{\"internal\":true}',$NOW,$NOW);"
SQL+="INSERT INTO users(id,role,store_id,display_name,email,password_hash,status,created_at,updated_at) VALUES('store_smoke_admin','store_admin','store_smoke','smoke','smoke@call-smoke.invalid','$SMOKE_HASH','active',$NOW,$NOW) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,status='active',failed_attempts=0,locked_until=NULL,updated_at=excluded.updated_at;"
IFS=',' read -ra EMAILS <<<"$ACCESS_ALLOWED_EMAILS"
for e in "${EMAILS[@]}"; do
  [[ -n "$e" ]] || continue
  SQL+="INSERT OR IGNORE INTO users(id,role,display_name,email,created_at,updated_at) VALUES('pa_$(printf '%s' "$e" | openssl sha1 | awk '{print $NF}' | cut -c1-12)','platform_admin','$e','$e',$NOW,$NOW);"
done
wr d1 execute "$D1_NAME" --remote --env "$ENV_NAME" --command "$SQL" -y >/dev/null
ok "預設品牌、smoke 門店與店長、平台管理員已建立"

# 13. 完整部署（含建置 5 個前端、smoke）
if [[ "${SKIP_DEPLOY:-0}" == "1" ]]; then info "SKIP_DEPLOY=1：略過完整部署，請接著執行 bash scripts/deploy.sh"; exit 0; fi
bash "$ROOT/scripts/deploy.sh" "$ENV_NAME"
ok "bootstrap 完成：$(for a in "${APPS[@]}"; do printf 'https://%s  ' "$(app_host "$a")"; done)https://$API_HOST"
