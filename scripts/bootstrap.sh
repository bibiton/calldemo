#!/usr/bin/env bash
# 草稿・未實測 —— 首次建置，可重複執行（已存在即略過；既有 secrets 不覆蓋）
# 用法：bash scripts/bootstrap.sh <staging|production>
source "$(dirname "$0")/lib.sh"
load_env "${1:-}"
require_tools
TOML="$API_DIR/wrangler.toml"

fill_placeholder() {  # $1=佔位名 $2=實際 id
  local ph="__${1}_${ID_TAG}__"
  if grep -q "$ph" "$TOML"; then
    sed -i.bak "s/$ph/$2/" "$TOML" && rm -f "$TOML.bak"; ok "wrangler.toml 寫入 $1=$2"
  else
    grep -q "$2" "$TOML" || die "wrangler.toml 的 $1 已填但與實際 id ($2) 不符，請人工確認"
    info "wrangler.toml 的 $1 已填，略過"
  fi
}

# 1. D1
D1_ID="$(wrangler d1 list --json | jq -r --arg n "$D1_NAME" '.[] | select(.name==$n) | .uuid')"
if [[ -z "$D1_ID" ]]; then
  wrangler d1 create "$D1_NAME" >/dev/null
  D1_ID="$(wrangler d1 list --json | jq -r --arg n "$D1_NAME" '.[] | select(.name==$n) | .uuid')"
  ok "D1 $D1_NAME 已建立"
else info "D1 $D1_NAME 已存在，略過"; fi
fill_placeholder D1_ID "$D1_ID"

# 2. KV
KV_ID="$(wrangler kv namespace list | jq -r --arg n "$KV_NAME" '.[] | select(.title==$n) | .id')"
if [[ -z "$KV_ID" ]]; then
  wrangler kv namespace create "$KV_NAME" >/dev/null
  KV_ID="$(wrangler kv namespace list | jq -r --arg n "$KV_NAME" '.[] | select(.title==$n) | .id')"
  ok "KV $KV_NAME 已建立"
else info "KV $KV_NAME 已存在，略過"; fi
fill_placeholder KV_ID "$KV_ID"

# 3. R2
if wrangler r2 bucket list | grep -q "name:\s*$R2_NAME\b"; then info "R2 $R2_NAME 已存在，略過"
else wrangler r2 bucket create "$R2_NAME" >/dev/null && ok "R2 $R2_NAME 已建立"; fi

# 4. Queues
QLIST="$(wrangler queues list)"
for q in "${QUEUES[@]}"; do
  if grep -qw "$q" <<<"$QLIST"; then info "Queue $q 已存在，略過"
  else wrangler queues create "$q" >/dev/null && ok "Queue $q 已建立"; fi
done

# 5. Secrets（不覆蓋既有）
EXISTING="$(wr secret list --env "$ENV_NAME" 2>/dev/null | jq -r '.[].name' || true)"
put_secret() {  # $1=名稱 $2=值
  if grep -qx "$1" <<<"$EXISTING"; then info "secret $1 已存在，不覆蓋"
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

# 6. Pages 專案
PLIST="$(wrangler pages project list 2>/dev/null || true)"
for app in "${APPS[@]}"; do
  p="qcs-$app$SUFFIX"
  if grep -qw "$p" <<<"$PLIST"; then info "Pages $p 已存在，略過"
  else wrangler pages project create "$p" --production-branch main >/dev/null && ok "Pages $p 已建立"; fi
done

# 7. D1 migration（wrangler 自己記錄已套用者）
wr d1 migrations apply "$D1_NAME" --remote --env "$ENV_NAME"
ok "D1 migration 完成"

# 8. 首次部署 Worker（建立 DO class、Queue consumer、Cron、api 自訂網域）
wr deploy --env "$ENV_NAME"
ok "Worker $WORKER_NAME 已部署"

# 9. 語音包隨 apps/display 的 Pages 部署（ADR-026），這裡只做檢查
if [[ -f "$ROOT/assets/audio/manifest.json" ]]; then
  n="$(find "$ROOT/assets/audio" -type f | wc -l)"
  (( n < 15000 )) || die "語音包 $n 檔，加上前端檔可能超過 Pages 單站 20,000 檔上限"
  ok "語音包 $n 檔，將隨 display 部署"
else
  info "找不到 assets/audio/manifest.json，面板將只能用 speechSynthesis 備援"
fi

# 10. 預設品牌、smoke 門店、平台管理員
NOW="$(date +%s)000"
SQL="INSERT OR IGNORE INTO brands(id,name,created_at,updated_at) VALUES('brand_default','預設品牌',$NOW,$NOW);"
SQL+="INSERT OR IGNORE INTO stores(id,brand_id,code,name,created_at,updated_at) VALUES('store_smoke','brand_default','SMOKE0','smoke 測試門店',$NOW,$NOW);"
IFS=',' read -ra EMAILS <<<"$ADMIN_EMAILS"
for e in "${EMAILS[@]}"; do
  e="$(echo "$e" | xargs)"
  SQL+="INSERT OR IGNORE INTO users(id,role,display_name,email,created_at,updated_at) VALUES('pa_$(echo -n "$e" | sha1sum | cut -c1-12)','platform_admin','$e','$e',$NOW,$NOW);"
done
wr d1 execute "$D1_NAME" --remote --env "$ENV_NAME" --command "$SQL" >/dev/null
ok "預設品牌、smoke 門店、平台管理員已建立"

# 11. 網域與 Access
if [[ -n "${BOOTSTRAP_API_TOKEN:-}" ]]; then
  info "TODO：以 Pages API 綁 admin./store./staff./display./q.$HOST_BASE；以 Access API 建立 admin.$HOST_BASE 應用（端點未查證）"
else
  info "請依 docs/10-deploy-guide-for-owner.md 步驟 10、11 手動綁定網域與設定 Access"
fi

# 12. 完整部署
bash "$ROOT/scripts/deploy.sh" "$ENV_NAME"
ok "bootstrap 完成：https://admin.$HOST_BASE  https://store.$HOST_BASE  https://staff.$HOST_BASE  https://display.$HOST_BASE  https://q.$HOST_BASE"
