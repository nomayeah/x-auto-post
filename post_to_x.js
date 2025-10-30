require('dotenv').config()
const axios = require('axios')
const { writeFile, unlink } = require('fs/promises')
const { chromium } = require('playwright')

// googleapisはオプション（インストールされていない場合でも動作する）
let google = null
try {
  google = require('googleapis').google
} catch (e) {
  console.log('ℹ️ googleapisパッケージがインストールされていません。HTMLパース方法を使用します。')
}

// スプレッドシートIDを取得
function getSpreadsheetId() {
  return process.env.SPREADSHEET_ID || '1O9pWwkMvVBQOngRSLumogXFktAHmAmur65t5Kwpxe4Y'
}

// configシートから設定を取得
async function getConfigFromSheet() {
  const spreadsheetId = getSpreadsheetId()
  const csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=config`
  
  try {
    const response = await axios.get(csvUrl)
    const csvData = response.data
    const lines = csvData.split('\n').filter(line => line.trim())
    
    const config = {}
    for (const line of lines) {
      const firstCommaIndex = line.indexOf(',')
      if (firstCommaIndex === -1) continue
      
      let key = line.substring(0, firstCommaIndex).trim().replace(/^"|"$/g, '')
      let value = line.substring(firstCommaIndex + 1).trim().replace(/^"|"$/g, '')
      
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }
      
      if (key && value) {
        config[key] = value
      }
    }
    
    console.log(`✅ configシートから設定を取得: ${Object.keys(config).length}項目`)
    return config
  } catch (error) {
    console.error('❌ configシートの取得に失敗:', error.message)
    throw error
  }
}

// postsシートから投稿データを取得
async function getPostFromSheet() {
  const spreadsheetId = getSpreadsheetId()
  const csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=posts`
  
  try {
    const response = await axios.get(csvUrl)
    const csvData = response.data
    
    // デバッグ: CSVデータの最初の500文字を表示
    console.log(`📄 CSVデータ（最初の500文字）:\n${csvData.substring(0, 500)}...`)
    
    // CSVパーサー（改行を含むテキストにも対応）
    function parseCSV(csvText) {
      const rows = []
      let currentRow = []
      let currentValue = ''
      let inQuotes = false
      
      for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i]
        const nextChar = csvText[i + 1]
        
        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            // エスケープされた引用符（""）
            currentValue += '"'
            i++ // 次の文字をスキップ
          } else {
            // 引用符の開始/終了
            inQuotes = !inQuotes
          }
        } else if (char === ',' && !inQuotes) {
          // カンマ（引用符外）→ 列の区切り
          currentRow.push(currentValue)
          currentValue = ''
        } else if (char === '\n' && !inQuotes) {
          // 改行（引用符外）→ 行の区切り
          currentRow.push(currentValue)
          if (currentRow.some(v => v.trim() !== '')) {
            rows.push(currentRow)
          }
          currentRow = []
          currentValue = ''
        } else if (char === '\r') {
          // \rは無視（\r\nの場合は次の\nで処理される）
          if (nextChar !== '\n') {
            // \r単独の場合は改行として扱う（Mac形式）
            if (!inQuotes) {
              currentRow.push(currentValue)
              if (currentRow.some(v => v.trim() !== '')) {
                rows.push(currentRow)
              }
              currentRow = []
              currentValue = ''
            }
          }
        } else {
          // 通常の文字（引用符内の改行も含む）
          currentValue += char
        }
      }
      
      // 最後の行を追加
      if (currentValue || currentRow.length > 0) {
        currentRow.push(currentValue)
        if (currentRow.some(v => v.trim() !== '')) {
          rows.push(currentRow)
        }
      }
      
      return rows
    }
    
    const rows = parseCSV(csvData)
    
    if (rows.length < 2) {
      console.log('⚠️ postsシートにデータがありません')
      return null
    }
    
    // ヘッダー行
    const headers = rows[0].map(h => h.trim().replace(/^"|"$/g, ''))
    console.log(`📋 postsシートのヘッダー: ${headers.join(', ')}`)
    
    // 列インデックスを取得
    const dateIndex = headers.indexOf('日付')
    const timeIndex = headers.indexOf('時間')
    const textIndex = headers.indexOf('テキスト')
    const imageIndex = headers.indexOf('画像')
    const postedIndex = headers.indexOf('投稿済フラグ')
    
    if (dateIndex === -1 || timeIndex === -1 || textIndex === -1 || imageIndex === -1) {
      throw new Error('postsシートの必須列が見つかりません（日付、時間、テキスト、画像）')
    }
    
    // 現在時刻
    const now = new Date()
    // ローカル実行時は時刻チェックをスキップ
    const skipTimeCheck = process.env.CI !== 'true'
    
    console.log(`📊 データ行数: ${rows.length - 1}行`)
    console.log(`⏰ 現在時刻: ${now.toLocaleString('ja-JP')}`)
    console.log(`⏰ 時刻チェック: ${skipTimeCheck ? 'スキップ' : '有効'}`)
    
    // データ行を処理
    for (let i = 1; i < rows.length; i++) {
      const values = rows[i]
      console.log(`\n🔍 行${i + 1}を処理中...`)
      console.log(`   パース結果: ${values.length}列`)
      
      if (values.length <= Math.max(dateIndex, timeIndex, textIndex, imageIndex)) {
        console.log(`   ⏭️ 列数不足でスキップ（必要な列: ${Math.max(dateIndex, timeIndex, textIndex, imageIndex) + 1}列）`)
        continue
      }
      
      // 値を取得（引用符を削除）
      const dateStr = (values[dateIndex] || '').trim().replace(/^"|"$/g, '')
      const timeStr = (values[timeIndex] || '').trim().replace(/^"|"$/g, '')
      const text = (values[textIndex] || '').trim().replace(/^"|"$/g, '')
      const image = (values[imageIndex] || '').trim().replace(/^"|"$/g, '')
      const posted = postedIndex >= 0 ? (values[postedIndex] || '').trim().replace(/^"|"$/g, '') : ''
      
      console.log(`   日付: "${dateStr}"`)
      console.log(`   時間: "${timeStr}"`)
      console.log(`   テキスト: ${text ? text.substring(0, 50) + '...' : '(空)'}`)
      console.log(`   画像: "${image}"`)
      console.log(`   投稿済: "${posted}"`)
      
      // 必須項目チェック
      if (!dateStr || !timeStr || !text || !image) {
        console.log(`   ⏭️ 必須項目不足でスキップ`)
        continue
      }
      
      // 投稿済みチェック
      // GitHub Actionsの場合は「投稿済」のみスキップ、ローカルの場合は「投稿済」のみスキップ（「投稿中」は再実行可能）
      const postedStr = String(posted).toLowerCase()
      const isLocal = process.env.CI !== 'true'
      
      if (isLocal) {
        // ローカル実行時は「投稿済」のみスキップ（「投稿中」は再実行可能）
        if (postedStr === 'true' || postedStr.includes('投稿済')) {
          console.log(`   ⏭️ 投稿済みでスキップ（ローカル実行）`)
          continue
        }
      } else {
        // GitHub Actions実行時は「投稿済」と「投稿中」をスキップ
        if (postedStr === 'true' || postedStr.includes('投稿済') || postedStr.includes('投稿中')) {
          console.log(`   ⏭️ 投稿済みまたは投稿中でスキップ（GitHub Actions）`)
          continue
        }
      }
      
      // 投稿時刻チェック（GitHub Actionsの場合は必須、ローカルの場合はオプション）
      if (!skipTimeCheck) {
        // 日付形式を変換（2025/11/5 → 2025-11-05）
        let normalizedDate = dateStr.replace(/\//g, '-')
        // 月日が1桁の場合は0埋め
        const dateParts = normalizedDate.split('-')
        if (dateParts.length === 3) {
          const year = dateParts[0]
          const month = dateParts[1].padStart(2, '0')
          const day = dateParts[2].padStart(2, '0')
          normalizedDate = `${year}-${month}-${day}`
        }
        
        const postTimeStr = `${normalizedDate} ${timeStr}`
        const postTime = new Date(postTimeStr)
        
        console.log(`   投稿予定時刻: ${postTimeStr} → ${postTime.toLocaleString('ja-JP')}`)
        
        if (isNaN(postTime.getTime())) {
          console.log(`   ⏭️ 日時解析失敗でスキップ`)
          continue
        }
        
        if (postTime > now) {
          console.log(`   ⏭️ まだ投稿時刻ではありません（予定: ${postTime.toLocaleString('ja-JP')}, 現在: ${now.toLocaleString('ja-JP')}）`)
          continue
        }
        
        console.log(`   ✅ 投稿時刻になりました（予定: ${postTime.toLocaleString('ja-JP')}, 現在: ${now.toLocaleString('ja-JP')}）`)
      } else {
        console.log(`   ✅ 時刻チェックをスキップ（ローカル実行）`)
      }
      
      // 画像IDの抽出（Google Drive URLから、またはファイル名から）
      let fileId = image.trim()
      
      // Google Drive URLからfile_idを抽出
      const driveUrlMatch = image.match(/\/file\/d\/([-\w]{25,})|id=([-\w]{25,})|\/d\/([-\w]{25,})/)
      if (driveUrlMatch) {
        fileId = driveUrlMatch[1] || driveUrlMatch[2] || driveUrlMatch[3]
        console.log(`   ✅ Google Drive URLからfile_idを抽出: ${fileId}`)
      } else {
        // file_id形式（33文字以上の英数字とハイフン）の場合はそのまま使用
        const fileIdMatch = image.match(/([-\w]{33,})/)
        if (fileIdMatch && fileIdMatch[1].length >= 33) {
          fileId = fileIdMatch[1]
          console.log(`   ✅ file_idを抽出: ${fileId}`)
        } else {
          // ファイル名のみの場合は、そのまま使用（Google Driveフォルダ内のファイル名として検索）
          console.log(`   ℹ️ ファイル名として使用: ${fileId}`)
          console.log(`   💡 ヒント: Google Drive URLまたはfile_id（33文字以上）を指定してください`)
          // ファイル名の場合は、そのまま使用してダウンロードを試みる
        }
      }
      
      console.log(`✅ 投稿データを取得（行${i + 1}）`)
      console.log(`   テキスト: ${text.substring(0, 50)}...`)
      console.log(`   画像: ${fileId}`)
      
      // 最初の1つだけ返す（ローカルテスト用）
      return { text, image: fileId }
    }
    
    console.log('ℹ️ postsシートに投稿可能なデータがありません')
    return null
  } catch (error) {
    console.error('❌ postsシートの取得に失敗:', error.message)
    throw error
  }
}

// Slack通知
async function sendSlack(message, webhookUrl) {
  if (!webhookUrl) return
  try {
    await axios.post(webhookUrl, { text: message })
  } catch (e) {
    console.error('Slack通知失敗:', e.message)
  }
}

// Google Drive APIを使ってファイル名からfile_idを取得
// ヘッドレスモードでも動作する（Playwrightでブラウザから取得）
async function findFileIdByName(filename, folderId) {
  console.log(`   🔍 ファイルを検索: ${filename} (フォルダID: ${folderId})`)
  
  // 方法1: Google Drive APIを使う（認証が必要な場合）
  try {
    // googleapisがインストールされている場合のみ試行
    if (google !== null && google.drive) {
      console.log(`   📡 Google Drive APIで検索を試行...`)
      const drive = google.drive({ version: 'v3', auth: null })
      
      const query = `'${folderId}' in parents and name='${filename}' and trashed=false`
      console.log(`   📝 検索クエリ: ${query}`)
      
      const response = await drive.files.list({
        q: query,
        fields: 'files(id, name)',
        pageSize: 10
      })
      
      const files = response.data.files
      if (files && files.length > 0) {
        const file = files[0]
        console.log(`   ✅ Google Drive APIでファイルが見つかりました: ${file.name} (ID: ${file.id})`)
        return file.id
      }
    }
  } catch (apiError) {
    console.log(`   ⚠️ Google Drive APIアクセス失敗: ${apiError.message}`)
    console.log(`   🔍 PlaywrightでブラウザからファイルIDを取得します...`)
  }
  
  // 方法2: axiosでHTMLを取得（ブラウザを起動しない）
  try {
    console.log(`   🌐 axiosでファイルIDを取得中（ブラウザを起動しない）...`)
    const folderUrl = `https://drive.google.com/drive/folders/${folderId}`
    
    try {
      // axiosでHTMLを取得（JavaScriptは実行されないが、基本的なHTMLは取得できる）
      const response = await axios.get(folderUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        },
        timeout: 30000
      })
      
      const html = response.data
      console.log(`   📄 HTML取得完了: ${html.length}文字`)
    
    // デバッグ: ファイル名がHTMLに含まれているか確認
    if (html.includes(filename)) {
      console.log(`   ✅ HTMLにファイル名 "${filename}" が見つかりました`)
    } else {
      console.log(`   ⚠️ HTMLにファイル名 "${filename}" が見つかりませんでした`)
      // ファイル名の一部で検索（拡張子を除く）
      const filenameWithoutExt = filename.replace(/\.[^.]+$/, '')
      if (html.includes(filenameWithoutExt)) {
        console.log(`   ✅ HTMLにファイル名（拡張子なし） "${filenameWithoutExt}" が見つかりました`)
      }
    }
    
    // パターン1: ファイル名を含むJSONデータを検索
    // エスケープされたファイル名
    const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const filenameWithoutExt = filename.replace(/\.[^.]+$/, '')
    const escapedFilenameWithoutExt = filenameWithoutExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    
    const jsonPatterns = [
      // パターン1: "filename.jpg" の後にfile_id
      new RegExp(`"${escapedFilename}"[^"]*"([^"]{25,})"`, 'i'),
      // パターン2: "name":"filename.jpg" の後に "id":"..."
      new RegExp(`"name":\\s*"${escapedFilename}"[^}]*"id":\\s*"([^"]{25,})"`, 'i'),
      // パターン3: "filename.jpg" の後に "id":"..."
      new RegExp(`"${escapedFilename}"[^}]*"id":\\s*"([^"]{25,})"`, 'i'),
      // パターン4: ファイル名（拡張子なし）で検索
      new RegExp(`"${escapedFilenameWithoutExt}"[^"}]*"([^"]{25,})"`, 'i'),
      // パターン5: より一般的なパターン: ファイル名とIDが近くにある（500文字以内）
      new RegExp(`"${escapedFilename}"[\\s\\S]{0,500}?"([^"]{25,})"`, 'i'),
      // パターン6: ファイル名を含む任意の文字列の後にfile_id形式の文字列
      new RegExp(`${escapedFilename}[\\s\\S]{0,1000}?([-\\w]{25,})`, 'i')
    ]
    
    for (let i = 0; i < jsonPatterns.length; i++) {
      const pattern = jsonPatterns[i]
      const match = html.match(pattern)
      
      if (match && match[1]) {
        const extractedFileId = match[1]
        // 抽出されたIDがfile_id形式か確認（25文字以上の英数字とハイフン）
        if (/^[-\w]{25,}$/.test(extractedFileId)) {
          console.log(`   ✅ HTMLからファイルIDを抽出（パターン${i + 1}）: ${extractedFileId}`)
          return extractedFileId
        } else {
          console.log(`   ⚠️ パターン${i + 1}で抽出したIDが不正: ${extractedFileId}`)
        }
      }
    }
    
      // パターン7: フォルダ内のすべてのfile_idを抽出して、ファイル名と近いものを探す
      console.log(`   🔍 すべてのfile_idを抽出してファイル名と照合します...`)
      const allFileIds = html.match(/[-\\w]{25,}/g) || []
      const uniqueFileIds = [...new Set(allFileIds)]
      console.log(`   📋 見つかったfile_id候補: ${uniqueFileIds.length}個`)
      
      // ファイル名の前後1000文字以内にfile_idがあるか確認
      for (const fileId of uniqueFileIds) {
        if (fileId.length >= 25 && fileId !== folderId) {
          const contextPattern = new RegExp(`[\\s\\S]{0,1000}${escapedFilename}[\\s\\S]{0,1000}${fileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
          if (html.match(contextPattern)) {
            console.log(`   ✅ ファイル名の近くにfile_idが見つかりました: ${fileId}`)
            return fileId
          }
        }
      }
      
      // パターン8: JavaScript実行データは取得できないためスキップ
      // axiosではJavaScriptが実行されないため、この方法は使用できない
      console.log(`   ⚠️ axiosではJavaScript実行データを取得できません（スキップ）`)
      let fileId = null
      
      // 以前のPlaywrightベースのコード（参考用、実行されない）
      /*
      const fileId = await page.evaluate((filename) => {
        // window._DRIVE_ivd や window['_DRIVE_ivd'] などのデータを検索
        const searchInWindow = (obj, filename) => {
          if (typeof obj !== 'object' || obj === null) return null
          
          for (const key in obj) {
            if (typeof obj[key] === 'string' && obj[key] === filename) {
              // 近くにidがあるか確認
              if (obj.id && /^[-\w]{25,}$/.test(obj.id)) {
                return obj.id
              }
            }
            if (typeof obj[key] === 'object') {
              const found = searchInWindow(obj[key], filename)
              if (found) return found
            }
          }
          return null
        }
        
        // 複数のwindowオブジェクトのプロパティを検索
        const searchKeys = ['_DRIVE_ivd', '_DRIVE_fs', '_DRIVE_loaded', '_DRIVE_initialData']
        for (const key of searchKeys) {
          if (window[key]) {
            const found = searchInWindow(window[key], filename)
            if (found) return found
          }
        }
        
        // DOMから直接ファイル名を検索
        const elements = document.querySelectorAll('[data-name], [title]')
        for (const el of elements) {
          const name = el.getAttribute('data-name') || el.getAttribute('title') || el.textContent
          if (name && name.includes(filename)) {
            // 親要素や兄弟要素からfile_idを探す
            let current = el
            for (let i = 0; i < 5; i++) {
              const dataId = current.getAttribute('data-id') || current.getAttribute('id')
              if (dataId && /^[-\w]{25,}$/.test(dataId)) {
                return dataId
              }
              current = current.parentElement
              if (!current) break
            }
          }
        }
        
        return null
      }, filename)
      */
      
      if (fileId) {
        console.log(`   ✅ JavaScript実行結果からファイルIDを取得: ${fileId}`)
        return fileId
      }
      
      console.log(`   ⚠️ HTMLからファイルIDを抽出できませんでした`)
      return null
    } catch (pageError) {
      console.error(`   ❌ ページアクセス失敗: ${pageError.message}`)
      return null
    }
  } catch (requestError) {
    console.error(`   ❌ HTTPリクエスト失敗: ${requestError.message}`)
    return null
  }
}

// Google Driveから画像をダウンロード
// fileId: ファイル名またはfile_idまたはGoogle Drive URL
// driveFolderId: Google DriveフォルダID（configシートのdrive_folder_id）
async function downloadImageFromDrive(fileId, driveFolderId = null) {
  console.log(`📥 画像ダウンロード開始: ${fileId}`)
  if (driveFolderId) {
    console.log(`   📁 フォルダID: ${driveFolderId}`)
  }
  
  let url
  let actualFileId = fileId
  const isLocal = process.env.CI !== 'true'
  
  // Google Drive URLからfile_idを再抽出
  const driveUrlMatch = fileId.match(/\/file\/d\/([-\w]{25,})|id=([-\w]{25,})|\/d\/([-\w]{25,})/)
  if (driveUrlMatch) {
    actualFileId = driveUrlMatch[1] || driveUrlMatch[2] || driveUrlMatch[3]
    console.log(`   📝 Google Drive URLからfile_idを抽出: ${actualFileId}`)
  } else if (fileId.length >= 33 && /^[-\w]+$/.test(fileId)) {
    // file_id形式（33文字以上の英数字とハイフン）の場合はそのまま使用
    actualFileId = fileId
    console.log(`   ✅ file_idとして使用: ${actualFileId}`)
  } else {
    // ファイル名のみの場合（33文字未満またはfile_id形式でない）
    // drive_folder_idとファイル名からGoogle Drive APIで検索する
    if (driveFolderId) {
      console.log(`   📁 ファイル名から検索: ${fileId} (フォルダID: ${driveFolderId})`)
      
      try {
        // Google Drive APIを使ってファイル名からfile_idを取得
        actualFileId = await findFileIdByName(fileId, driveFolderId)
        if (actualFileId) {
          console.log(`   ✅ ファイル名からfile_idを取得: ${actualFileId}`)
        } else {
          // ファイルが見つからない場合は、エラーを投げる
          throw new Error(`ファイル名 "${fileId}" が見つかりませんでした（フォルダID: ${driveFolderId}）`)
        }
      } catch (error) {
        console.error(`   ❌ ファイル名からfile_idを取得失敗: ${error.message}`)
        console.log(`   💡 代替案: スプレッドシートの「画像」列に、Google Drive URLまたはfile_id（33文字以上）を設定してください`)
        throw new Error(`ファイル名からfile_idを取得できませんでした: ${error.message}`)
      }
    } else {
      // drive_folder_idが設定されていない場合は、エラーを投げる
      throw new Error(`drive_folder_idが設定されていません。スプレッドシートの「画像」列に、Google Drive URLまたはfile_id（33文字以上）を設定してください`)
    }
  }
  
  // actualFileIdがnullの場合は、エラーを投げる
  if (!actualFileId) {
    throw new Error('画像のfile_idが取得できませんでした')
  }
  
  url = `https://drive.google.com/uc?export=download&id=${actualFileId}`
  
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 30000
    })
    
    let extension = 'jpg'
    const contentType = response.headers['content-type']
    if (contentType?.includes('png')) extension = 'png'
    else if (contentType?.includes('gif')) extension = 'gif'
    else if (contentType?.includes('webp')) extension = 'webp'
    
    const path = `/tmp/${actualFileId}.${extension}`
    await writeFile(path, Buffer.from(response.data))
    console.log(`✅ 画像ダウンロード完了: ${path}`)
    return path
  } catch (error) {
    // ローカルテスト時でも、画像ダウンロードに失敗した場合はエラーとして扱う
    // （画像付き投稿のテストができないため）
    console.error(`❌ 画像ダウンロード失敗: ${error.message}`)
    console.error(`   URL: ${url}`)
    console.error(`   fileId: ${fileId}`)
    console.error(`   actualFileId: ${actualFileId}`)
    throw new Error(`画像のダウンロードに失敗: ${error.message}`)
  }
}

// Xに投稿
async function postToX() {
  console.log('🚀 X投稿を開始')
  
  // configシートから認証情報を取得
  const config = await getConfigFromSheet()
  const xEmail = config.X_EMAIL
  const xUsername = config.X_USERNAME
  const xPassword = config.X_PASSWORD
  const slackWebhookUrl = config.slack_webhook_url
  
  if (!xEmail || !xUsername || !xPassword) {
    throw new Error('configシートにX認証情報（X_EMAIL, X_USERNAME, X_PASSWORD）が設定されていません')
  }
  
  await sendSlack('🚀 X投稿を開始', slackWebhookUrl)
  
  // postsシートから投稿データを取得
  // GitHub Actionsから渡されている場合は環境変数を使用、そうでなければスプレッドシートから取得
  let text = process.env.TEXT
  let image = process.env.IMAGE
  const driveFolderId = config.drive_folder_id || process.env.DRIVE_FOLDER_ID
  
  if (!text || !image) {
    const postData = await getPostFromSheet()
    if (!postData) {
      throw new Error('投稿データが見つかりません')
    }
    text = postData.text
    image = postData.image
  }
  
  // 画像をダウンロード（drive_folder_idを渡す）
  // 画像がない場合やダウンロードに失敗した場合は、投稿を中止する
  let imagePath = null
  let hasImage = false
  if (image && image.trim() !== '') {
    try {
      imagePath = await downloadImageFromDrive(image, driveFolderId)
      hasImage = imagePath !== null
      if (!hasImage) {
        throw new Error('画像のダウンロードに失敗しました（imagePathがnull）')
      }
    } catch (error) {
      console.error(`❌ 画像のダウンロードに失敗しました: ${error.message}`)
      await sendSlack(`❌ 画像のダウンロードに失敗しました。投稿を中止します: ${error.message}`, slackWebhookUrl)
      throw new Error(`画像のダウンロードに失敗したため、投稿を中止します: ${error.message}`)
    }
  } else {
    throw new Error('画像が指定されていません。投稿を中止します')
  }
  
  // ヘッドレスモードの判定（GitHub Actionsの場合はheadless、ローカルの場合はGUI）
  const isCI = process.env.CI === 'true'
  const headless = process.env.HEADLESS !== 'false' && isCI
  console.log(`🖥️ 実行環境: ${isCI ? 'GitHub Actions (CI)' : 'ローカル'}`)
  console.log(`🖥️ ヘッドレスモード: ${headless ? '有効' : '無効 (GUI)'}`)
  
  let browser = null
  try {
    // ブラウザを起動
    browser = await chromium.launch({
      headless: headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      ],
      slowMo: headless ? 0 : 100
    })
    
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    })
    
    // bot検出回避
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true
      })
      
      if (navigator.chrome) {
        Object.defineProperty(navigator, 'chrome', {
          get: () => ({ runtime: {} }),
          configurable: true
        })
      }
      
      Object.defineProperty(navigator, 'plugins', {
        get: () => ({
          length: 3,
          item: () => null,
          namedItem: () => null
        }),
        configurable: true
      })
      
      Object.defineProperty(navigator, 'languages', {
        get: () => ['ja-JP', 'ja', 'en-US', 'en'],
        configurable: true
      })
    })
    
    const page = await context.newPage()
    
    // ログイン
    console.log('🌐 Xログインページにアクセス')
    await sendSlack('🌐 Xログインページにアクセス', slackWebhookUrl)
    
    try {
      console.log('📡 ページに移動中...')
      await page.goto('https://x.com/i/flow/login', {
        waitUntil: 'domcontentloaded', // networkidleからdomcontentloadedに変更（より早く読み込まれる）
        timeout: 60000 // タイムアウトを60秒に短縮
      })
      console.log('✅ ページ読み込み完了')
      
      // ページが完全に読み込まれるまで待機
      await page.waitForTimeout(3000)
      
      // エラーページチェック
      console.log('🔍 エラーページをチェック中...')
      const bodyText = await page.textContent('body')
      if (bodyText && (bodyText.toLowerCase().includes('oops') || bodyText.toLowerCase().includes('something went wrong'))) {
        throw new Error('Xのエラーページが表示されました')
      }
      
      console.log('✅ ログインページを開きました')
      await sendSlack('✅ ログインページを開きました', slackWebhookUrl)
    } catch (error) {
      console.error('❌ ページ読み込みエラー:', error.message)
      // スクリーンショットを撮影
      try {
        await page.screenshot({ path: '/tmp/login_error.png', fullPage: true })
        console.log('📸 スクリーンショットを保存: /tmp/login_error.png')
      } catch (e) {
        console.error('スクリーンショット保存失敗:', e.message)
      }
      throw new Error(`ログインページの読み込みに失敗: ${error.message}`)
    }
    
    // メールアドレス入力
    console.log('📧 メールアドレスを入力')
    await page.waitForSelector('input[name="text"]', { timeout: 20000 })
    await page.fill('input[name="text"]', xEmail)
    await page.waitForTimeout(1000)
    
    // 「次へ」ボタンをクリック（日本語）
    console.log('🔘 「次へ」ボタンをクリック')
    try {
      // 複数のセレクタを試行（日本語の「次へ」を含む）
      const nextSelectors = [
        'button:has-text("次へ")',
        'button[role="button"]:has-text("次へ")',
        'button[type="button"]:has-text("次へ")',
        'span:has-text("次へ")',
        'div[role="button"]:has-text("次へ")',
        // 英語版のフォールバック
        'button:has-text("Next")',
        'span:has-text("Next")'
      ]
      
      let nextClicked = false
      for (const selector of nextSelectors) {
        try {
          console.log(`🔍 セレクタを試行: ${selector}`)
          await page.waitForSelector(selector, { timeout: 5000 })
          // ボタンが有効になるまで待機
          const button = page.locator(selector).first()
          await button.waitFor({ state: 'visible', timeout: 5000 })
          // ボタンが無効化されていないか確認
          const isDisabled = await button.getAttribute('disabled')
          if (isDisabled === null) {
            await button.click()
            console.log(`✅ 「次へ」ボタンをクリック: ${selector}`)
            nextClicked = true
            break
          } else {
            console.log(`⏭️ ボタンが無効化されています: ${selector}`)
          }
        } catch (e) {
          console.log(`⏭️ セレクタ失敗: ${selector} - ${e.message}`)
          continue
        }
      }
      
      if (!nextClicked) {
        // フォールバック: Enterキーを送信
        console.log('⚠️ 「次へ」ボタンが見つからないため、Enterキーを送信')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(1000)
      }
      
      await sendSlack('📧 メールアドレス入力完了', slackWebhookUrl)
      await page.waitForTimeout(3000)
    } catch (error) {
      console.error('❌ 「次へ」ボタンのクリックに失敗:', error.message)
      await sendSlack(`❌ 「次へ」ボタンのクリックに失敗: ${error.message}`, slackWebhookUrl)
      throw error
    }
    
    // ユーザー名入力（スキップされる可能性がある）
    console.log('👤 ユーザー名入力ステップを確認中...')
    await page.waitForTimeout(2000) // ページ遷移の待機
    
    // ユーザー名入力フィールドが存在するか確認（短いタイムアウト）
    const usernameInputExists = await page.locator('input[name="text"]').count().then(count => count > 0).catch(() => false)
    
    if (usernameInputExists) {
      // ユーザー名入力フィールドが見つかった場合
      console.log('👤 ユーザー名入力フィールドが見つかりました。ユーザー名を入力します')
      try {
        await page.waitForSelector('input[name="text"]', { timeout: 5000 })
        await page.fill('input[name="text"]', xUsername)
        await page.waitForTimeout(1000)
        
        // 「次へ」ボタンをクリック
        const nextButtonSelectors = [
          'button[data-testid="ocfEnterTextNextButton"]',
          'button:has-text("次へ")',
          'button:has-text("Next")'
        ]
        
        let nextButtonClicked = false
        for (const selector of nextButtonSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 3000 })
            await page.click(selector)
            console.log(`✅ 「次へ」ボタンをクリック: ${selector}`)
            nextButtonClicked = true
            break
          } catch (e) {
            continue
          }
        }
        
        if (!nextButtonClicked) {
          // フォールバック: Enterキーを送信
          console.log('⚠️ 「次へ」ボタンが見つからないため、Enterキーを送信')
          await page.keyboard.press('Enter')
        }
        
        await sendSlack('✅ ユーザー名入力完了', slackWebhookUrl)
        await page.waitForTimeout(3000)
      } catch (error) {
        console.error('❌ ユーザー名入力に失敗:', error.message)
        await sendSlack(`❌ ユーザー名入力に失敗: ${error.message}`, slackWebhookUrl)
        throw error
      }
    } else {
      // ユーザー名入力フィールドが見つからなかった場合（スキップされた）
      console.log('ℹ️ ユーザー名入力ステップはスキップされました。パスワード入力に進みます')
      await sendSlack('ℹ️ ユーザー名入力ステップはスキップされました', slackWebhookUrl)
      // ヘッドレスモードでは追加の待機時間が必要な場合がある
      await page.waitForTimeout(isCI ? 5000 : 2000)
    }
    
    // パスワード入力モーダルを待機（より柔軟なセレクタと長めの待機時間）
    console.log('🔍 パスワード入力モーダルを待機中...')
    
    // まず、ページの状態を確認
    console.log('📄 現在のURL:', page.url())
    await page.waitForTimeout(isCI ? 3000 : 2000) // ヘッドレスモードでは追加の待機時間
    
    // 複数のセレクタパターンを試行
    const passwordModalSelectors = [
      // 日本語版
      'div[role="dialog"] h1:has-text("パスワード")',
      'div[role="dialog"] h1:has-text("パスワードを入力")',
      // 英語版
      'div[role="dialog"] h1:has-text("Enter your password")',
      'div[role="dialog"] h1:has-text("Password")',
      // パスワード入力フィールド
      'input[name="password"]',
      'input[type="password"]',
      // より一般的なパターン
      'div[role="dialog"] input[name="password"]',
      'div[role="dialog"] input[type="password"]'
    ]
    
    let passwordModalFound = false
    let foundSelector = null
    
    for (const selector of passwordModalSelectors) {
      try {
        console.log(`🔍 セレクタを試行: ${selector}`)
        await page.waitForSelector(selector, { timeout: 10000 })
        const exists = await page.locator(selector).first().isVisible({ timeout: 2000 }).catch(() => false)
        if (exists) {
          console.log(`✅ パスワード入力モーダルを検出: ${selector}`)
          passwordModalFound = true
          foundSelector = selector
          break
        }
      } catch (e) {
        console.log(`⏭️ セレクタ失敗: ${selector} - ${e.message}`)
        continue
      }
    }
    
    if (!passwordModalFound) {
      // デバッグ: ページの状態を確認
      console.error('❌ パスワード入力モーダルの検出に失敗')
      console.error('📄 現在のURL:', page.url())
      
      // ページ内のすべてのダイアログを確認
      try {
        const dialogs = await page.locator('div[role="dialog"]').all()
        console.log(`📋 見つかったダイアログの数: ${dialogs.length}`)
        for (let i = 0; i < dialogs.length; i++) {
          try {
            const dialogText = await dialogs[i].textContent()
            console.log(`   ダイアログ${i + 1}: ${dialogText?.substring(0, 100)}...`)
          } catch (e) {
            console.log(`   ダイアログ${i + 1}: テキスト取得失敗`)
          }
        }
      } catch (e) {
        console.log('⚠️ ダイアログの確認に失敗:', e.message)
      }
      
      // すべてのinput要素を確認
      try {
        const inputs = await page.locator('input').all()
        console.log(`📋 見つかったinput要素の数: ${inputs.length}`)
        for (let i = 0; i < inputs.length; i++) {
          try {
            const inputType = await inputs[i].getAttribute('type')
            const inputName = await inputs[i].getAttribute('name')
            console.log(`   input[${i}]: type="${inputType}", name="${inputName}"`)
          } catch (e) {
            console.log(`   input[${i}]: 属性取得失敗`)
          }
        }
      } catch (e) {
        console.log('⚠️ input要素の確認に失敗:', e.message)
      }
      
      // スクリーンショットを撮影
      try {
        await page.screenshot({ path: '/tmp/password_modal_not_found.png', fullPage: true })
        console.log('📸 スクリーンショットを保存: /tmp/password_modal_not_found.png')
      } catch (e) {
        console.error('スクリーンショット保存失敗:', e.message)
      }
      
      throw new Error('パスワード入力モーダルが見つかりません')
    }
    
    console.log('✅ パスワード入力モーダルを検出')
    await sendSlack('✅ パスワード入力モーダルを検出', slackWebhookUrl)
    await page.waitForTimeout(2000)
    
    // パスワード入力
    console.log('🔐 パスワードを入力')
    await page.waitForSelector('input[name="password"]', { timeout: 30000 })
    await page.fill('input[name="password"]', xPassword)
    await page.waitForTimeout(1000)
    
    // 「ログイン」ボタンをクリック
    console.log('🔘 「ログイン」ボタンをクリック')
    try {
      // 複数のセレクタを試行（日本語の「ログイン」を含む）
      const loginSelectors = [
        'button:has-text("ログイン")',
        'button[role="button"]:has-text("ログイン")',
        'button[type="button"]:has-text("ログイン")',
        'button[data-testid="LoginForm_Login_Button"]',
        'span:has-text("ログイン")',
        'div[role="button"]:has-text("ログイン")',
        // 英語版のフォールバック
        'button:has-text("Log in")',
        'span:has-text("Log in")'
      ]
      
      let loginClicked = false
      for (const selector of loginSelectors) {
        try {
          console.log(`🔍 セレクタを試行: ${selector}`)
          await page.waitForSelector(selector, { timeout: 5000 })
          // ボタンが有効になるまで待機
          const button = page.locator(selector).first()
          await button.waitFor({ state: 'visible', timeout: 5000 })
          // ボタンが無効化されていないか確認
          const isDisabled = await button.getAttribute('disabled')
          if (isDisabled === null) {
            await button.click()
            console.log(`✅ 「ログイン」ボタンをクリック: ${selector}`)
            loginClicked = true
            break
          } else {
            console.log(`⏭️ ボタンが無効化されています: ${selector}`)
          }
        } catch (e) {
          console.log(`⏭️ セレクタ失敗: ${selector} - ${e.message}`)
          continue
        }
      }
      
      if (!loginClicked) {
        // フォールバック: Enterキーを送信
        console.log('⚠️ 「ログイン」ボタンが見つからないため、Enterキーを送信')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(1000)
      }
      
      await sendSlack('🔐 パスワード入力完了', slackWebhookUrl)
      await page.waitForTimeout(5000)
    } catch (error) {
      console.error('❌ 「ログイン」ボタンのクリックに失敗:', error.message)
      await sendSlack(`❌ 「ログイン」ボタンのクリックに失敗: ${error.message}`, slackWebhookUrl)
      throw error
    }
    
    // ログインエラーメッセージをチェック
    console.log('🔍 ログインエラーメッセージをチェック中...')
    await page.waitForTimeout(2000) // エラーメッセージが表示されるまで待機
    
    try {
      const bodyText = await page.textContent('body').catch(() => '')
      const pageText = bodyText.toLowerCase()
      
      // エラーメッセージのパターンをチェック
      const errorMessages = [
        'could not log you in',
        'could not log you in now',
        'ログインできませんでした',
        'ログインに失敗しました',
        'something went wrong',
        'try again later',
        'temporarily unable',
        '一時的にログインできません',
        'suspended',
        'アカウントが停止されています',
        'locked',
        'アカウントがロックされています'
      ]
      
      let foundError = false
      let errorMessage = null
      
      for (const errorMsg of errorMessages) {
        if (pageText.includes(errorMsg.toLowerCase())) {
          foundError = true
          errorMessage = errorMsg
          break
        }
      }
      
      if (foundError) {
        console.error(`❌ ログインエラーが検出されました: ${errorMessage}`)
        // スクリーンショットを撮影
        try {
          await page.screenshot({ path: '/tmp/login_error_message.png', fullPage: true })
          console.log('📸 スクリーンショットを保存: /tmp/login_error_message.png')
        } catch (e) {
          console.error('スクリーンショット保存失敗:', e.message)
        }
        
        // エラーメッセージの詳細を取得
        try {
          const errorElements = await page.locator('div[role="alert"], div[data-testid="error"], span:has-text("could not"), span:has-text("ログイン")').all()
          for (let i = 0; i < errorElements.length; i++) {
            try {
              const errorText = await errorElements[i].textContent()
              if (errorText && errorText.length > 0) {
                console.error(`   エラーメッセージ[${i}]: ${errorText.substring(0, 200)}`)
              }
            } catch (e) {
              // 無視
            }
          }
        } catch (e) {
          console.log('⚠️ エラーメッセージの詳細取得に失敗:', e.message)
        }
        
        await sendSlack(`❌ ログインエラー: ${errorMessage}`, slackWebhookUrl)
        throw new Error(`ログインエラーが検出されました: ${errorMessage}. Xが一時的にログインを拒否している可能性があります。`)
      }
      
      console.log('✅ ログインエラーメッセージは検出されませんでした')
    } catch (error) {
      // エラーチェック自体が失敗した場合は、エラーを再スロー（ログインエラーの場合）
      if (error.message.includes('ログインエラーが検出されました')) {
        throw error
      }
      // それ以外のエラー（チェック処理のエラー）は無視して続行
      console.log('⚠️ エラーメッセージチェックに失敗しましたが、続行します:', error.message)
    }
    
    // ログイン成功の確認（URLが変わったか、ホーム画面が表示されたか）
    console.log('🔍 ログイン成功を確認中...')
    const currentUrl = page.url()
    console.log(`📄 現在のURL: ${currentUrl}`)
    
    // まだログインフローにいる場合は、ログインが完了していない可能性がある
    if (currentUrl.includes('/i/flow/login') || currentUrl.includes('/i/flow/')) {
      console.log('⚠️ まだログインフローにいます。追加の待機時間を設けます...')
      await page.waitForTimeout(5000)
      
      // 再度エラーチェック
      const bodyText2 = await page.textContent('body').catch(() => '')
      const pageText2 = bodyText2.toLowerCase()
      if (pageText2.includes('could not log you in') || pageText2.includes('ログインできませんでした')) {
        throw new Error('ログインエラーが検出されました。Xが一時的にログインを拒否している可能性があります。')
      }
      
      // URLが変わらない場合は、ログインが失敗している可能性がある
      const finalUrl = page.url()
      if (finalUrl.includes('/i/flow/login') || finalUrl.includes('/i/flow/')) {
        console.log('⚠️ ログインフローから抜け出せていません。ログインが失敗している可能性があります。')
        // しかし、エラーメッセージが見つからない場合は、単に時間がかかっているだけかもしれないので、続行
      }
    }
    
    await sendSlack('✅ ログイン完了', slackWebhookUrl)
    
    // 投稿ページへ
    console.log('📝 投稿ページにアクセス')
    try {
      await page.goto('https://x.com/compose/tweet', {
        waitUntil: 'domcontentloaded', // networkidleからdomcontentloadedに変更（より早く読み込まれる）
        timeout: 60000 // タイムアウトを60秒に短縮
      })
      console.log('✅ ページ読み込み完了')
      
      // 投稿フォームが表示されるまで待機
      console.log('🔍 投稿フォームを待機中...')
      await page.waitForSelector('div[aria-label="Tweet text"], div[aria-label="Post text"], div[data-testid="tweetTextarea_0"]', { timeout: 30000 })
      console.log('✅ 投稿フォームを検出')
      
      await sendSlack('📝 投稿画面を開きました', slackWebhookUrl)
      await page.waitForTimeout(3000)
    } catch (error) {
      console.error('❌ 投稿ページへの遷移に失敗:', error.message)
      // スクリーンショットを撮影
      try {
        await page.screenshot({ path: '/tmp/compose_error.png', fullPage: true })
        console.log('📸 スクリーンショットを保存: /tmp/compose_error.png')
      } catch (e) {
        console.error('スクリーンショット保存失敗:', e.message)
      }
      throw new Error(`投稿ページへの遷移に失敗: ${error.message}`)
    }
    
    // テキスト入力（改行や絵文字、URL、ハッシュタグを含む場合に対応）
    console.log('✍️ テキストを入力')
    try {
      // 複数のセレクタを試行
      const textAreaSelectors = [
        'div[aria-label="Tweet text"]',
        'div[aria-label="Post text"]',
        'div[data-testid="tweetTextarea_0"]',
        'div[contenteditable="true"][aria-label*="text"]'
      ]
      
      let textAreaFound = false
      let textArea = null
      for (const selector of textAreaSelectors) {
        try {
          console.log(`🔍 テキストエリアを探す: ${selector}`)
          await page.waitForSelector(selector, { timeout: 5000 })
          textArea = page.locator(selector).first()
          await textArea.waitFor({ state: 'visible', timeout: 5000 })
          console.log(`✅ テキストエリアを検出: ${selector}`)
          textAreaFound = true
          break
        } catch (e) {
          console.log(`⏭️ セレクタ失敗: ${selector} - ${e.message}`)
          continue
        }
      }
      
      if (!textAreaFound) {
        throw new Error('テキストエリアが見つかりません')
      }
      
      // 既存のテキストをクリア
      await textArea.click()
      await page.waitForTimeout(500)
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(500)
      
      // テキストを入力（改行や絵文字を含む）
      // type()メソッドを使用して、1文字ずつ入力することで改行や特殊文字にも対応
      await textArea.type(text, { delay: 50 })
      await page.waitForTimeout(2000)
      
      console.log(`✅ テキスト入力完了（${text.length}文字）`)
      await sendSlack(`✅ テキスト入力完了（${text.length}文字）`, slackWebhookUrl)
      
      // 画像アップロードはテキスト入力の前に実行する方が確実な場合がある
      // ただし、テキスト入力後に実行する方が一般的
    } catch (error) {
      console.error('❌ テキスト入力に失敗:', error.message)
      await sendSlack(`❌ テキスト入力に失敗: ${error.message}`, slackWebhookUrl)
      throw error
    }
    
    // 画像アップロード（画像がある場合のみ）
    if (hasImage) {
      console.log('🖼️ 画像をアップロード')
      console.log(`📁 画像パス: ${imagePath}`)
      try {
        // ファイルパスが存在するか確認
        const fs = require('fs')
        if (!fs.existsSync(imagePath)) {
          throw new Error(`画像ファイルが見つかりません: ${imagePath}`)
        }
        console.log(`✅ 画像ファイルを確認: ${imagePath}`)
        
        // 方法1: 直接input要素を探してファイルを設定
        console.log('🔍 ファイル入力要素を直接探す')
        const fileInputSelectors = [
          'input[data-testid="fileInput"]',
          'input[type="file"][accept*="image"]',
          'input[type="file"]'
        ]
        
        // まず、すべてのfile input要素を確認
        const allFileInputs = await page.locator('input[type="file"]').all()
        console.log(`📋 見つかったfile input要素の数: ${allFileInputs.length}`)
        
        // 各input要素の属性を確認
        for (let i = 0; i < allFileInputs.length; i++) {
          try {
            const input = allFileInputs[i]
            const dataTestId = await input.getAttribute('data-testid').catch(() => null)
            const accept = await input.getAttribute('accept').catch(() => null)
            const className = await input.getAttribute('class').catch(() => null)
            console.log(`   input[${i}]: data-testid="${dataTestId}", accept="${accept}", class="${className?.substring(0, 50)}"`)
          } catch (e) {
            console.log(`   input[${i}]: 属性取得失敗 - ${e.message}`)
          }
        }
        
        let fileInputFound = false
        for (const selector of fileInputSelectors) {
          try {
            console.log(`🔍 ファイル入力要素を探す: ${selector}`)
            
            // 特定のセレクタで要素を探す
            const fileInput = page.locator(selector).first()
            
            // 要素が存在するか確認
            const count = await fileInput.count()
            if (count > 0) {
              console.log(`✅ file input要素が見つかりました: ${selector} (${count}個)`)
              
              // ファイルが存在するか再確認
              const fs = require('fs')
              if (!fs.existsSync(imagePath)) {
                throw new Error(`画像ファイルが見つかりません: ${imagePath}`)
              }
              
              const fileStats = fs.statSync(imagePath)
              console.log(`   ファイルサイズ: ${fileStats.size} bytes`)
              
              // ファイルを設定（表示されていなくてもsetInputFilesは動作する）
              await fileInput.setInputFiles(imagePath)
              console.log(`✅ 画像ファイルを設定: ${selector}`)
              console.log(`   ファイルパス: ${imagePath}`)
              fileInputFound = true
              break
            } else {
              console.log(`⏭️ 要素が見つかりません: ${selector}`)
            }
          } catch (e) {
            console.log(`⏭️ セレクタ失敗: ${selector} - ${e.message}`)
            continue
          }
        }
        
        // 方法2: ボタンをクリックしてからファイルを選択（ヘッドレスモードでも動作）
        // 注意: setInputFilesはヘッドレスモードでも動作しますが、input要素が存在しない場合は
        // ボタンをクリックしてinput要素を表示させる必要があります
        if (!fileInputFound) {
          console.log('⚠️ 直接input要素が見つからないため、ボタンをクリックしてからアップロード')
          console.log('💡 ヘッドレスモードでも動作します（setInputFilesはヘッドレス対応）')
          
          const addPhotoButtonSelectors = [
            'button[aria-label="Add photos or video"]',
            'button[aria-label="写真や動画を追加"]',
            'button[data-testid="toolBar"] button:first-child',
            'button[role="button"]:has(svg)',
            'nav[aria-live="polite"] button:first-child'
          ]
          
          let buttonClicked = false
          for (const selector of addPhotoButtonSelectors) {
            try {
              console.log(`🔍 ボタンを探す: ${selector}`)
              const button = page.locator(selector).first()
              await button.waitFor({ state: 'visible', timeout: 5000 })
              
              // ボタンをクリック（ヘッドレスモードでも動作）
              await button.click()
              console.log(`✅ ボタンをクリック: ${selector}`)
              buttonClicked = true
              
              // ボタンクリック後に少し待機（input要素が表示されるまで）
              await page.waitForTimeout(1000)
              
              // ボタンクリック後に表示されるinput要素を探す
              console.log('🔍 ボタンクリック後のファイル入力要素を探す')
              
              // すべてのfile input要素を再確認
              const allFileInputsAfter = await page.locator('input[type="file"]').all()
              console.log(`📋 ボタンクリック後のfile input要素の数: ${allFileInputsAfter.length}`)
              
              for (const selector2 of fileInputSelectors) {
                try {
                  console.log(`🔍 ファイル入力要素を探す: ${selector2}`)
                  const fileInput = page.locator(selector2).first()
                  const count2 = await fileInput.count()
                  
                  if (count2 > 0) {
                    console.log(`✅ file input要素が見つかりました: ${selector2} (${count2}個)`)
                    await fileInput.setInputFiles(imagePath)
                    console.log(`✅ 画像をアップロード（ボタン経由）: ${selector2}`)
                    fileInputFound = true
                    break
                  }
                } catch (e) {
                  console.log(`⏭️ セレクタ失敗: ${selector2} - ${e.message}`)
                  continue
                }
              }
              
              if (fileInputFound) {
                break
              }
            } catch (e) {
              console.log(`⏭️ セレクタ失敗: ${selector} - ${e.message}`)
              continue
            }
          }
        }
        
        // 方法3: すべてのfile input要素を試行
        if (!fileInputFound) {
          console.log('⚠️ 特定のセレクタで見つからないため、すべてのfile input要素を試行')
          const allFileInputs = await page.locator('input[type="file"]').all()
          console.log(`📋 見つかったfile input要素の総数: ${allFileInputs.length}`)
          
          for (let i = 0; i < allFileInputs.length; i++) {
            try {
              console.log(`🔍 file input要素 ${i + 1}/${allFileInputs.length} を試行`)
              const fileInput = allFileInputs[i]
              
              // 要素の属性を確認
              const dataTestId = await fileInput.getAttribute('data-testid').catch(() => null)
              const accept = await fileInput.getAttribute('accept').catch(() => null)
              console.log(`   属性: data-testid="${dataTestId}", accept="${accept}"`)
              
              // ファイルを設定
              await fileInput.setInputFiles(imagePath)
              console.log(`✅ 画像をアップロード（全要素試行 ${i + 1}）`)
              fileInputFound = true
              break
            } catch (e) {
              console.log(`⏭️ file input要素 ${i + 1} が失敗: ${e.message}`)
              continue
            }
          }
        }
        
        if (!fileInputFound) {
          throw new Error('ファイル入力要素が見つかりませんでした。画像をアップロードできませんでした。')
        }
        
        // 画像のアップロードが完了するまで待機（画像プレビューが表示されるまで）
        console.log('⏳ 画像のアップロード完了を待機中...')
        await page.waitForTimeout(3000)
        
        // 画像アップロードの進捗を確認（プログレスバーなど）
        try {
          const progressBar = await page.locator('div[role="progressbar"]').first().isVisible({ timeout: 2000 }).catch(() => false)
          if (progressBar) {
            console.log('⏳ 画像アップロード中（プログレスバーを確認）...')
            // プログレスバーが消えるまで待機（最大30秒）
            await page.waitForSelector('div[role="progressbar"]', { state: 'hidden', timeout: 30000 }).catch(() => {
              console.log('⚠️ プログレスバーの待機がタイムアウトしました')
            })
            console.log('✅ プログレスバーが消えました')
            await page.waitForTimeout(2000)
          }
        } catch (e) {
          console.log('⚠️ プログレスバーの確認に失敗:', e.message)
        }
        
        // 画像プレビューが表示されているか確認（最大30秒待機）
        console.log('🔍 画像プレビューを確認中...')
        const imagePreviewSelectors = [
          'img[alt*="image"]',
          'img[alt*="Image"]',
          'img[src*="media"]',
          'div[data-testid*="media"]',
          'div[data-testid*="mediaPreview"]',
          'div[data-testid*="attachments"]',
          'div[aria-label*="Image"]',
          'div[aria-label*="画像"]'
        ]
        
        let previewFound = false
        let previewSelector = null
        
        // 最大30秒間、画像プレビューが表示されるまで待機
        const maxWaitTime = 30000
        const checkInterval = 1000
        const startTime = Date.now()
        
        while (Date.now() - startTime < maxWaitTime && !previewFound) {
          for (const selector of imagePreviewSelectors) {
            try {
              const preview = await page.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false)
              if (preview) {
                console.log(`✅ 画像プレビューを確認: ${selector}`)
                previewFound = true
                previewSelector = selector
                break
              }
            } catch (e) {
              continue
            }
          }
          
          if (!previewFound) {
            await page.waitForTimeout(checkInterval)
            const elapsed = Math.floor((Date.now() - startTime) / 1000)
            if (elapsed % 5 === 0) {
              console.log(`⏳ 画像プレビュー待機中... (${elapsed}秒)`)
            }
          }
        }
        
        if (!previewFound) {
          console.log('⚠️ 画像プレビューが見つかりませんでした')
          // スクリーンショットを撮影して確認
          await page.screenshot({ path: '/tmp/image_upload_check.png', fullPage: true })
          console.log('📸 スクリーンショットを保存: /tmp/image_upload_check.png')
          
          // エラーとして扱うか、警告のみにするか
          // ローカルテスト時は警告のみ、GitHub Actions実行時はエラー
          if (process.env.CI === 'true') {
            throw new Error('画像プレビューが表示されませんでした。画像のアップロードに失敗した可能性があります。')
          } else {
            console.log('⚠️ ローカルテスト時は警告のみで続行します')
          }
        } else {
          console.log(`✅ 画像アップロード完了（プレビュー確認: ${previewSelector}）`)
        }
        
        // 画像アップロード後に表示される見えないオーバーレイやモーダルを解除
        console.log('🖱️ 画像アップロード後のオーバーレイを解除中...')
        // 注意: ESCキーはDraftsモーダルを開く可能性があるため、使用しない
        
        try {
          // 方法1: テキストエリアをクリックしてフォーカスを外す
          const textAreaSelectors = [
            'div[aria-label="Tweet text"]',
            'div[aria-label="Post text"]',
            'div[data-testid="tweetTextarea_0"]'
          ]
          
          for (const selector of textAreaSelectors) {
            try {
              const textArea = page.locator(selector).first()
              const exists = await textArea.isVisible({ timeout: 2000 }).catch(() => false)
              if (exists) {
                await textArea.click({ force: true })
                await page.waitForTimeout(500)
                console.log(`✅ テキストエリアをクリックしました: ${selector}`)
                break
              }
            } catch (e) {
              continue
            }
          }
        } catch (e) {
          console.log('⚠️ テキストエリアのクリックに失敗:', e.message)
        }
        
        try {
          // 方法2: ページの何もない部分（body）をクリックしてフォーカスを外す
          await page.click('body', { position: { x: 100, y: 100 }, force: true })
          await page.waitForTimeout(500)
          console.log('✅ ページの何もない部分をクリックしました')
        } catch (e) {
          console.log('⚠️ ページクリックに失敗:', e.message)
        }
        
        try {
          // 方法3: Tabキーでフォーカスを移動（Postボタンに向かう）
          // ただし、Draftボタンにフォーカスが当たらないように注意
          await page.keyboard.press('Tab')
          await page.waitForTimeout(300)
          console.log('✅ Tabキーでフォーカスを移動しました')
        } catch (e) {
          console.log('⚠️ Tabキーの送信に失敗:', e.message)
        }
        
        // 「Save Post?」モーダルやDraftsモーダルが開いていないか確認
        try {
          // 「Save Post?」モーダルを検出
          const savePostModal = await page.locator('div[role="dialog"]:has-text("Save Post"), div[role="dialog"]:has-text("Save Post?"), h1:has-text("Save Post"), h1:has-text("Save Post?")').first().isVisible({ timeout: 1000 }).catch(() => false)
          if (savePostModal) {
            console.log('⚠️ "Save Post?"モーダルが開いています。閉じます...')
            // ESCキーではなく、画面をクリックして閉じる
            try {
              // モーダルの外側をクリック
              await page.click('body', { position: { x: 100, y: 100 }, force: true })
              await page.waitForTimeout(500)
              console.log('✅ 画面をクリックしてモーダルを閉じました')
            } catch (e) {
              // クリックで閉じられない場合は「Don't save」ボタンを探す
              try {
                const dontSaveButton = await page.locator('button:has-text("Don\'t save"), button:has-text("保存しない"), button:has-text("Cancel"), button:has-text("キャンセル")').first()
                const exists = await dontSaveButton.isVisible({ timeout: 2000 }).catch(() => false)
                if (exists) {
                  await dontSaveButton.click()
                  await page.waitForTimeout(500)
                  console.log('✅ "Don\'t save"ボタンをクリックしてモーダルを閉じました')
                }
              } catch (e2) {
                console.log('⚠️ モーダルを閉じる処理に失敗:', e2.message)
              }
            }
          }
          
          // Draftsモーダルを検出
          const draftsModal = await page.locator('div[role="dialog"]:has-text("Drafts"), div[role="dialog"]:has-text("下書き")').first().isVisible({ timeout: 1000 }).catch(() => false)
          if (draftsModal) {
            console.log('⚠️ Draftsモーダルが開いています。閉じます...')
            // ESCキーではなく、画面をクリックして閉じる
            try {
              await page.click('body', { position: { x: 100, y: 100 }, force: true })
              await page.waitForTimeout(500)
              console.log('✅ 画面をクリックしてDraftsモーダルを閉じました')
            } catch (e) {
              console.log('⚠️ Draftsモーダルを閉じる処理に失敗:', e.message)
            }
          }
        } catch (e) {
          console.log('ℹ️ モーダルの確認をスキップしました')
        }
        
        await sendSlack('🖼️ 画像アップロード完了', slackWebhookUrl)
        await page.waitForTimeout(1000) // オーバーレイ解除のための追加待機
      } catch (error) {
        console.error('❌ 画像アップロードに失敗:', error.message)
        console.error(`   画像パス: ${imagePath}`)
        await sendSlack(`❌ 画像アップロードに失敗: ${error.message}`, slackWebhookUrl)
        throw error
      }
    } else {
      console.log('ℹ️ 画像なしで投稿します（ローカルテスト）')
      await sendSlack('ℹ️ 画像なしで投稿します（ローカルテスト）', slackWebhookUrl)
    }
    
    // 投稿ボタンをクリック
    console.log('🚀 投稿ボタンをクリック')
    try {
      // まず投稿ボタンが有効になるまで待機
      console.log('⏳ 投稿ボタンが有効になるまで待機中...')
      
      // より確実にPostボタンを見つけるためのセレクタ（Draftボタンを確実に除外）
      // 優先順位: data-testid > テキスト検証
      const postButtonSelectors = [
        // 方法1: data-testidで探す（最も確実で優先）
        'button[data-testid="tweetButton"]',
        'button[data-testid="tweetButtonInline"]',
      ]
      
      // 最初にdata-testidで探す（Draftボタンと誤認されない）
      let button = null
      let buttonSelector = null
      
      for (const selector of postButtonSelectors) {
        try {
          const testButton = page.locator(selector).first()
          const exists = await testButton.isVisible({ timeout: 3000 }).catch(() => false)
          if (exists) {
            button = testButton
            buttonSelector = selector
            console.log(`✅ Postボタンを見つけました（data-testid）: ${selector}`)
            break
          }
        } catch (e) {
          continue
        }
      }
      
      // data-testidで見つからない場合のみ、テキストベースで探す
      if (!button) {
        console.log('⚠️ data-testidで見つからないため、テキストベースで検索します（Draftボタンに注意）')
        const textBasedSelectors = [
          // 「Post」テキストを含むspan要素から親のbuttonを探す（Draftを除外するため、JavaScriptで検証）
          'span:has-text("Post")',
          'span:has-text("ポスト")',
          // テキストを含むボタン（Draftを除外するため、JavaScriptで検証）
          'button:has-text("Post")',
          'button:has-text("ポスト")',
          // ボタン内のspan要素（Draftを除外するため、JavaScriptで検証）
          'button:has(span:has-text("Post"))',
          'button:has(span:has-text("ポスト"))',
          // role属性（Draftを除外するため、JavaScriptで検証）
          'button[role="button"]:has-text("Post")',
          'button[type="button"]:has-text("Post")'
        ]
        
        // テキストベースのセレクタで探す
        let buttonElement = null
        
        for (const selector of textBasedSelectors) {
          try {
            console.log(`🔍 投稿ボタンを探す: ${selector}`)
            
            // 「Post」テキストを含むspan要素から親のbuttonを探す場合
            if (selector.startsWith('span:has-text')) {
              const span = page.locator(selector).first()
              const spanExists = await span.isVisible({ timeout: 3000 }).catch(() => false)
              
              if (spanExists) {
                console.log(`✅ "Post"テキストを含む要素が見つかりました`)
                // 親のbutton要素を探す（Draftボタンを除外）
                buttonElement = await page.evaluate((text) => {
                  // すべてのspan要素を探す
                  const spans = Array.from(document.querySelectorAll('span'))
                  for (const span of spans) {
                    const textContent = span.textContent || ''
                    // 「Post」または「ポスト」を含み、「Draft」や「Drafts」を含まないことを確認
                    if ((textContent.includes('Post') || textContent.includes('ポスト')) && 
                        !textContent.includes('Draft') && 
                        !textContent.includes('Drafts') &&
                        textContent.trim() !== 'Draft' &&
                        textContent.trim() !== 'Drafts') {
                      // 親要素をたどってbutton要素を探す
                      let current = span.parentElement
                      for (let i = 0; i < 5 && current; i++) {
                        if (current.tagName === 'BUTTON') {
                          // ボタンのテキストも確認（Draftを除外）
                          const buttonText = current.textContent || ''
                          if (!buttonText.includes('Draft') && !buttonText.includes('Drafts')) {
                            return current
                          }
                        }
                        current = current.parentElement
                      }
                    }
                  }
                  return null
                }, 'Post')
                
                if (buttonElement) {
                  button = page.locator(`button:has(span:has-text("Post"))`).first()
                  buttonSelector = selector
                  console.log(`✅ 投稿ボタンを見つけました（span経由）`)
                  break
                }
              }
            } else {
              // 通常のセレクタで探す（Draftボタンを除外）
              button = page.locator(selector).first()
              const buttonExists = await button.isVisible({ timeout: 5000 }).catch(() => false)
              
              if (buttonExists) {
                // ボタンのテキストを確認してDraftボタンを除外
                const buttonText = await button.textContent().catch(() => '')
                if (buttonText && 
                    (buttonText.includes('Post') || buttonText.includes('ポスト')) &&
                    !buttonText.includes('Draft') && 
                    !buttonText.includes('Drafts') &&
                    buttonText.trim() !== 'Draft' &&
                    buttonText.trim() !== 'Drafts') {
                  buttonSelector = selector
                  console.log(`✅ 投稿ボタンが見つかりました: ${selector} (テキスト: "${buttonText.trim()}")`)
                } else {
                  console.log(`⏭️ Draftボタンを除外しました: ${selector} (テキスト: "${buttonText.trim()}")`)
                  continue
                }
              }
            }
            
            if (buttonSelector) {
              // ボタンが有効になるまで待機（最大10秒）
              let attempts = 0
              const maxAttempts = 20
              while (attempts < maxAttempts) {
                const isDisabled = await button.getAttribute('disabled')
                const ariaDisabled = await button.getAttribute('aria-disabled')
                
                if (isDisabled === null && ariaDisabled !== 'true') {
                  console.log(`✅ 投稿ボタンが有効になりました: ${selector}`)
                  break
                } else {
                  console.log(`⏳ ボタンがまだ無効です... (${attempts + 1}/${maxAttempts})`)
                  await page.waitForTimeout(500)
                  attempts++
                }
              }
              
              if (attempts < maxAttempts) {
                break
              } else {
                buttonSelector = null
                button = null
              }
            }
          } catch (e) {
            console.log(`⏭️ セレクタ失敗: ${selector} - ${e.message}`)
            continue
          }
        }
      }
      
      // ボタンが見つからない場合、デバッグ情報を出力
      if (!button || !buttonSelector) {
        console.error('❌ 投稿ボタンが見つかりませんでした')
        console.error('📸 デバッグ用のスクリーンショットを撮影します...')
        await page.screenshot({ path: '/tmp/post_button_not_found.png', fullPage: true })
        console.error('📸 スクリーンショットを保存: /tmp/post_button_not_found.png')
        
        // ページ内のすべてのボタンを確認
        const allButtons = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'))
          return buttons.map(btn => ({
            text: btn.textContent?.trim().substring(0, 50),
            disabled: btn.hasAttribute('disabled'),
            ariaDisabled: btn.getAttribute('aria-disabled'),
            testId: btn.getAttribute('data-testid'),
            role: btn.getAttribute('role')
          }))
        })
        
        console.error('📋 ページ内のすべてのボタン:')
        allButtons.forEach((btn, i) => {
          if (btn.text && (btn.text.includes('Post') || btn.text.includes('ポスト') || btn.text.includes('Tweet'))) {
            console.error(`   ボタン${i + 1}: ${JSON.stringify(btn)}`)
          }
        })
        
        throw new Error('投稿ボタンが見つからないか、有効になりませんでした')
      }
      
      // 画像アップロードが完了しているか再確認（画像がある場合）
      if (hasImage) {
        console.log('🖼️ 画像アップロード完了を再確認中...')
        
        // プログレスバーが消えるまで待機（より長く待つ）
        try {
          console.log('⏳ 画像アップロードのプログレスバーを確認中...')
          // プログレスバーが存在するか確認
          const progressBarExists = await page.locator('div[role="progressbar"]').count()
          if (progressBarExists > 0) {
            console.log(`⏳ 画像のアップロードが進行中です（プログレスバー: ${progressBarExists}個）。完了を待機します...`)
            // プログレスバーが消えるまで最大60秒待機
            await page.waitForSelector('div[role="progressbar"]', { state: 'hidden', timeout: 60000 }).catch(() => {
              console.log('⚠️ プログレスバーの待機がタイムアウトしました（画像のアップロードは完了している可能性があります）')
            })
            console.log('✅ プログレスバーが消えました（画像アップロード完了）')
            await page.waitForTimeout(3000) // 追加の待機時間
          } else {
            console.log('✅ プログレスバーは既に消えています')
          }
        } catch (e) {
          console.log('ℹ️ プログレスバーの確認をスキップしました:', e.message)
        }
        
        // 画像プレビューが表示されているか確認（より確実に）
        console.log('🔍 画像プレビューを確認中...')
        let previewFound = false
        const previewSelectors = [
          'img[data-testid="mediaPreview"]',
          'img[alt*="image"]',
          'img[alt*="Image"]',
          'div[data-testid*="media"]',
          'div[data-testid*="mediaPreview"]',
          'div[data-testid*="attachments"]'
        ]
        
        for (const selector of previewSelectors) {
          try {
            const preview = await page.locator(selector).first().isVisible({ timeout: 5000 }).catch(() => false)
            if (preview) {
              console.log(`✅ 画像のプレビューを確認しました: ${selector}`)
              previewFound = true
              break
            }
          } catch (e) {
            continue
          }
        }
        
        if (!previewFound) {
          console.log('⚠️ 画像のプレビューが見つかりませんでした（画像なしで投稿を試行）')
        }
        
        // 画像の検証が完了するまで待機（画像アップロード後、Xが画像を検証する処理がある）
        console.log('⏳ 画像の検証が完了するまで待機中...')
        await page.waitForTimeout(5000) // 画像検証のための追加待機時間
        
        // 画像エラーや警告がないか確認
        try {
          const errorElements = await page.locator('div[role="alert"], div[data-testid*="error"], div:has-text("画像"), div:has-text("image")').all()
          for (const errorEl of errorElements) {
            const text = await errorEl.textContent().catch(() => '')
            if (text && (text.toLowerCase().includes('error') || text.toLowerCase().includes('エラー') || text.toLowerCase().includes('失敗'))) {
              console.error(`❌ 画像エラーが検出されました: ${text}`)
              throw new Error(`画像エラー: ${text}`)
            }
          }
        } catch (e) {
          if (e.message.includes('画像エラー')) {
            throw e
          }
          console.log('ℹ️ 画像エラーの確認をスキップしました')
        }
      }
      
      // ボタンが有効になっているか再確認（画像アップロード後）
      console.log('🔍 投稿ボタンの状態を再確認中...')
      
      // ボタンを再検索（画像アップロード後、DOMが更新されている可能性がある）
      if (hasImage) {
        console.log('🔄 画像アップロード後、Postボタンを再検索中...')
        // ボタンを再検索
        for (const selector of postButtonSelectors) {
          try {
            const newButton = page.locator(selector).first()
            const exists = await newButton.isVisible({ timeout: 3000 }).catch(() => false)
            if (exists) {
              button = newButton
              buttonSelector = selector
              console.log(`✅ Postボタンを再検索しました: ${selector}`)
              break
            }
          } catch (e) {
            continue
          }
        }
      }
      
      const isDisabled = await button.getAttribute('disabled').catch(() => 'unknown')
      const ariaDisabled = await button.getAttribute('aria-disabled').catch(() => 'unknown')
      
      console.log(`📊 ボタンの状態: disabled="${isDisabled}", aria-disabled="${ariaDisabled}"`)
      
      if (isDisabled !== null && isDisabled !== 'unknown' || ariaDisabled === 'true') {
        console.log('⚠️ 投稿ボタンが無効になっています。有効になるまで待機します...')
        
        // 最大60秒間、ボタンが有効になるまで待機（画像検証に時間がかかる場合がある）
        let waitAttempts = 0
        const maxWaitAttempts = 120 // 60秒（500ms × 120）
        while (waitAttempts < maxWaitAttempts) {
          await page.waitForTimeout(500)
          
          // ボタンを再検索（DOMが更新されている可能性がある）
          let currentButton = button
          for (const selector of postButtonSelectors) {
            try {
              const newButton = page.locator(selector).first()
              const exists = await newButton.isVisible({ timeout: 1000 }).catch(() => false)
              if (exists) {
                currentButton = newButton
                break
              }
            } catch (e) {
              continue
            }
          }
          
          const isDisabled2 = await currentButton.getAttribute('disabled').catch(() => 'unknown')
          const ariaDisabled2 = await currentButton.getAttribute('aria-disabled').catch(() => 'unknown')
          
          console.log(`   試行 ${waitAttempts + 1}/${maxWaitAttempts}: disabled="${isDisabled2}", aria-disabled="${ariaDisabled2}"`)
          
          if ((isDisabled2 === null || isDisabled2 === 'unknown') && ariaDisabled2 !== 'true') {
            console.log('✅ 投稿ボタンが有効になりました')
            button = currentButton
            break
          }
          
          waitAttempts++
          if (waitAttempts % 20 === 0) {
            console.log(`⏳ 投稿ボタンの有効化を待機中... (${waitAttempts}/${maxWaitAttempts})`)
            // デバッグ: ボタンの状態を詳しく確認
            const buttonInfo = await page.evaluate((selector) => {
              const btn = document.querySelector(selector) || Array.from(document.querySelectorAll('button')).find(b => {
                const text = b.textContent || ''
                return text.includes('Post') || text.includes('ポスト')
              })
              if (!btn) return null
              return {
                text: btn.textContent?.trim(),
                disabled: btn.hasAttribute('disabled'),
                ariaDisabled: btn.getAttribute('aria-disabled'),
                class: btn.className,
                style: btn.style.cssText
              }
            }, buttonSelector || postButtonSelectors[0]).catch(() => null)
            
            if (buttonInfo) {
              console.log(`   ボタン情報: ${JSON.stringify(buttonInfo)}`)
            }
          }
        }
        
        // 最終確認
        const isDisabledFinal = await button.getAttribute('disabled').catch(() => 'unknown')
        const ariaDisabledFinal = await button.getAttribute('aria-disabled').catch(() => 'unknown')
        
        console.log(`📊 最終確認: disabled="${isDisabledFinal}", aria-disabled="${ariaDisabledFinal}"`)
        
        if ((isDisabledFinal !== null && isDisabledFinal !== 'unknown') || ariaDisabledFinal === 'true') {
          console.error('❌ 投稿ボタンが無効のままです')
          console.error('   テキストまたは画像に問題がある可能性があります')
          console.error('   スクリーンショットを撮影します...')
          await page.screenshot({ path: '/tmp/post_button_disabled.png', fullPage: true })
          
          // デバッグ情報を出力
          const debugInfo = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'))
            return buttons.filter(btn => {
              const text = btn.textContent || ''
              return text.includes('Post') || text.includes('ポスト') || text.includes('Tweet')
            }).map(btn => ({
              text: btn.textContent?.trim(),
              disabled: btn.hasAttribute('disabled'),
              ariaDisabled: btn.getAttribute('aria-disabled'),
              testId: btn.getAttribute('data-testid')
            }))
          })
          
          console.error('📋 関連するボタンの状態:')
          debugInfo.forEach((info, i) => {
            console.error(`   ボタン${i + 1}: ${JSON.stringify(info)}`)
          })
          
          throw new Error('投稿ボタンが無効のままです。テキストまたは画像に問題がある可能性があります')
        }
      }
      
      // ボタンをクリック（複数の方法を試行）
      console.log(`🔘 投稿ボタンをクリック: ${buttonSelector}`)
      let clickSuccess = false
      
      // 方法1: 通常のクリック
      try {
        await button.click({ timeout: 10000 })
        console.log('✅ 投稿ボタンをクリックしました（通常のクリック）')
        clickSuccess = true
      } catch (e) {
        console.log(`⚠️ 通常のクリックが失敗: ${e.message}`)
      }
      
      // 方法2: forceクリック
      if (!clickSuccess) {
        try {
          await button.click({ force: true, timeout: 10000 })
          console.log('✅ 投稿ボタンをクリックしました（forceクリック）')
          clickSuccess = true
        } catch (e) {
          console.log(`⚠️ forceクリックが失敗: ${e.message}`)
        }
      }
      
      // 方法3: JavaScriptで「Post」テキストを含むボタンを直接探してクリック
      if (!clickSuccess) {
        try {
          console.log('⚠️ 通常のクリックが失敗したため、JavaScriptで「Post」テキストを含むボタンを探してクリック')
          const clicked = await page.evaluate(() => {
            // すべてのボタンを探す
            const buttons = Array.from(document.querySelectorAll('button'))
            
            // 「Post」テキストを含むボタンを探す（Draftボタンを除外）
            for (const btn of buttons) {
              const text = btn.textContent || ''
              const isDisabled = btn.hasAttribute('disabled')
              const ariaDisabled = btn.getAttribute('aria-disabled')
              
              // 「Post」テキストを含み、無効でないボタンを探す（Draftを除外）
              if ((text.includes('Post') || text.includes('ポスト')) && 
                  !text.includes('Draft') && 
                  !text.includes('Drafts') &&
                  text.trim() !== 'Draft' &&
                  text.trim() !== 'Drafts' &&
                  !isDisabled && 
                  ariaDisabled !== 'true') {
                // スクロールして表示
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
                // 少し待ってからクリック
                setTimeout(() => {
                  btn.click()
                }, 100)
                return true
              }
            }
            
            // data-testidで探す（フォールバック）
            const testIdButtons = document.querySelectorAll('button[data-testid="tweetButton"], button[data-testid="tweetButtonInline"]')
            for (const btn of testIdButtons) {
              const isDisabled = btn.hasAttribute('disabled')
              const ariaDisabled = btn.getAttribute('aria-disabled')
              if (!isDisabled && ariaDisabled !== 'true') {
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
                setTimeout(() => {
                  btn.click()
                }, 100)
                return true
              }
            }
            
            return false
          })
          
          if (clicked) {
            console.log('✅ 投稿ボタンをクリック（JavaScript経由）')
            await page.waitForTimeout(2000)
            clickSuccess = true
          } else {
            throw new Error('JavaScriptでもクリックできませんでした')
          }
        } catch (e) {
          console.log(`⚠️ JavaScriptクリックが失敗: ${e.message}`)
        }
      }
      
      // 方法4: 座標を指定してクリック
      if (!clickSuccess) {
        try {
          console.log('⚠️ 他の方法が失敗したため、座標を指定してクリック')
          const box = await button.boundingBox()
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
            console.log('✅ 投稿ボタンをクリック（座標指定）')
            await page.waitForTimeout(1000)
            clickSuccess = true
          }
        } catch (e) {
          console.log(`⚠️ 座標指定クリックが失敗: ${e.message}`)
        }
      }
      
      if (!clickSuccess) {
        throw new Error('すべてのクリック方法が失敗しました')
      }
      
      await sendSlack('🚀 投稿ボタンをクリックしました', slackWebhookUrl)
      
      // 投稿処理が完了するまで待機
      console.log('⏳ 投稿処理の完了を待機中...')
      await page.waitForTimeout(5000)
      
      // 投稿が完了したか確認
      console.log('🔍 投稿完了を確認中...')
      let postSuccess = false
      
      // 方法1: URLが変更されたか確認（最も確実）
      try {
        const currentUrl = page.url()
        console.log(`📍 現在のURL: ${currentUrl}`)
        
        // 投稿画面からホーム画面に戻ったか確認
        // /compose/tweet や /compose/post から /home や / に移動したら成功
        if (!currentUrl.includes('/compose/')) {
          console.log('✅ 投稿画面から移動しました（投稿成功）')
          postSuccess = true
        } else {
          console.log('⚠️ まだ投稿画面にいます（投稿が完了していない可能性）')
        }
      } catch (e) {
        console.log('⚠️ URL確認に失敗:', e.message)
      }
      
      // 方法2: 投稿フォームが消えているか確認
      if (!postSuccess) {
        try {
          // フォームが存在するか確認
          const formExists = await page.locator('div[aria-label="Post text"], div[aria-label="Tweet text"]').first().isVisible({ timeout: 3000 }).catch(() => false)
          if (!formExists) {
            console.log('✅ 投稿フォームが消えました（投稿成功の可能性）')
            postSuccess = true
          } else {
            console.log('⚠️ 投稿フォームがまだ表示されています')
          }
        } catch (e) {
          console.log('⚠️ 投稿フォーム確認中にエラー:', e.message)
        }
      }
      
      // 方法3: 投稿フォームのテキストが空になっているか確認
      if (!postSuccess) {
        try {
          const textArea = page.locator('div[aria-label="Post text"], div[aria-label="Tweet text"]').first()
          const textContent = await textArea.textContent().catch(() => '')
          if (!textContent || textContent.trim() === '' || textContent.trim() === 'What\'s happening?') {
            console.log('✅ 投稿フォームのテキストが空になりました（投稿成功の可能性）')
            // ただし、URLがまだ /compose/ の場合は投稿が完了していない可能性がある
            const currentUrl = page.url()
            if (!currentUrl.includes('/compose/')) {
              postSuccess = true
            } else {
              console.log('⚠️ テキストは空だが、まだ投稿画面にいます')
            }
          } else {
            console.log(`⚠️ 投稿フォームにまだテキストがあります: ${textContent.substring(0, 50)}...`)
          }
        } catch (e) {
          console.log('⚠️ テキスト確認に失敗:', e.message)
        }
      }
      
      // 方法4: 成功メッセージや通知を確認
      if (!postSuccess) {
        try {
          // 成功通知やトーストメッセージを探す
          const successIndicators = [
            'div[role="alert"]',
            'div[data-testid="toast"]',
            'div:has-text("Your post was sent")',
            'div:has-text("投稿しました")'
          ]
          
          for (const indicator of successIndicators) {
            try {
              const element = await page.waitForSelector(indicator, { timeout: 2000 })
              if (element) {
                console.log(`✅ 成功メッセージを確認: ${indicator}`)
                postSuccess = true
                break
              }
            } catch (e) {
              // 見つからない場合は次のを試す
              continue
            }
          }
        } catch (e) {
          console.log('⚠️ 成功メッセージ確認に失敗:', e.message)
        }
      }
      
      // 最終確認: URLが /compose/ のままの場合は投稿が完了していない可能性が高い
      const finalUrl = page.url()
      if (finalUrl.includes('/compose/')) {
        console.error('❌ 投稿が完了していません。URLがまだ投稿画面を示しています')
        console.error(`   現在のURL: ${finalUrl}`)
        postSuccess = false
      }
      
      if (postSuccess) {
        await sendSlack(`✅ 投稿成功: ${text.substring(0, 50)}...`, slackWebhookUrl)
        console.log('✅ 投稿成功')
      } else {
        // 投稿が完了したかどうか不明な場合、エラーとして扱う
        console.error('❌ 投稿完了の確認ができませんでした')
        console.error(`   現在のURL: ${finalUrl}`)
        await sendSlack(`❌ 投稿ボタンをクリックしましたが、投稿完了の確認ができませんでした。URL: ${finalUrl}`, slackWebhookUrl)
        throw new Error('投稿完了の確認ができませんでした')
      }
    } catch (error) {
      console.error('❌ 投稿ボタンのクリックに失敗:', error.message)
      await sendSlack(`❌ 投稿ボタンのクリックに失敗: ${error.message}`, slackWebhookUrl)
      throw error
    }
    
  } catch (error) {
    console.error('❌ 投稿失敗:', error)
    await sendSlack(`❌ 投稿失敗: ${error.message}`, slackWebhookUrl)
    throw error
  } finally {
    if (browser) {
      await browser.close()
    }
    
    // 一時ファイルを削除（画像がある場合のみ）
    if (hasImage && imagePath) {
      try {
        await unlink(imagePath)
      } catch (e) {
        console.error('ファイル削除エラー:', e)
      }
    }
  }
}

// 実行
postToX().catch(error => {
  console.error('エラー:', error)
  process.exit(1)
})
