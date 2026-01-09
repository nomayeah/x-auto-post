# X OAuth認証セットアップガイド

X（旧Twitter）のOAuth認証を使用して投稿するためのセットアップ手順です。

## 必要なもの

### 1. X Developer Account（開発者アカウント）
- X Developer Portal（https://developer.twitter.com/）でアカウントを作成
- 開発者アカウントの申請と承認が必要（無料プランでも利用可能）

### 2. X APIアプリケーションの作成
1. X Developer Portalにログイン
2. 「Projects & Apps」→「Create App」をクリック
3. アプリ名を入力して作成

### 3. APIキーとトークンの取得
作成したアプリから以下を取得：
- **API Key**（Consumer Key）
- **API Secret**（Consumer Secret）
- **Access Token**
- **Access Token Secret**

### 4. 必要な権限（Permissions）
- **Read and Write**（投稿に必要）
- **Read and Write and Direct message**（DM送信も必要な場合）

## 実装に必要なパッケージ

### Node.jsの場合
```bash
npm install twitter-api-v2
# または
npm install oauth
```

### Pythonの場合
```bash
pip install tweepy
# または
pip install python-twitter
```

## 実装方法

### OAuth 1.0a（推奨）
- より安定している
- 画像投稿に対応

### OAuth 2.0
- より新しい方式
- 一部の機能が制限される可能性

## 設定ファイルへの追加

`config`シートに以下を追加：
- `X_API_KEY`（Consumer Key）
- `X_API_SECRET`（Consumer Secret）
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

## 注意事項

1. **APIキーの管理**
   - APIキーは機密情報のため、GitHub Secretsや環境変数で管理
   - スプレッドシートに保存する場合は、適切な権限設定が必要

2. **レート制限**
   - X APIにはレート制限がある
   - 投稿頻度に注意

3. **コスト**
   - 無料プラン: 月1,500投稿まで
   - 有料プラン: より多くの投稿が可能

4. **画像投稿**
   - OAuth 1.0aを使用する場合、画像のアップロードには追加のAPI呼び出しが必要

## 次のステップ

1. X Developer Accountを取得
2. APIアプリケーションを作成
3. APIキーとトークンを取得
4. 実装を追加（Node.jsまたはPython）




