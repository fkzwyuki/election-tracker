# 本番公開セットアップ手順書（初心者向けステップバイステップガイド）

この資料は、作成した「地方選 開票速報トラッカー」を**無料・安全・スマホ閲覧可能**な状態でインターネット公開し、開票当日に自動更新されるようにするための手順書です。

上から順番に進めてください。途中でつまずいたら、その画面のスクリーンショットやエラー文をそのままチャットに貼って聞いてください！

---

## 全体の仕組み（使うサービスはすべて無料枠）

1. **GitHub（コードとデータの保管・自動更新の実行）**
   * あなたのコードを非公開（Private）で保管し、開票データを定期取得します。
2. **Cloudflare Pages（スマホで見るWebページの公開）**
   * GitHubの `docs/` フォルダをそのままWebサイトとして公開します。
   * **転送量（アクセス数）が無制限で無料**なので、URLが広く共有されても課金されません。
3. **Google Apps Script / GAS（10〜15分おきの目覚まし時計）**
   * 開票時間帯（20:00〜翌2:59）だけ、10〜15分おきにGitHubの更新処理を呼び出します。

---

## ステップ1：GitHubにリポジトリを作ってアップロード（push）する

### 1-1. GitHubで新しいリポジトリを作成
1. [GitHub](https://github.com/) にログインします。
2. 右上の **`+`** マーク → **`New repository`** をクリックします。
3. 以下のように入力します：
   * **Repository name**: `election-tracker`（好きな名前でOK）
   * **Visibility**: **`Private`**（非公開）を選択
   * ※ `Add a README file` などのチェックボックスは**すべてオフのまま**にします。
4. 緑色の **`Create repository`** ボタンを押します。
5. 作成された画面に表示される `https://github.com/あなたのID/election-tracker.git` をコピーしておきます。

### 1-2. パソコンからGitHubへアップロード（push）
PowerShell（またはターミナル）を開き、以下の3行を順番に実行します（2行目のURLは自分のものに置き換えてください）。

```powershell
cd C:\Users\onsok\.gemini\antigravity\scratch\election-tracker
git remote add origin https://github.com/あなたのID/election-tracker.git
git push -u origin main
```

GitHubのページを再読み込みして、ファイル一覧が表示されれば **ステップ1完了** です！

### 1-3. GitHub Actionsの書き込み権限を確認（重要）
GitHub Actionsが自動で `latest.json` を書き換えて保存できるように確認します。
1. GitHubリポジトリの上部タブ **`Settings`** をクリック。
2. 左メニューの **`Actions`** → **`General`** をクリック。
3. 下の方にある **Workflow permissions** で、**`Read and write permissions`** にチェックが入っていることを確認（入っていなければ変更して **`Save`**）。

---

## ステップ2：Cloudflare Pages でWebページを公開する

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) にログインします（アカウントがない場合は無料で作成）。
2. 左メニューの **`Workers & Pages`** をクリックし、右上の青い **`Create application`** を押します。
3. 画面一番下にある **`Continue to Pages`** をクリックします（※ 上の Workers ではなく **Pages** を選ぶことで、アカウント名が入らない綺麗な `*.pages.dev` URL になります）。
4. **`Connect to Git`** でGitHubアカウントと連携し、ステップ1で作った **`election-tracker`** リポジトリを選択して **`Begin setup`** を押します。
5. ビルド設定の画面で、以下のように入力します：
   * **Project name**: 好きなURL用の名前（例: `election-tracker-dpfp` → `https://election-tracker-dpfp.pages.dev` になります）
   * **Production branch**: `main`
   * **Framework preset**: `None`（なし）
   * **Build command**: **空欄のまま**
   * **Build output directory**: **`docs`**（重要！半角小文字で `docs`）
6. **`Save and Deploy`** をクリックします。
7. 30秒〜1分ほど待つと完了し、発行された `https://〇〇.pages.dev` をスマホやPCで開いて表示されれば **ステップ2完了** です！

> **ポイント**: 今後、GitHubの `docs/data/latest.json` が更新されると、Cloudflare Pages が自動で検知して数十秒以内にWebページを最新化してくれます。

---

## ステップ3：GAS（Google Apps Script）から定期更新できるようにする

GitHub Actions標準のタイマーは遅延しやすいため、GASから10〜15分おきに呼び出します。

### 3-1. GitHubで専用パスワード（トークン）を発行する
GASがGitHub Actionsを起動するための鍵（Fine-grained PAT）を作ります。
1. GitHub右上の自分のアイコン → **`Settings`**（リポジトリではなくアカウント全体の設定）をクリック。
2. 左メニューの一番下 **`Developer settings`** → **`Personal access tokens`** → **`Fine-grained tokens`** をクリック。
3. **`Generate new token`** をクリックし、以下を設定します：
   * **Token name**: `election-tracker-gas`
   * **Expiration**: `90 days` など（2027年統一地方選のときは期限を確認）
   * **Repository access**: **`Only select repositories`** を選び、**`election-tracker`** を選択
   * **Permissions → Repository permissions**:
     * **`Actions`** を **`Read and write`** に変更
     * （他の項目はそのままでOK）
4. 一番下の **`Generate token`** を押します。
5. 表示された `github_pat_...` で始まる文字列を**必ずコピーして控えます**（画面を閉じると二度と見られません）。

### 3-2. GASプロジェクトを作成してコードを貼る
1. [Google Apps Script](https://script.google.com/) を開き、左上の **`新しいプロジェクト`** をクリック。
2. プロジェクト名（左上「無題のプロジェクト」）を `選挙開票トラッカー自動更新` などに変更。
3. エディタに最初から入っている `function myFunction() {}` をすべて消去し、このフォルダ内の **`gas/trigger.gs`** の中身をすべてコピー＆ペーストして保存（`Ctrl + S`）。

### 3-3. GASにトークン等の設定値（スクリプトプロパティ）を登録する
1. GAS画面の左メニューにある歯車アイコン **`プロジェクトの設定`** をクリック。
2. 一番下の **スクリプト プロパティ** で **`スクリプト プロパティを追加`** を押し、以下の3つを登録して **`スクリプト プロパティを保存`** を押します：

| プロパティ | 値（例） |
| :--- | :--- |
| `GITHUB_TOKEN` | 3-1でコピーした `github_pat_...` |
| `GITHUB_OWNER` | あなたのGitHubユーザー名（例: `fkzwyuki`） |
| `GITHUB_REPO` | `election-tracker` |

### 3-4. 手動テスト実行（ちゃんと動くか確認）
1. 左メニューの **`エディタ`**（`< >` アイコン）に戻ります。
2. 上部のツールバーで、実行する関数を **`manualTriggerNow`** に切り替えて **`実行`** を押します。
   * 初回のみ「Google hasn't verified this app」と出ます → 左下の **`Advanced`** → **`Go to 選挙開票トラッカー自動更新 (unsafe)`** → **`Allow`（許可）** をクリック。
3. 下部の実行ログに **`Status: 204`** と出れば成功です！
4. GitHubリポジトリの **`Actions`** タブを開き、`Update Election Results` が実行されて緑色のチェックが付けば **連携成功** です！

### 3-5. 10分〜15分おきの自動タイマー（トリガー）を設定する
1. GAS画面の左メニューにある時計アイコン **`トリガー`** をクリック。
2. 右下の **`トリガーを追加`** を押し、以下のように設定します：
   * **実行する関数を選択**: `triggerElectionUpdate`
   * **イベントのソースを選択**: `時間主導型`
   * **時間ベースのトリガーのタイプを選択**: `分ベースのタイマー`
   * **時間の間隔を選択（分）**: **`10分おき`** または **`15分おき`**
3. **`保存`** をクリックすれば **ステップ3完了** です！

> **安心ポイント（トリガーは付けっぱなしでOK！）**:
> `triggerElectionUpdate` は公開サイトの `latest.json` を自動参照し、**「投開票日の 20:00〜翌2:59」かつ「まだ確定（`final`）していない選挙があるとき」だけ** GitHub Actions を起動します。選挙のない日（平日・週末問わず）や全選挙区が確定した後は自動でスキップするため、トリガーを止め忘れても無駄な実行は起きません（離島の平日投票日なども自動対応します）。

---

## ステップ4：開票当日（2026/11/22 鳥取市議選）のチェック

1. **20:00〜21:00頃**、鳥取市選管のページ（`https://www.city.tottori.lg.jp/page/42131.html`）に「開票速報」へのリンクが公開されます。
2. 公開後10〜15分ほど待って（またはGASの `manualTriggerNow` を手動実行して）、スマホの公開ページを確認します。
3. **もし自動で拾えなかった場合（PDF形式・別サイトの速報だった場合など）**：
   * 公開された速報ページのURLをチャットに貼って「鳥取の速報URLがこれでした」と教えてください。
   * すぐに抽出ルールを調整して更新します！

---

## ステップ5：選挙が終わった後 ＆ 次回選挙の追加方法

* **GASの操作は不要です**（トリガーは付けっぱなしのままで自動休眠します）。
* 次回の選挙（や2027年4月の統一地方選）を追加するときは、**`config/elections.json`** を編集してGitHubへpushするだけです：
  1. 終わった選挙を `"active": false` に変更し、新しい選挙を追加する
  2. 手元から以下を実行して反映する（GitHub Actionsが `latest.json` を自動更新しているため、push前に `git pull --rebase` を実行します）：
     ```powershell
     cd C:\Users\onsok\.gemini\antigravity\scratch\election-tracker
     git pull --rebase
     git push
     ```
  3. `config/elections.json` が push されると GitHub Actions が自動で1回走り、公開サイトの `latest.json` と GAS の監視対象日が自動で最新化されます。
