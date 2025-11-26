const { TwitterApi } = require('twitter-api-v2');
const http = require('http');
const url = require('url');
const { exec } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

(async () => {
    console.log('\n=== X (Twitter) アカウント認証ツール ===');
    console.log('Developer Portalで取得した API Key と API Key Secret を入力してください。');
    console.log('※3回実行しますが、API Key / Secret は3回とも「同じもの」を入力してください。');
    console.log('---------------------------------------------------');

    const apiKey = await ask('API Key: ');
    const apiSecret = await ask('API Key Secret: ');

    if (!apiKey || !apiSecret) {
        console.error('❌ API Key または Secret が入力されていません。');
        process.exit(1);
    }

    // クライアント初期化
    const client = new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
    });

    // 認証リンク生成
    const callbackUrl = 'http://127.0.0.1:3000/callback';
    let authLink;
    try {
        authLink = await client.generateAuthLink(callbackUrl, { linkMode: 'authorize' });
    } catch (e) {
        console.error('\n❌ 認証リンクの生成に失敗しました。');
        console.error('考えられる原因:');
        console.error('1. API Key / Secret が間違っている');
        console.error('2. Developer Portalで「Callback URI」の設定をしていない');
        console.error('   → 設定画面で http://127.0.0.1:3000/callback を追加してください');
        console.error('3. App permissions が「Read and Write」になっていない');
        console.error('\nエラー詳細:', e.message);
        process.exit(1);
    }

    console.log('\n=== 認証手順 ===');
    console.log('1. ブラウザが開き、Xの認証画面が表示されます。');
    console.log('2. 「連携アプリを認証」ボタンを押してください。');
    console.log('   ※意図したアカウントでログインしているか確認してください！');
    console.log('3. 認証が成功すると、自動的にこの画面に戻ります。');
    console.log('---------------------------------------------------');
    console.log('認証URL:', authLink.url);
    console.log('---------------------------------------------------\n');
    console.log('サーバーを起動して待機中... (Ctrl+C で中止)');

    // ブラウザを開く
    const startCommand = process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open';
    exec(`${startCommand} "${authLink.url}"`);

    // コールバックサーバー
    const server = http.createServer(async (req, res) => {
        const reqUrl = url.parse(req.url, true);

        if (reqUrl.pathname === '/callback') {
            const { oauth_token, oauth_verifier } = reqUrl.query;

            if (oauth_token && oauth_verifier) {
                try {
                    // アクセストークン取得
                    const { client: loggedClient, accessToken, accessSecret, screenName, userId } = await client.login(oauth_verifier);

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>認証成功！</h1><p>ターミナルに戻ってトークンを確認してください。</p><script>window.close();</script>');

                    console.log('\n✅ 認証成功！以下の情報を必ずメモしてください。');
                    console.log('===================================================');
                    console.log(`アカウント名: @${screenName}`);
                    console.log(`Access Token:        ${accessToken}`);
                    console.log(`Access Token Secret: ${accessSecret}`);
                    console.log('===================================================');
                    console.log('\nこの情報を控えたら、スクリプトを終了して次のアカウントの作業に移ってください。');
                    
                    server.close();
                    process.exit(0);
                } catch (e) {
                    res.writeHead(500);
                    res.end('Error retrieving access token');
                    console.error('\n❌ トークン交換エラー:', e.message);
                    server.close();
                    process.exit(1);
                }
            }
        }
    });

    server.listen(3000);
})();

