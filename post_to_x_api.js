/**
 * X APIを使用した自動投稿スクリプト
 * 
 * 機能:
 * 1. スプレッドシートから投稿データを取得
 * 2. アカウント（A/B/Test）を切り替えて投稿
 * 3. 画像をDriveからダウンロードして添付
 * 4. 投稿結果をスプレッドシートに書き込み
 */

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

// === 設定 ===
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1O9pWwkMvVBQOngRSLumogXFktAHmAmur65t5Kwpxe4Y';
const SHEET_NAME = 'posts';

// === 認証情報 ===
// 共通のAPI Key
const APP_KEY = process.env.X_API_KEY;
const APP_SECRET = process.env.X_API_SECRET;

// アカウントごとのトークン
const TOKENS = {
    'A': {
        token: process.env.X_ACCESS_TOKEN_A,
        secret: process.env.X_ACCESS_SECRET_A
    },
    'B': {
        token: process.env.X_ACCESS_TOKEN_B,
        secret: process.env.X_ACCESS_SECRET_B
    },
    'TEST': {
        token: process.env.X_ACCESS_TOKEN_TEST,
        secret: process.env.X_ACCESS_SECRET_TEST
    }
};

// === ヘルパー関数 ===

// デバッグ用: 環境変数の状態チェック（値そのものは出さない）
function checkEnvVars() {
    console.log('\n🔍 環境変数チェック:');
    console.log(`X_API_KEY: ${APP_KEY ? '✅ OK (' + APP_KEY.length + ' chars)' : '❌ Missing'}`);
    console.log(`X_API_SECRET: ${APP_SECRET ? '✅ OK (' + APP_SECRET.length + ' chars)' : '❌ Missing'}`);
    
    Object.keys(TOKENS).forEach(key => {
        const t = TOKENS[key];
        console.log(`Account ${key}:`);
        console.log(`  Token: ${t.token ? '✅ OK (' + t.token.length + ' chars)' : '⚠️ Missing'}`);
        console.log(`  Secret: ${t.secret ? '✅ OK (' + t.secret.length + ' chars)' : '⚠️ Missing'}`);
    });
    console.log('-------------------');
}

// Google認証クライアント取得
function getGoogleAuth() {
    const serviceAccountKeyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json';
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (serviceAccountJson) {
        // 環境変数からJSONを直接読み込む（GitHub Actions用）
        try {
            const credentials = JSON.parse(serviceAccountJson);
            return new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
            });
        } catch (e) {
            throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSONのパースに失敗: ${e.message}`);
        }
    } else if (fs.existsSync(serviceAccountKeyPath)) {
        // ファイルから読み込む（ローカル用）
        return new google.auth.GoogleAuth({
            keyFile: serviceAccountKeyPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
        });
    }
    throw new Error('Google Service Accountの設定が見つかりません');
}

// スプレッドシート取得 (CSV経由で軽量化)
async function getSpreadsheetData() {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${SHEET_NAME}`;
    try {
        const response = await axios.get(csvUrl);
        return parseCSV(response.data);
    } catch (e) {
        console.error('Spreadsheet download failed:', e.message);
        throw e;
    }
}

// CSVパーサー
function parseCSV(csvText) {
    const rows = [];
    let currentRow = [];
    let currentValue = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        if (char === '"') {
            if (inQuotes && csvText[i + 1] === '"') {
                currentValue += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            currentRow.push(currentValue);
            currentValue = '';
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
            if (char === '\r' && csvText[i + 1] === '\n') i++;
            currentRow.push(currentValue);
            if (currentRow.some(v => v)) rows.push(currentRow);
            currentRow = [];
            currentValue = '';
        } else {
            currentValue += char;
        }
    }
    if (currentValue || currentRow.length) {
        currentRow.push(currentValue);
        rows.push(currentRow);
    }
    return rows;
}

// Google Driveから画像ダウンロード
async function downloadImage(fileIdOrUrl) {
    if (!fileIdOrUrl) return null;
    
    // ID抽出
    let fileId = fileIdOrUrl;
    const match = fileIdOrUrl.match(/[-\w]{25,}/);
    if (match) fileId = match[0];

    console.log(`📥 画像ダウンロード: ${fileId}`);
    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
    
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const tempPath = path.join('/tmp', `${fileId}.jpg`);
        await writeFile(tempPath, response.data);
        return tempPath;
    } catch (e) {
        console.error(`❌ 画像ダウンロード失敗: ${e.message}`);
        return null;
    }
}

// スプレッドシート更新
async function updateSheetStatus(rowIndex, statusColumnIndex, newStatus) {
    try {
        const auth = getGoogleAuth();
        const sheets = google.sheets({ version: 'v4', auth });
        
        // カラム番号をA1記法に変換 (0 -> A, 4 -> E)
        const colLetter = String.fromCharCode(65 + statusColumnIndex);
        const range = `${SHEET_NAME}!${colLetter}${rowIndex + 1}`; // rowIndexは0始まり、シートは1始まり

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: range,
            valueInputOption: 'RAW',
            resource: { values: [[newStatus]] }
        });
        console.log(`✅ シート更新: 行${rowIndex + 1} -> ${newStatus}`);
    } catch (e) {
        console.error(`❌ シート更新失敗: ${e.message}`);
    }
}

// Xに投稿
async function postTweet(accountKey, text, imagePath) {
    const token = TOKENS[accountKey];
    if (!token || !token.token) throw new Error(`アカウント設定が見つかりません: ${accountKey}`);

    // 詳細エラーハンドリングを追加
    try {
        const client = new TwitterApi({
            appKey: APP_KEY,
            appSecret: APP_SECRET,
            accessToken: token.token,
            accessSecret: token.secret,
        });

        let mediaId = undefined;
        if (imagePath) {
            console.log('📤 画像アップロード中...');
            // v1 API for media upload
            mediaId = await client.v1.uploadMedia(imagePath);
        }

        console.log(`📝 投稿中 (@${accountKey}): ${text.substring(0, 20)}...`);
        
        // v2 API for tweet
        await client.v2.tweet({
            text: text,
            media: mediaId ? { media_ids: [mediaId] } : undefined
        });
    } catch (e) {
        console.error(`❌ APIエラー詳細:`);
        console.error(`   Message: ${e.message}`);
        if (e.data) {
            console.error(`   Data: ${JSON.stringify(e.data)}`);
        }
        if (e.code) {
            console.error(`   Code: ${e.code}`);
        }
        throw e; // 上位に投げる
    }
}

// === メイン処理 ===
async function main() {
    const mode = process.argv[2] || 'check'; // check, test, force
    console.log(`🚀 開始: モード=${mode}`);
    
    checkEnvVars(); // 最初にチェック

    // 1. データ取得
    const rows = await getSpreadsheetData();
    if (rows.length < 2) {
        console.log('データがありません');
        return;
    }

    // ヘッダー解析
    const headers = rows[0];
    const colMap = {
        date: headers.indexOf('日付'),
        time: headers.indexOf('時間'),
        account: headers.indexOf('アカウント'),
        text: headers.indexOf('テキスト'),
        image: headers.indexOf('画像'),
        status: headers.indexOf('ステータス')
    };

    if (colMap.date === -1 || colMap.status === -1) {
        throw new Error('必須カラム（日付, ステータス等）が見つかりません');
    }

    const now = new Date();

    // 2. 行ごとの処理
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const dateStr = row[colMap.date];
        const timeStr = row[colMap.time];
        const account = row[colMap.account] || 'A'; // デフォルトA
        const text = row[colMap.text];
        const image = row[colMap.image];
        const status = row[colMap.status] || '';

        // 日時パース
        const postTime = new Date(`${dateStr.replace(/\//g, '-')} ${timeStr}`);
        const isPast = postTime <= now;

        let shouldPost = false;
        let targetAccount = account;
        let newStatus = '完了';

        if (mode === 'check') {
            // 定期実行: 承認済み かつ 時間経過 かつ 未完了
            if (status === '承認済み' && isPast) {
                shouldPost = true;
                // 本番アカウント (A or B)
                targetAccount = (account === 'B' || account === 'ロバミミ') ? 'B' : 'A';
            }
        } else if (mode === 'test') {
            // テスト実行: 確認待ち のみ
            if (status === '確認待ち') {
                shouldPost = true;
                targetAccount = 'TEST';
                // テスト後は承認待ちにする？
                // newStatus = '承認待ち'; 
                newStatus = '確認済み'; 
            }
        } else if (mode === 'force' && process.env.TARGET_ROW) {
            // 強制実行: 行指定
            if (i + 1 == process.env.TARGET_ROW) {
                shouldPost = true;
                // 指定されたアカウントで
                targetAccount = (account === 'B' || account === 'ロバミミ') ? 'B' : 'A';
            }
        }

        if (shouldPost) {
            console.log(`\n🎯 対象行: ${i + 1} (Account: ${targetAccount})`);
            
            try {
                // 画像DL
                let imagePath = null;
                if (image) {
                    imagePath = await downloadImage(image);
                }

                // 投稿
                await postTweet(targetAccount, text, imagePath);
                console.log('✅ 投稿成功');

                // ステータス更新
                await updateSheetStatus(i, colMap.status, newStatus);

                // 後始末
                if (imagePath) await unlink(imagePath);

            } catch (e) {
                console.error(`❌ 処理失敗: ${e.message}`);
                // エラーをシートに書き込む？
            }
        }
    }
    console.log('🏁 完了');
}

main().catch(console.error);
