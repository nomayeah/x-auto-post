/**
 * シークレット設定モーダルを開く
 */
function openSecretInput() {
  const html = HtmlService.createHtmlOutputFromFile('modal')
    .setWidth(400)
    .setHeight(300);
  SpreadsheetApp.getUi().showModalDialog(html, 'シークレット設定');
}

/**
 * モーダルから入力された設定をconfigシートに保存
 */
function saveSecrets(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('config');
  if (!sheet) sheet = ss.insertSheet('config');
  sheet.clearContents();

  const entries = Object.entries(data);
  entries.forEach(([k, v], i) => {
    sheet.getRange(i + 1, 1).setValue(k);
    sheet.getRange(i + 1, 2).setValue(v);
  });
}

/**
 * configシートを読み込む（改善版：デバッグログ追加、文字列化強化）
 */
function getConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('config');
  const config = {};

  if (!sheet) {
    Logger.log('⚠️ configシートが見つかりません');
    return config;
  }

  const values = sheet.getDataRange().getValues();
  Logger.log('📋 configシートの行数: ' + values.length);

  for (let i = 0; i < values.length; i++) {
    const key = values[i][0];
    let val = values[i][1];

    if (!key || key.toString().trim() === '') continue;

    // 値を文字列に変換（数値や日付も文字列として扱う）
    if (val === null || val === undefined) {
      val = '';
    } else if (val instanceof Date) {
      val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    } else {
      val = String(val).trim();
    }

    config[key.toString().trim()] = val;
    Logger.log('  - ' + key + ': ' + (val ? '***' : '(空)'));
  }

  Logger.log('✅ config読み込み完了: ' + Object.keys(config).length + '項目');
  return config;
}

/**
 * 投稿時間をチェックしてGitHub Actionをトリガー
 * posts シートの列構成（ヘッダ行あり）
 * A: 日付 (YYYY-MM-DD)
 * B: 時間 (HH:mm)
 * C: テキスト
 * D: 画像（Driveの共有URL または fileId）
 * E: 投稿済みフラグ (TRUE/FALSE or '投稿済'など)
 * F: Slackメッセージ（任意）
 */
function autoCheckPosts() {
  Logger.log('🔄 autoCheckPosts 開始: ' + new Date());

  const config = getConfig();

  // 必須設定のチェック（より詳細なログ）
  if (!config.github_repo) {
    Logger.log('❌ github_repo が設定されていません');
    if (config.slack_webhook_url) {
      safeSendSlack(config.slack_webhook_url, '⚠️ GitHub設定エラー: github_repo が config シートにありません。');
    }
    return;
  }

  if (!config.github_token) {
    Logger.log('❌ github_token が設定されていません');
    if (config.slack_webhook_url) {
      safeSendSlack(config.slack_webhook_url, '⚠️ GitHub設定エラー: github_token が config シートにありません。');
    }
    return;
  }

  Logger.log('✅ GitHub設定確認完了: ' + config.github_repo);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('posts');

  if (!sheet) {
    Logger.log('❌ postsシートが見つかりません');
    if (config.slack_webhook_url) {
      safeSendSlack(config.slack_webhook_url, '⚠️ postsシートが存在しません。');
    }
    return;
  }
  
  const data = sheet.getDataRange().getValues();
  Logger.log('📋 postsシートの行数: ' + data.length);
  
  if (data.length <= 1) {
    Logger.log('ℹ️ 投稿データがありません（ヘッダーのみ）');
    return;
  }
  
  const now = new Date();
  Logger.log('⏰ 現在時刻: ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
  
  let processedCount = 0;
  let postedCount = 0;
  let errorCount = 0;
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    let dateStr = row[0];
    let timeStr = row[1];
    const text = row[2];
    const image = row[3];
    const posted = row[4];
    const slackMsg = row[5];
    
    // 日付の変換（Dateオブジェクトの場合）
    if (dateStr instanceof Date) {
      dateStr = Utilities.formatDate(dateStr, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else if (dateStr) {
      dateStr = String(dateStr).trim();
    }
    
    // 時間の変換（Dateオブジェクトの場合）
    if (timeStr instanceof Date) {
      timeStr = Utilities.formatDate(timeStr, Session.getScriptTimeZone(), 'HH:mm');
    } else if (timeStr) {
      timeStr = String(timeStr).trim();
    }
    
    // 必須項目チェック
    if (!dateStr || !timeStr || !text || !image) {
      Logger.log('⏭️ 行' + (i + 1) + ': 必須項目不足 - date:' + dateStr + ' time:' + timeStr + ' text:' + (text ? 'あり' : 'なし') + ' image:' + (image ? 'あり' : 'なし'));
      continue;
    }
    
    processedCount++;
    
    // 投稿済みチェック
    const postedStr = String(posted).toLowerCase();
    if (postedStr === 'true' || postedStr.indexOf('投稿済') !== -1 || postedStr.indexOf('投稿中') !== -1) {
      Logger.log('⏭️ 行' + (i + 1) + ': 既に投稿済みまたは投稿中');
      continue;
    }
    
    // 投稿時刻の計算
    const postTimeStr = dateStr + ' ' + timeStr;
    const postTime = new Date(postTimeStr);
    
    if (isNaN(postTime.getTime())) {
      Logger.log('⚠️ 行' + (i + 1) + ': 日時解析失敗 - ' + postTimeStr);
      continue;
    }
    
    Logger.log('🔍 行' + (i + 1) + ': 投稿予定時刻=' + Utilities.formatDate(postTime, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') + 
               ' 現在時刻=' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
    
    // 投稿時刻チェック
    if (postTime > now) {
      Logger.log('⏭️ 行' + (i + 1) + ': まだ投稿時刻ではありません');
      continue;
    }
    
    // 画像IDの抽出
    let fileId = null;
    const imageStr = String(image);
    const match = imageStr.match(/[-\w]{25,}/);
    if (match) {
      fileId = match[0];
    } else {
      fileId = imageStr.trim();
    }
    
    Logger.log('🚀 行' + (i + 1) + ': 投稿開始 - fileId=' + fileId);
    
    const payload = {
      date: dateStr,
      time: timeStr,
      text: String(text).trim(),
      image: fileId,
      slack: slackMsg && String(slackMsg).trim() ? String(slackMsg).trim() : (config.slack_webhook_url || ''),
      drive_folder_id: config.drive_folder_id || ''
    };
    
    try {
      triggerGithubAction(config, payload);
      sheet.getRange(i + 1, 5).setValue('投稿中');
      postedCount++;
      
      Logger.log('✅ 行' + (i + 1) + ': GitHub Actionトリガー成功');
      
      if (payload.slack) {
        safeSendSlack(payload.slack, `🚀 投稿要求送信: ${String(text).slice(0, 60)}`);
      }
    } catch (e) {
      errorCount++;
      const errorMsg = String(e.message || e);
      Logger.log('❌ 行' + (i + 1) + ': エラー - ' + errorMsg);
      sheet.getRange(i + 1, 5).setValue('エラー: ' + errorMsg);
      
      if (config.slack_webhook_url) {
        safeSendSlack(config.slack_webhook_url, `❌ dispatchエラー (行${i + 1}): ${errorMsg}`);
      }
    }
  }
  
  Logger.log(`📊 処理完了 - 処理済み:${processedCount} 投稿中:${postedCount} エラー:${errorCount}`);
}

/**
 * GitHub Actions の repository_dispatch を呼ぶ（改善版：認証ヘッダー修正、エラーログ強化）
 */
function triggerGithubAction(config, payload) {
  const url = 'https://api.github.com/repos/' + config.github_repo + '/dispatches';
  
  Logger.log('📡 GitHub API呼び出し: ' + url);
  Logger.log('📦 Payload: ' + JSON.stringify(payload));
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + config.github_token,  // GitHub API推奨形式（'token' でも動作しますが、'Bearer' が推奨）
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({
      event_type: 'run-post',
      client_payload: payload
    }),
    muteHttpExceptions: true
  };
  
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, options);
  } catch (e) {
    Logger.log('❌ URLFetchApp.fetch エラー: ' + e.toString());
    throw new Error('Network error: ' + e.toString());
  }
  
  const code = resp.getResponseCode();
  const responseText = resp.getContentText();
  
  Logger.log('📥 レスポンスコード: ' + code);
  Logger.log('📥 レスポンス本文: ' + responseText);
  
  if (code < 200 || code >= 300) {
    let errorDetail = '';
    try {
      const errorJson = JSON.parse(responseText);
      errorDetail = errorJson.message || JSON.stringify(errorJson);
    } catch (e) {
      errorDetail = responseText;
    }
    
    Logger.log('❌ GitHub APIエラー: HTTP ' + code + ' - ' + errorDetail);
    throw new Error('GitHub dispatch failed. HTTP ' + code + ' - ' + errorDetail);
  }
  
  Logger.log('✅ GitHub Actionトリガー成功');
}

/**
 * 安全にSlackに通知（例外吸収）
 */
function safeSendSlack(webhookUrl, message) {
  if (!webhookUrl || webhookUrl.trim() === '') {
    Logger.log('⏭️ Slack Webhook URLが設定されていません');
    return;
  }
  
  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: message })
    });
    Logger.log('✅ Slack通知送信: ' + message.slice(0, 50));
  } catch (e) {
    Logger.log('❌ Slack通知失敗: ' + e.toString());
  }
}

/**
 * 投稿監視トリガー開始（5分おき）
 */
function startScheduler() {
  stopScheduler();
  
  ScriptApp.newTrigger('autoCheckPosts').timeBased().everyMinutes(5).create();
  
  const cfg = getConfig();
  Logger.log('▶️ 自動投稿スケジューラーを開始しました（5分ごとにチェック）');
  
  if (cfg.slack_webhook_url) {
    safeSendSlack(cfg.slack_webhook_url, '▶️ 自動投稿を開始しました（5分ごとにチェック）');
  }
}

/**
 * 投稿監視トリガー停止
 */
function stopScheduler() {
  const triggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;
  
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    if (t.getHandlerFunction() === 'autoCheckPosts') {
      ScriptApp.deleteTrigger(t);
      deletedCount++;
    }
  }
  
  Logger.log('⏹ 自動投稿スケジューラーを停止しました（削除: ' + deletedCount + 'トリガー）');
  
  const cfg = getConfig();
  if (cfg.slack_webhook_url) {
    safeSendSlack(cfg.slack_webhook_url, '⏹ 自動投稿を停止しました');
  }
}

/**
 * デバッグ用：設定とpostsシートの状態を確認
 * ログの確認方法:
 * 1. スクリプトエディタ上部のメニューで「表示」→「実行ログ」をクリック
 * 2. または、キーボードショートカット: Macは Cmd+Enter, Windows/Linuxは Ctrl+Enter
 * 3. 実行後、下部にログが表示されます
 */
function debugCheck() {
  try {
    Logger.log('=== デバッグ情報 開始 ===');
    Logger.log('実行時刻: ' + new Date());
    
    // スプレッドシートの取得
    let ss;
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
      Logger.log('✅ スプレッドシート取得成功: ' + ss.getName());
    } catch (e) {
      Logger.log('❌ スプレッドシート取得エラー: ' + e.toString());
      return;
    }
    
    // configシートの確認
    try {
      Logger.log('\n--- configシートの確認 ---');
      const config = getConfig();
      Logger.log('設定項目数: ' + Object.keys(config).length);
      
      if (Object.keys(config).length === 0) {
        Logger.log('⚠️ configシートにデータがありません');
      } else {
        Logger.log('設定された項目:');
        for (const key in config) {
          const val = config[key];
          // トークンやURLなどは一部のみ表示（セキュリティのため）
          if (key.includes('token') || key.includes('password') || key.includes('secret')) {
            Logger.log('  - ' + key + ': ' + (val ? val.substring(0, 10) + '...' : '(空)'));
          } else {
            Logger.log('  - ' + key + ': ' + (val ? val : '(空)'));
          }
        }
      }
    } catch (e) {
      Logger.log('❌ configシート読み込みエラー: ' + e.toString());
      Logger.log('エラー詳細: ' + e.stack);
    }
    
    // postsシートの確認
    try {
      Logger.log('\n--- postsシートの確認 ---');
      const postsSheet = ss.getSheetByName('posts');
      
      if (!postsSheet) {
        Logger.log('❌ postsシートが見つかりません');
        Logger.log('利用可能なシート:');
        const allSheets = ss.getSheets();
        allSheets.forEach(function(sheet) {
          Logger.log('  - ' + sheet.getName());
        });
      } else {
        Logger.log('✅ postsシートが見つかりました');
        const data = postsSheet.getDataRange().getValues();
        Logger.log('postsシートの行数: ' + data.length);
        
        if (data.length === 0) {
          Logger.log('⚠️ postsシートにデータがありません');
        } else if (data.length === 1) {
          Logger.log('⚠️ postsシートにヘッダーのみあります');
          Logger.log('ヘッダー: ' + data[0].join(' | '));
        } else {
          Logger.log('ヘッダー: ' + data[0].join(' | '));
          Logger.log('データ行数: ' + (data.length - 1));
          
          // 最初の3行だけ表示（長すぎるのを防ぐため）
          const displayRows = Math.min(3, data.length - 1);
          for (let i = 1; i <= displayRows; i++) {
            Logger.log('行' + (i + 1) + ': ' + data[i].join(' | '));
          }
          if (data.length > 4) {
            Logger.log('... (他 ' + (data.length - 4) + ' 行)');
          }
        }
      }
    } catch (e) {
      Logger.log('❌ postsシート確認エラー: ' + e.toString());
      Logger.log('エラー詳細: ' + e.stack);
    }
    
    Logger.log('\n=== デバッグ情報 終了 ===');
    
    // ログの見方をенапоминание
    SpreadsheetApp.getUi().alert('デバッグ完了！\n\nログを確認するには:\n1. スクリプトエディタで「表示」→「実行ログ」をクリック\n2. または、Cmd+Enter (Mac) / Ctrl+Enter (Win)');
    
  } catch (e) {
    Logger.log('❌ debugCheck関数で予期しないエラー: ' + e.toString());
    Logger.log('エラー詳細: ' + e.stack);
    SpreadsheetApp.getUi().alert('エラーが発生しました: ' + e.toString() + '\n\nログを確認してください（表示→実行ログ）');
  }
}

