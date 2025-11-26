# X自動投稿システム (API版 v2.0)

Googleスプレッドシートで管理された内容を、X (旧Twitter) に自動投稿するシステムです。
公式APIを使用しているため、アカウント凍結のリスクがなく安全に運用できます。

## ✨ 主な機能
- **複数アカウント対応**: 「公式アカウント」「採用アカウント」などを1つのシートで管理
- **画像付き投稿**: Google DriveのURLを貼るだけで画像付きツイートが可能
- **承認フロー**: 「確認待ち」→「承認済み」→「投稿完了」のステータス管理
- **テスト投稿機能**: 本番前にテスト用アカウントで見た目を確認可能

## 🚀 運用マニュアル（日常業務）

### 1. スプレッドシートに入力する
`posts` シートに以下の情報を入力します。

| 列名 | 入力内容 | 例 |
| :--- | :--- | :--- |
| **日付** | 投稿したい日付 | `2025/11/27` |
| **時間** | 投稿したい時間 | `10:00` |
| **アカウント** | 投稿するアカウント名 | `A` (公式) / `B` (採用) |
| **テキスト** | 投稿本文 | `新機能のお知らせです...` |
| **画像** | Google DriveのURL | `https://drive.google.com/...` |
| **ステータス** | 進行状態 | `確認待ち` / `承認済み` |

### 2. テスト投稿を行う（推奨）
1. スプレッドシートのステータスを **「確認待ち」** にします。
2. GitHubの `Actions` タブを開きます。
3. **「Manual Test Post」** を選択し、**「Run workflow」** ボタンを押します。
4. テスト用アカウントに投稿されるので、スマホ等で表示崩れがないか確認します。

### 3. 本番投稿を予約する
1. テストで問題なければ、ステータスを **「承認済み」** に変更します。
2. あとは放置でOKです。設定した日時が来ると自動的に投稿され、ステータスが **「完了」** に変わります。

### 4. 今すぐ本番投稿したい場合（イレギュラー）
1. ステータスを **「承認済み」** にします。
2. 時間を「現在時刻より少し前」に設定します。
3. GitHub Actionsで **「Scheduled Auto Post」** を選択し、**「Run workflow」** を押すと即座に実行されます。

---

## ⚙️ 開発者・管理者向け設定ガイド

### 必要なもの
- X Developer Account (Freeプラン)
- Google Cloud Service Account (スプレッドシート・Drive権限)

### GitHub Secrets設定
以下のキーを `Settings > Secrets and variables > Actions` に設定してください。

| Secret名 | 内容 |
| :--- | :--- |
| `X_API_KEY` | API Key (Consumer Key) |
| `X_API_SECRET` | API Key Secret (Consumer Secret) |
| `X_ACCESS_TOKEN_TEST` | テスト垢のAccess Token |
| `X_ACCESS_SECRET_TEST` | テスト垢のAccess Token Secret |
| `X_ACCESS_TOKEN_A` | 本番垢AのAccess Token |
| `X_ACCESS_SECRET_A` | 本番垢AのAccess Token Secret |
| `X_ACCESS_TOKEN_B` | 本番垢BのAccess Token |
| `X_ACCESS_SECRET_B` | 本番垢BのAccess Token Secret |
| `SPREADSHEET_ID` | スプレッドシートのID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウントキーの中身全体 |

### トークンの取得方法
リポジトリ内のツールを使って簡単に取得できます。

```bash
# 1. 依存ライブラリのインストール
npm install

# 2. 取得ツールの起動
npm run get-tokens
```

### スプレッドシートの仕様
`posts` シートの1行目は以下のヘッダー名である必要があります（順不同）。
- 日付
- 時間
- アカウント
- テキスト
- 画像
- ステータス

---

## ⚠️ 注意事項
- **API制限**: Freeプランの上限は **1日50ツイート/アカウント** です。これを超えないように注意してください。
- **画像権限**: Google Driveの画像は、サービスアカウントが閲覧できる権限（共有設定）が必要です。
