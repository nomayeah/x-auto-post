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
const CONTROL_SHEET_NAME = process.env.CONTROL_SHEET_NAME || '設定'; // Bot停止フラグ用シート
const CONTROL_CELL = 'A1'; // 停止フラグのセル位置

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

    let credentials = null;
    let serviceAccountEmail = null;

    if (serviceAccountJson) {
        // 環境変数からJSONを直接読み込む（GitHub Actions用）
        try {
            credentials = JSON.parse(serviceAccountJson);
            serviceAccountEmail = credentials.client_email;
            console.log(`\n🔐 Service Account認証情報:`);
            console.log(`   Email: ${serviceAccountEmail}`);
            console.log(`   Project ID: ${credentials.project_id || 'N/A'}`);
            console.log(`   Type: ${credentials.type || 'N/A'}`);
        } catch (e) {
            throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSONのパースに失敗: ${e.message}`);
        }
    } else if (fs.existsSync(serviceAccountKeyPath)) {
        // ファイルから読み込む（ローカル用）
        try {
            const keyFile = JSON.parse(fs.readFileSync(serviceAccountKeyPath, 'utf8'));
            serviceAccountEmail = keyFile.client_email;
            console.log(`\n🔐 Service Account認証情報 (ファイルから):`);
            console.log(`   Email: ${serviceAccountEmail}`);
            console.log(`   Project ID: ${keyFile.project_id || 'N/A'}`);
        } catch (e) {
            console.error(`⚠️ キーファイルの読み込みエラー: ${e.message}`);
        }
    } else {
        throw new Error('Google Service Accountの設定が見つかりません');
    }

    const auth = credentials 
        ? new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
        })
        : new google.auth.GoogleAuth({
            keyFile: serviceAccountKeyPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly']
        });

    // Service Accountのメールアドレスを返すためにauthオブジェクトに追加
    auth.serviceAccountEmail = serviceAccountEmail;
    
    return auth;
}

// Bot停止フラグをチェック
async function checkBotEnabled() {
    try {
        const auth = getGoogleAuth();
        const authClient = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        // 設定シートから停止フラグを取得
        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: `${CONTROL_SHEET_NAME}!${CONTROL_CELL}`,
            });
            
            const value = response.data.values?.[0]?.[0] || '';
            const isStopped = value.toString().trim().toLowerCase() === '停止' || 
                            value.toString().trim().toLowerCase() === 'stop' ||
                            value.toString().trim().toLowerCase() === 'false';
            
            if (isStopped) {
                console.log(`\n⏸️  Bot停止フラグが検出されました: ${value}`);
                console.log(`   スプレッドシートの「${CONTROL_SHEET_NAME}」シートの「${CONTROL_CELL}」セルに「停止」と書かれています。`);
                console.log(`   実行をスキップします。再開するには、セルの値を削除するか「実行中」に変更してください。`);
                return false;
            }
            
            return true;
        } catch (e) {
            // 設定シートが存在しない場合は、停止フラグなしとして扱う
            if (e.code === 400 || (e.response && e.response.status === 400)) {
                console.log(`\nℹ️  設定シート「${CONTROL_SHEET_NAME}」が見つかりません。通常通り実行します。`);
                return true;
            }
            throw e;
        }
    } catch (e) {
        console.error(`\n⚠️  停止フラグチェック中にエラー: ${e.message}`);
        console.error(`   エラーを無視して実行を続けます。`);
        return true; // エラー時は実行を続ける
    }
}

// スプレッドシート取得 (Google Sheets API使用)
async function getSpreadsheetData() {
    try {
        console.log(`\n📊 スプレッドシート取得開始:`);
        console.log(`   Spreadsheet ID: ${SPREADSHEET_ID}`);
        console.log(`   Sheet Name: ${SHEET_NAME}`);
        
        const auth = getGoogleAuth();
        const serviceAccountEmail = auth.serviceAccountEmail;
        
        if (serviceAccountEmail) {
            console.log(`   Service Account: ${serviceAccountEmail}`);
            console.log(`   ⚠️ このメールアドレスがスプレッドシートに共有されているか確認してください！`);
        }
        
        // 認証情報を取得
        const authClient = await auth.getClient();
        console.log(`   ✅ 認証成功`);
        
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        
        console.log(`   📥 データ取得中...`);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:Z`, // 十分な範囲を取得
        });
        
        const rows = response.data.values || [];
        console.log(`   ✅ 取得成功: ${rows.length}行`);
        
        return rows;
    } catch (e) {
        console.error('\n❌ スプレッドシート取得失敗:');
        console.error(`   Error: ${e.message}`);
        console.error(`   Code: ${e.code || 'N/A'}`);
        
        if (e.response) {
            console.error(`   Status: ${e.response.status}`);
            console.error(`   Status Text: ${e.response.statusText}`);
            if (e.response.data) {
                console.error(`   API Error Details:`, JSON.stringify(e.response.data, null, 2));
            }
        }
        
        // 権限エラーの場合の詳細な説明
        if (e.code === 403 || (e.response && e.response.status === 403)) {
            console.error('\n🔍 権限エラーの原因として考えられること:');
            console.error('   1. Service Accountのメールアドレスがスプレッドシートに共有されていない');
            console.error('   2. スプレッドシートの共有設定が「閲覧者」のみになっている（「編集者」が必要）');
            console.error('   3. Service AccountがMLのメンバーになっていない、またはML経由のアクセスが認識されていない');
            console.error('   4. Google Workspaceの設定で、Service AccountがMLメンバーとして認識されていない');
            console.error('   5. Google Sheets APIが有効化されていない');
            
            const auth = getGoogleAuth();
            if (auth.serviceAccountEmail) {
                console.error(`\n💡 解決方法（優先順位順）:`);
                console.error(`\n【方法1】Service Accountを直接共有（最も確実）:`);
                console.error(`   1. スプレッドシートを開き、「共有」ボタンをクリック`);
                console.error(`   2. 以下のメールアドレスを直接追加:`);
                console.error(`      ${auth.serviceAccountEmail}`);
                console.error(`   3. 権限は「編集者」を選択`);
                console.error(`   4. 「送信」をクリック`);
                
                console.error(`\n【方法2】ML経由の共有を確認（現在の設定）:`);
                console.error(`   1. MLのメンバー一覧を確認:`);
                console.error(`      - MLアドレス: x-auto-post-admin@cocoloni.com`);
                console.error(`      - Service Accountがメンバーに含まれているか確認`);
                console.error(`   2. スプレッドシートの共有設定を確認:`);
                console.error(`      - MLアドレス（x-auto-post-admin@cocoloni.com）が共有されているか`);
                console.error(`      - 権限が「編集者」になっているか`);
                console.error(`   3. Google Workspaceの設定を確認:`);
                console.error(`      - 管理者に確認: Service AccountがMLメンバーとして認識されているか`);
                console.error(`      - セキュリティ設定で外部アカウントとして扱われていないか`);
                
                console.error(`\n【方法3】一時的な回避策:`);
                console.error(`   Service Accountを直接共有する方法1を試してください。`);
                console.error(`   ML経由の共有は、Google Workspaceの設定によっては`);
                console.error(`   Service Accountが認識されない場合があります。`);
            }
        }
        
        throw e;
    }
}


// Google Driveから画像ダウンロード (Google Drive API使用)
// 単一画像用（後方互換性のため残す）
async function downloadImage(fileIdOrUrl) {
    const results = await downloadImages(fileIdOrUrl);
    return results && results.length > 0 ? results[0] : null;
}

// 複数画像ダウンロード対応（改行またはカンマ区切り）
async function downloadImages(imageUrls) {
    if (!imageUrls) return [];
    
    console.log(`\n🔍 画像URL解析開始:`);
    console.log(`   元の値: ${imageUrls.substring(0, 200)}${imageUrls.length > 200 ? '...' : ''}`);
    console.log(`   文字数: ${imageUrls.length}`);
    
    // 改行またはカンマで分割
    const urls = imageUrls
        .split(/[\n,]/)
        .map(url => url.trim())
        .filter(url => url.length > 0);
    
    console.log(`   分割後: ${urls.length}個のURL`);
    urls.forEach((url, idx) => {
        console.log(`     [${idx + 1}] ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
    });
    
    if (urls.length === 0) {
        console.log(`   ⚠️  URLが見つかりませんでした`);
        return [];
    }
    
    // 最大4枚まで（X APIの制限）
    const maxImages = 4;
    const urlsToProcess = urls.slice(0, maxImages);
    
    if (urls.length > maxImages) {
        console.log(`⚠️  画像が${urls.length}枚ありますが、最大${maxImages}枚まで対応しています。最初の${maxImages}枚を使用します。`);
    }
    
    console.log(`\n📥 画像ダウンロード開始: ${urlsToProcess.length}枚`);
    
    const downloadPromises = urlsToProcess.map(async (fileIdOrUrl, index) => {
        // ID抽出
        let fileId = fileIdOrUrl;
        const match = fileIdOrUrl.match(/[-\w]{25,}/);
        if (match) fileId = match[0];

        console.log(`   [${index + 1}/${urlsToProcess.length}] File ID: ${fileId}`);
        
        try {
            const auth = getGoogleAuth();
            const authClient = await auth.getClient();
            const drive = google.drive({ version: 'v3', auth: authClient });
            
            // Google Drive APIでファイルをダウンロード
            const response = await drive.files.get(
                { fileId: fileId, alt: 'media' },
                { responseType: 'arraybuffer' }
            );
            
            const tempPath = path.join('/tmp', `${fileId}_${index}.jpg`);
            await writeFile(tempPath, Buffer.from(response.data));
            console.log(`   ✅ [${index + 1}/${urlsToProcess.length}] ダウンロード完了: ${tempPath}`);
            return tempPath;
        } catch (e) {
            console.error(`   ❌ [${index + 1}/${urlsToProcess.length}] ダウンロード失敗: ${e.message}`);
            
            // 権限エラーの場合の詳細な説明
            if (e.code === 403 || (e.response && e.response.status === 403)) {
                const auth = getGoogleAuth();
                if (auth.serviceAccountEmail) {
                    console.error(`   💡 このファイルがService Accountに共有されているか確認してください:`);
                    console.error(`      ${auth.serviceAccountEmail}`);
                }
            }
            
            return null;
        }
    });
    
    const results = await Promise.all(downloadPromises);
    const successful = results.filter(r => r !== null);
    
    console.log(`   ✅ 合計 ${successful.length}/${urlsToProcess.length} 枚のダウンロードが完了しました`);
    
    return successful;
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
// imagePath: 単一画像パス（後方互換性のため）
// imagePaths: 複数画像パスの配列
async function postTweet(accountKey, text, imagePath, imagePaths) {
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

        // 画像パスの配列を準備（複数画像対応）
        const paths = imagePaths || (imagePath ? [imagePath] : []);
        
        let mediaIds = [];
        if (paths.length > 0) {
            console.log(`📤 画像アップロード中... (${paths.length}枚)`);
            
            // 複数画像を並列でアップロード
            const uploadPromises = paths.map(async (path, index) => {
                try {
                    console.log(`   [${index + 1}/${paths.length}] アップロード中: ${path.substring(path.length - 30)}`);
                    const mediaId = await client.v1.uploadMedia(path);
                    console.log(`   ✅ [${index + 1}/${paths.length}] アップロード完了: Media ID ${mediaId}`);
                    return mediaId;
                } catch (e) {
                    console.error(`   ❌ [${index + 1}/${paths.length}] アップロード失敗:`);
                    console.error(`      Error: ${e.message}`);
                    console.error(`      Code: ${e.code || 'N/A'}`);
                    if (e.response) {
                        console.error(`      Status: ${e.response.status}`);
                        if (e.response.data) {
                            console.error(`      Response: ${JSON.stringify(e.response.data)}`);
                        }
                    }
                    throw e;
                }
            });
            
            try {
                mediaIds = await Promise.all(uploadPromises);
                console.log(`✅ 全画像のアップロード完了: ${mediaIds.length}枚`);
                console.log(`   Media IDs: ${mediaIds.join(', ')}`);
            } catch (uploadError) {
                console.error(`\n❌ 画像アップロード中にエラーが発生しました`);
                throw uploadError;
            }
        }

        console.log(`📝 投稿中 (@${accountKey}): ${text.substring(0, 20)}...`);
        console.log(`   テキスト長: ${text.length}文字`);
        console.log(`   画像数: ${mediaIds.length}枚`);
        if (mediaIds.length > 0) {
            console.log(`   Media IDs: [${mediaIds.join(', ')}]`);
        }
        
        // v2 API for tweet（複数画像対応）
        const tweetParams = {
            text: text,
            media: mediaIds.length > 0 ? { media_ids: mediaIds } : undefined
        };
        console.log(`   投稿パラメータ:`, JSON.stringify({
            text: text.substring(0, 50) + '...',
            media: tweetParams.media
        }, null, 2));
        
        try {
            const result = await client.v2.tweet(tweetParams);
            console.log(`✅ 投稿成功: Tweet ID ${result.data?.id || 'N/A'}`);
        } catch (tweetError) {
            console.error(`\n❌ 投稿APIエラー:`);
            console.error(`   Message: ${tweetError.message}`);
            console.error(`   Code: ${tweetError.code || 'N/A'}`);
            if (tweetError.data) {
                console.error(`   Data:`, JSON.stringify(tweetError.data, null, 2));
            }
            if (tweetError.response) {
                console.error(`   Status: ${tweetError.response.status}`);
                console.error(`   Status Text: ${tweetError.response.statusText}`);
            }
            
            // 403エラーの場合の詳細な説明
            if (tweetError.code === 403 || (tweetError.response && tweetError.response.status === 403)) {
                console.error(`\n🔍 403エラー（権限エラー）の原因として考えられること:`);
                console.error(`   1. X APIのアプリ設定で「Read and write」権限が設定されていない`);
                console.error(`   2. 複数画像（${mediaIds.length}枚）の投稿に必要な権限が不足している可能性`);
                console.error(`   3. Access Tokenが正しくない、または期限切れ`);
                console.error(`\n💡 解決方法:`);
                console.error(`   - Developer Portalでアプリ設定を確認`);
                console.error(`   - 「App permissions」が「Read and write」になっているか確認`);
                console.error(`   - 必要に応じてAccess Tokenを再取得`);
            }
            
            throw tweetError;
        }
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

    // 0. Bot停止フラグをチェック（testモードではスキップ）
    if (mode === 'check') {
        const isEnabled = await checkBotEnabled();
        if (!isEnabled) {
            console.log('🏁 Bot停止中。実行を終了します。');
            return;
        }
    }

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
            console.log(`   画像列の値: ${image ? image.substring(0, 100) + '...' : '(空)'}`);
            
            let imagePaths = [];
            try {
                // 画像DL（複数画像対応）
                if (image) {
                    console.log(`\n🔍 画像処理開始: ${image.length}文字`);
                    imagePaths = await downloadImages(image);
                    console.log(`   ダウンロード完了: ${imagePaths.length}枚`);
                    if (imagePaths.length === 0 && image.trim()) {
                        console.warn(`⚠️  画像のダウンロードに失敗しましたが、テキストのみで投稿を続行します。`);
                    }
                }

                // 投稿（複数画像対応）
                console.log(`\n📤 投稿準備: 画像${imagePaths.length}枚`);
                await postTweet(targetAccount, text, null, imagePaths);
                console.log('✅ 投稿成功');

                // ステータス更新
                await updateSheetStatus(i, colMap.status, newStatus);

            } catch (e) {
                console.error(`❌ 処理失敗: ${e.message}`);
                // エラーをシートに書き込む？
            } finally {
                // 後始末（ダウンロードした画像ファイルを削除）
                for (const imagePath of imagePaths) {
                    try {
                        await unlink(imagePath);
                    } catch (e) {
                        console.warn(`⚠️  一時ファイル削除失敗: ${imagePath} - ${e.message}`);
                    }
                }
            }
        }
    }
    console.log('🏁 完了');
}

main().catch(console.error);
