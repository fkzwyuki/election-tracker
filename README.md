# 地方選 開票速報トラッカー（プロトタイプ）

自治体選管HPの開票速報を低コスト（ほぼ0円）で定期収集し、スマホで見やすい静的まとめページ（Cloudflare Pages / GitHub Pages）に配信するための仕掛けです。

## 構成

- `config/elections.json`: 選挙イベント・選挙区・注目候補者・抽出設定マスタ
- `scripts/collect.mjs`: Node.js 標準モジュールのみの収集・解析スクリプト（LLMコスト0円・差分検知付き）
- `docs/`: そのまま Cloudflare Pages / GitHub Pages で公開できる静的サイト（`noindex` 設定済み）
- `.github/workflows/update.yml`: GAS からの `workflow_dispatch` で起動する自動更新ワークフロー
- `gas/trigger.gs`: 開票時間帯（20:00〜翌2:59）のみ 10〜15分おきに Actions を叩く GAS スクリプト

## ローカル動作確認

```bash
# デモデータ生成（松戸市議選11/15確定サンプル ＋ 鳥取市議選11/22開票前）
node scripts/collect.mjs --demo

# 簡易サーバーでスマホ画面を確認
npx --yes serve docs
```

## 明日（2026/11/22）鳥取市議会議員選挙での本番テスト手順

1. このフォルダを GitHub リポジトリ（非公開でも可）に push
2. **Cloudflare Pages** にリポジトリを接続し、ビルドコマンド空欄・出力ディレクトリを `docs` に設定して公開（転送量無制限・無料）
3. `gas/trigger.gs` を GAS に貼り付け、10分または15分おきの時間トリガーを設定
4. 当日 20:00〜21:00 頃、鳥取市選管の開票速報ページURLが公開されたら：
   - 自動探索（`portal_url` からのリンク検出）で拾えるか確認
   - 拾えない場合やPDF形式だった場合は、`config/elections.json` の `results_url` を直接指定して更新

## 2027年4月 統一地方選に向けた拡張

- `config/elections.json` の `events`（`2027-04-unified-1` / `2027-04-unified-2`）に選挙区を追加するだけで全国一覧・自治体検索に対応します。
- 事前準備として `https://new-kokumin.jp/election-local` から候補者リストをAIで抽出し、`elections.json` に追記する運用が可能です。
