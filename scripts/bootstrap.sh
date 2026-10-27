#!/usr/bin/env bash
# 草稿・未對 Cloudflare 實測 —— 首次建置 production（唯一環境，ADR-049），可重複執行（已存在即略過；既有金鑰類 secrets 不覆蓋）
# 用法：bash scripts/bootstrap.sh [production]
# 憑證只讀 ~/.config/queue-call-system/cf.env；所有資源名稱先過 call- 安全閘（lib.sh）。
source "$(dirname "$0")/lib.sh"
load_env "${1:-production}"
require_tools
TOML="$API_DIR/wrangler.toml"
check_toml_names "$TOML"
ok "wrangler.toml 的 production 資源名稱皆為 call- 前綴"

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

# 5. Pages 專案（5 個，只有 production）
PLIST="$(cfw pages project list 2>/dev/null || true)"
for app in "${APPS[@]}"; do
  p="$(pages_project "$app")"; assert_call_name "$p"
  if grep -qE "(^|[^a-z0-9-])$p([^a-z0-9-]|\$)" <<<"$PLIST"; then info "Pages $p 已存在，略過"
  else cfw pages project create "$p" --production-branch main >/dev/null && ok "Pages $p 已建立"; fi
done

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
  # 前端需要公鑰：寫進 customer app 的環境檔（可進 git，公鑰非機密）
  echo "VITE_VAPID_PUBLIC_KEY=$(jq -r .pub <<<"$VAPID_JSON")" > "$ROOT/apps/customer/.env.$ENV_NAME"
fi
# 用量計量（12-usage-metering）：AE SQL API 的帳號 id 與唯讀 token（Account Analytics Read）；AE_DATASET 是 wrangler.toml 的 var
sync_secret CF_ACCOUNT_ID "$CLOUDFLARE_ACCOUNT_ID"
sync_secret AE_API_TOKEN  "${AE_API_TOKEN:-}"

# 9. Pages 自訂網域＋DNS（API；權限不足時印出手動步驟）。只動 call-*.jjoy.ai，既有指向別處的 DNS 紀錄一律不改
bind_pages_domain() {  # $1=app
  local p host res dns cnt target
  p="$(pages_project "$1")"; host="$(app_host "$1")"; target="$p.pages.dev"
  assert_call_name "$p"; assert_call_host "$host"
  res="$(cf_api GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$p/domains")"
  if api_ok "$res" && jq -e --arg h "$host" '.result[]? | select(.name==$h)' >/dev/null <<<"$res"; then
    info "Pages $p 已綁定 $host，略過"
  else
    res="$(cf_api POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$p/domains" "$(jq -nc --arg h "$host" '{name:$h}')")"
    if api_ok "$res"; then ok "Pages $p 綁定 $host"
    else info "無法自動綁定 $host（權限或端點未查證）：Workers & Pages → $p → Custom domains → $host"; return 0; fi
  fi
  dns="$(cf_api GET "/zones/$CF_ZONE_ID/dns_records?name=$host")"
  api_ok "$dns" || { info "讀不到 $host 的 DNS（需 Zone DNS 權限）：請確認 CNAME $host → $target"; return 0; }
  cnt="$(jq '.result | length' <<<"$dns")"
  if (( cnt == 0 )); then
    res="$(cf_api POST "/zones/$CF_ZONE_ID/dns_records" \
      "$(jq -nc --arg n "$host" --arg c "$target" '{type:"CNAME",name:$n,content:$c,proxied:true,comment:"queue-call-system (ADR-049)"}')")"
    if api_ok "$res"; then ok "DNS CNAME $host → $target"; else info "DNS 建立失敗：請手動新增 CNAME $host → $target（Proxied）"; fi
  elif jq -e --arg c "$target" '.result[0].content == $c' >/dev/null <<<"$dns"; then
    info "DNS $host 已指向 $target，略過"
  else
    info "DNS $host 已存在且指向別處——不修改，請人工確認是否為本專案"
  fi
}
for app in "${APPS[@]}"; do bind_pages_domain "$app"; done

# 10. Cloudflare Access：應用 call-admin 保護 call-admin.jjoy.ai（整個 host，含同源 /api/*）；One-time PIN；Allow ACCESS_ALLOWED_EMAILS
#     端點與欄位（organizations、identity_providers、apps、apps/<id>/policies）未查證，失敗時改走 docs/10 步驟 11 手動設定
setup_access() {
  local A="/accounts/$CLOUDFLARE_ACCOUNT_ID/access" res team otp app_id aud include pol pid
  if [[ -z "$ACCESS_ALLOWED_EMAILS" ]]; then
    info "ACCESS_ALLOWED_EMAILS 未填：略過 Access 與平台管理員建立（業主提供名單後重跑 bootstrap 即可）"; return 0
  fi
  assert_call_name "$ACCESS_APP_NAME"; assert_call_host "$ADMIN_HOST"
  res="$(cf_api GET "$A/organizations")"
  team="$(jq -r '.result.auth_domain // empty' <<<"$res" 2>/dev/null || true)"
  [[ -n "$team" ]] || { info "讀不到 Zero Trust team（未啟用或權限不足）：請依 docs/10 步驟 11 手動設定 Access"; return 0; }

  res="$(cf_api GET "$A/identity_providers")"
  otp="$(jq -r '.result[]? | select(.type=="onetimepin") | .id' <<<"$res" 2>/dev/null | head -n1 || true)"
  if [[ -z "$otp" ]]; then
    res="$(cf_api POST "$A/identity_providers" '{"name":"One-time PIN","type":"onetimepin","config":{}}')"
    otp="$(jq -r '.result.id // empty' <<<"$res" 2>/dev/null || true)"
    [[ -n "$otp" ]] || { info "無法啟用 One-time PIN：請手動 Settings → Authentication → Login methods → One-time PIN"; return 0; }
    ok "Access 登入方式 One-time PIN 已啟用"
  fi

  res="$(cf_api GET "$A/apps")"
  api_ok "$res" || { info "讀不到 Access 應用清單（權限不足？）：請依 docs/10 步驟 11 手動設定"; return 0; }
  app_id="$(jq -r --arg n "$ACCESS_APP_NAME" '.result[]? | select(.name==$n) | .id' <<<"$res" | head -n1)"
  if [[ -n "$app_id" ]]; then
    jq -e --arg n "$ACCESS_APP_NAME" --arg d "$ADMIN_HOST" '.result[] | select(.name==$n) | .domain == $d' >/dev/null <<<"$res" \
      || die "Access 應用 $ACCESS_APP_NAME 已存在但網域不是 $ADMIN_HOST，請人工確認（不自動修改）"
    aud="$(jq -r --arg n "$ACCESS_APP_NAME" '.result[] | select(.name==$n) | .aud' <<<"$res")"
    info "Access 應用 $ACCESS_APP_NAME 已存在，略過建立"
  else
    res="$(cf_api POST "$A/apps" "$(jq -nc --arg n "$ACCESS_APP_NAME" --arg d "$ADMIN_HOST" --arg idp "$otp" \
      '{name:$n,domain:$d,type:"self_hosted",session_duration:"24h",allowed_idps:[$idp],auto_redirect_to_identity:true,app_launcher_visible:false}')")"
    api_ok "$res" || { info "無法建立 Access 應用：請依 docs/10 步驟 11 手動設定"; return 0; }
    app_id="$(jq -r .result.id <<<"$res")"; aud="$(jq -r .result.aud <<<"$res")"
    ok "Access 應用 $ACCESS_APP_NAME（$ADMIN_HOST）已建立"
  fi

  include="$(jq -nc --arg l "$ACCESS_ALLOWED_EMAILS" '$l | split(",") | map({email:{email:.}})')"
  pol="$(jq -nc --argjson inc "$include" '{name:"call-admin-allow",decision:"allow",include:$inc,precedence:1}')"
  res="$(cf_api GET "$A/apps/$app_id/policies")"
  pid="$(jq -r '.result[]? | select(.name=="call-admin-allow") | .id' <<<"$res" 2>/dev/null | head -n1 || true)"
  if [[ -n "$pid" ]]; then res="$(cf_api PUT "$A/apps/$app_id/policies/$pid" "$pol")"
  else res="$(cf_api POST "$A/apps/$app_id/policies" "$pol")"; fi
  if api_ok "$res"; then ok "Access policy：Allow ACCESS_ALLOWED_EMAILS（$(tr ',' '\n' <<<"$ACCESS_ALLOWED_EMAILS" | wc -l | tr -d ' ') 人）"
  else info "Access policy 設定失敗：請手動 Policies → Allow → Emails"; fi

  sync_secret ACCESS_AUD "$aud"
  sync_secret ACCESS_TEAM_DOMAIN "$team"
}
setup_access
sync_secret ACCESS_ALLOWED_EMAILS "$ACCESS_ALLOWED_EMAILS"
# Access 手動設定時，可把 AUD／team 填進 cf.env（選填）由這裡同步
[[ -n "${ACCESS_AUD:-}" ]] && sync_secret ACCESS_AUD "$ACCESS_AUD"
[[ -n "${ACCESS_TEAM_DOMAIN:-}" ]] && sync_secret ACCESS_TEAM_DOMAIN "$ACCESS_TEAM_DOMAIN"

# 11. 語音包隨 apps/display 的 Pages 部署（ADR-026），這裡只做檢查
if [[ -f "$ROOT/assets/audio/manifest.json" ]]; then
  n="$(find "$ROOT/assets/audio" -type f | wc -l)"
  (( n < 15000 )) || die "語音包 $n 檔，加上前端檔可能超過 Pages 單站 20,000 檔上限"
  ok "語音包 $n 檔，將隨 display 部署"
else
  info "找不到 assets/audio/manifest.json，面板將只能用 speechSynthesis 備援"
fi

# 12. 預設品牌、smoke 門店、平台管理員（email 已在 lib.sh 驗證格式）
NOW="$(date +%s)000"
SQL="INSERT OR IGNORE INTO brands(id,name,created_at,updated_at) VALUES('brand_default','預設品牌',$NOW,$NOW);"
SQL+="INSERT OR IGNORE INTO stores(id,brand_id,code,name,created_at,updated_at) VALUES('store_smoke','brand_default','SMOKE0','smoke 測試門店',$NOW,$NOW);"
IFS=',' read -ra EMAILS <<<"$ACCESS_ALLOWED_EMAILS"
for e in "${EMAILS[@]}"; do
  [[ -n "$e" ]] || continue
  SQL+="INSERT OR IGNORE INTO users(id,role,display_name,email,created_at,updated_at) VALUES('pa_$(printf '%s' "$e" | openssl sha1 | awk '{print $NF}' | cut -c1-12)','platform_admin','$e','$e',$NOW,$NOW);"
done
wr d1 execute "$D1_NAME" --remote --env "$ENV_NAME" --command "$SQL" >/dev/null
ok "預設品牌、smoke 門店、平台管理員已建立"

# 13. 完整部署（含建置 5 個前端、smoke）
bash "$ROOT/scripts/deploy.sh" "$ENV_NAME"
ok "bootstrap 完成：$(for a in "${APPS[@]}"; do printf 'https://%s  ' "$(app_host "$a")"; done)https://$API_HOST"
