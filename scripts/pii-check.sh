#!/usr/bin/env bash
# 5.2 個資抽查：對 D1 跑 scripts/pii-check.sql，任一項不為 0 即失敗。只讀。
# 用法：bash scripts/pii-check.sh            （正式環境，憑證只讀 ~/.config/queue-call-system/cf.env）
#       bash scripts/pii-check.sh --local [--persist-to <dir>]   （本機 wrangler dev 的 D1）
# DO 內「關店後原文清空」由 Vitest T6／m5.test.ts 驗證；正式環境另依 docs/10 抽查（關店 30 分鐘後叫號面板看不到姓名）。
source "$(dirname "$0")/lib.sh"
SQL="$ROOT/scripts/pii-check.sql"
if [[ "${1:-}" == "--local" ]]; then
  shift
  out="$(cd "$API_DIR" && ./node_modules/.bin/wrangler d1 execute qcs-db-local --local --env local "$@" --json --file "$SQL" 2>/dev/null)" \
    || die "本機 D1 查詢失敗（先跑 node apps/api/scripts/seed-local.mjs）"
else
  load_env production
  require_tools
  out="$(wr d1 execute "$D1_NAME" --remote --env "$ENV_NAME" --json --file "$SQL")" || die "D1 查詢失敗"
fi
bad=0
while IFS=$'\t' read -r item n; do
  if [[ "$n" == "0" ]]; then ok "$item：0"; else printf '\033[31m✘ %s：%s\033[0m\n' "$item" "$n"; bad=1; fi
done < <(jq -r '.[0].results[0] | to_entries[] | [.key, (.value|tostring)] | @tsv' <<<"$out")
(( bad == 0 )) || die "個資抽查未通過"
ok "個資抽查通過"
