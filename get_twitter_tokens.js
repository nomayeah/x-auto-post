const { TwitterApi } = require('twitter-api-v2');
const readline = require('readline');
const { exec } = require('child_process');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

(async () => {
    console.log('\n=== X (Twitter) アカウント認証ツール (デバッグ版) ===');
    console.log('Developer Portalで取得した API Key と API Key Secret を入力してください。');
    console.log('---------------------------------------------------');

    const apiKey = await ask('API Key: ');
    const apiSecret = await ask('API Key Secret: ');

    if (!apiKey || !apiSecret) {
        console.error('❌ API Key または Secret が入力されていません。');
        process.exit(1);
    }

    const client = new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
    });

    const callbackUrl = 'http://127.0.0.1:3000/callback';
    let authLink;
    try {
        authLink = await client.generateAuthLink(callbackUrl, { linkMode: 'authorize' });
        console.log('\nDEBUG: Auth Link generated successfully.');
        console.log('Token:', authLink.oauth_token);
        console.log('Secret:', authLink.oauth_token_secret);
    } catch (e) {
        console.error('\n❌ 認証リンク生成失敗');
        if (e.data) {
            console.error('API Error Data:', JSON.stringify(e.data, null, 2));
        } else {
            console.error('Error:', e);
        }
        process.exit(1);
    }

    console.log('\n=== 認証手順 ===');
    console.log('1. 自動的にブラウザが開きます');
    console.log(`   URL: ${authLink.url}`);
    console.log('---------------------------------------------------');

    const startCommand = process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open';
    exec(`${startCommand} "${authLink.url}"`);

    const verifier = await ask('\nコピーした oauth_verifier を貼り付けてEnter: ');

    if (!verifier) {
        console.error('❌ Verifierが入力されませんでした。');
        process.exit(1);
    }

    try {
        // 詳細なログ出力のためにloginメソッドの中身を分解して実行
        // v1.login() は内部で getAccessToken を呼んでいる
        console.log('\nDEBUG: トークン交換を開始します...');
        console.log(`Oauth Token: ${authLink.oauth_token}`);
        console.log(`Verifier: ${verifier}`);

        // 一時的なクライアントを作成して認証
        const tempClient = new TwitterApi({
            appKey: apiKey,
            appSecret: apiSecret,
            accessToken: authLink.oauth_token,
            accessSecret: authLink.oauth_token_secret,
        });

        const { accessToken, accessSecret, screenName, userId } = await tempClient.login(verifier);

        console.log('\n✅ 認証成功！以下の情報をGitHub Secretsに登録してください。');
        console.log('===================================================');
        console.log(`アカウント名: @${screenName} (ID: ${userId})`);
        console.log(`Access Token:        ${accessToken}`);
        console.log(`Access Token Secret: ${accessSecret}`);
        console.log('===================================================');
        
        process.exit(0);
    } catch (e) {
        console.error('\n❌ トークン交換エラー詳細:');
        console.error('---------------------------------------------------');
        console.error('Message:', e.message);
        console.error('Code:', e.code);
        if (e.data) {
            console.error('API Response Data:', JSON.stringify(e.data, null, 2));
        }
        if (e.rateLimit) {
            console.error('Rate Limit Info:', e.rateLimit);
        }
        console.error('---------------------------------------------------');
        process.exit(1);
    }
})();
