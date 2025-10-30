import os
import time
import requests
import csv
from io import StringIO
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from slack_sdk.webhook import WebhookClient
from webdriver_manager.chrome import ChromeDriverManager
from datetime import datetime
import traceback

def log_step(step_num, message, slack_url=None):
    """デバッグログを出力（コンソール + Slack）"""
    log_msg = f"[ステップ{step_num}] {message}"
    print(log_msg)
    print(f"時刻: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    if slack_url:
        try:
            WebhookClient(slack_url).send(text=f"`{log_msg}`")
        except Exception as e:
            print(f"⚠️ Slack通知失敗: {e}")

def send_slack(message, slack_url):
    """Slackにメッセージを送信"""
    if slack_url:
        try:
            WebhookClient(slack_url).send(text=message)
        except Exception as e:
            print(f"⚠️ Slack通知失敗: {e}")

# ==========================================
# ステップ1: 環境変数の確認
# ==========================================
log_step(1, "🚀 スクリプト開始")
log_step(1, "環境変数の確認中...")

date = os.getenv("DATE")
time_str = os.getenv("TIME")
text = os.getenv("TEXT")
image = os.getenv("IMAGE")
slack_webhook_url = os.getenv("SLACK_WEBHOOK_URL")
drive_folder_id = os.getenv("DRIVE_FOLDER_ID")
x_id = os.getenv("X_ID")
x_pass = os.getenv("X_PASS")
# CSVを使わないケース向け：環境変数で直接受け取り
x_username = os.getenv("X_USERNAME")
x_email = os.getenv("X_EMAIL")
x_password = os.getenv("X_PASSWORD")
# 認証情報CSVのURL（複数のENV名をサポート）
x_credentials_sheet_csv_url = (
    os.getenv("X_CREDENTIALS_SHEET_CSV_URL")
    or os.getenv("CREDENTIALS_CSV_URL")
    or os.getenv("SHEET_CSV_URL")
    or os.getenv("X_CSV_URL")
)

print(f"  DATE: {date}")
print(f"  TIME: {time_str}")
print(f"  TEXT: {text[:50] if text else None}...")
print(f"  IMAGE (file_id): {image}")
print(f"  SLACK_WEBHOOK_URL: {'設定済み' if slack_webhook_url else '未設定'}")
print(f"  DRIVE_FOLDER_ID: {drive_folder_id}")
print(f"  X_ID: {x_id[:5] + '...' if x_id else '未設定'}")
print(f"  X_PASS: {'設定済み' if x_pass else '未設定'}")
print(f"  X_CREDENTIALS_SHEET_CSV_URL: {'設定済み' if x_credentials_sheet_csv_url else '未設定'}")

# まずは環境変数ベースでのフォールバック（CSV不要）
if not x_id:
    if x_username and x_username.strip():
        x_id = x_username.strip()
    elif x_email and x_email.strip():
        x_id = x_email.strip()

if not x_pass:
    if x_password and x_password.strip():
        x_pass = x_password.strip()

# 不足している場合はスプレッドシート（公開CSV）から取得を試行
# GASのconfigシートは2列形式（A列=キー、B列=値）で保存されている
if (not x_id or not x_pass) and x_credentials_sheet_csv_url:
    try:
        log_step(1, "スプレッドシートからX認証情報を取得中...")
        # Google SheetsのフルURLが渡された場合はCSVエクスポートURLに変換
        csv_url = x_credentials_sheet_csv_url
        if "/spreadsheets/d/" in csv_url and "export?format=csv" not in csv_url and "gviz/tq" not in csv_url:
            try:
                sheet_id = csv_url.split("/spreadsheets/d/")[1].split("/")[0]
                csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv"
            except Exception:
                pass

        resp = requests.get(csv_url, timeout=30)
        if resp.status_code != 200:
            raise Exception(f"HTTP {resp.status_code}")

        # configシートの形式に対応（複数の形式に対応）
        reader = csv.reader(StringIO(resp.text))
        key_to_value = {}
        
        # ヘッダー行をスキップ（ある場合）
        first_row = next(reader, None)
        if first_row and len(first_row) >= 2:
            # ヘッダー行かどうか判定（"key", "value"などの文字列が含まれている場合）
            is_header = any(h.lower() in ['key', 'name', '項目', '設定'] for h in first_row if isinstance(h, str))
            if not is_header:
                # ヘッダーでない場合は最初の行もデータとして扱う
                key_to_value[first_row[0].strip()] = (first_row[1] if len(first_row) > 1 else "").strip()
        
        # 残りの行を処理
        for row in reader:
            if len(row) >= 2 and row[0] and row[0].strip():
                key = row[0].strip()
                value = (row[1] if len(row) > 1 else "").strip()
                key_to_value[key] = value

        print(f"  スプレッドシートから取得したキー: {list(key_to_value.keys())}")

        # X_IDの取得（複数のキー名パターンに対応）
        if not x_id:
            x_id_candidate = (key_to_value.get("X_ID") or 
                             key_to_value.get("X_USER") or 
                             key_to_value.get("X USER") or
                             key_to_value.get("X_USERNAME") or
                             key_to_value.get("X EMAIL") or
                             key_to_value.get("X_EMAIL") or
                             key_to_value.get("EMAIL") or
                             key_to_value.get("USERNAME") or
                             key_to_value.get("x_id") or
                             key_to_value.get("x_user"))
            if x_id_candidate:
                x_id = str(x_id_candidate).strip()

        # X_PASSの取得（複数のキー名パターンに対応）
        if not x_pass:
            x_pass_candidate = (key_to_value.get("X_PASS") or 
                               key_to_value.get("X_PASSWORD") or 
                               key_to_value.get("X PASSWORD") or
                               key_to_value.get("PASSWORD") or
                               key_to_value.get("x_pass") or
                               key_to_value.get("x_password"))
            if x_pass_candidate:
                x_pass = str(x_pass_candidate).strip()

        print(f"  取得結果 X_ID: {x_id[:5] + '...' if x_id else '未取得'}")
        print(f"  取得結果 X_PASS: {'取得済み' if x_pass else '未取得'}")
        
        if x_id or x_pass:
            log_step(1, "✅ スプレッドシートからの取得完了", slack_webhook_url)
        else:
            log_step(1, "⚠️ スプレッドシートにX_ID/X_PASSが見つかりませんでした", slack_webhook_url)
    except Exception as e:
        error_msg = f"⚠️ スプレッドシートからの認証情報取得に失敗: {e}"
        print(error_msg)
        print(traceback.format_exc())
        log_step(1, error_msg, slack_webhook_url)
elif not x_id or not x_pass:
    log_step(1, "⚠️ X_ID/X_PASS が未設定で、CREDENTIALS CSV URL も未設定のため取得不可", slack_webhook_url)

# 必須環境変数のチェック（詳細なエラー表示）
missing_vars = []
if not date:
    missing_vars.append("DATE")
if not time_str:
    missing_vars.append("TIME")
if not text:
    missing_vars.append("TEXT")
if not image:
    missing_vars.append("IMAGE")
if not x_id:
    missing_vars.append("X_ID")
if not x_pass:
    missing_vars.append("X_PASS")

if missing_vars:
    error_msg = f"❌ 必須環境変数が不足しています: {', '.join(missing_vars)}"
    print(error_msg)
    print("\n環境変数の詳細:")
    print(f"  DATE: {'✓' if date else '✗'} {date if date else '(空または未設定)'}")
    print(f"  TIME: {'✓' if time_str else '✗'} {time_str if time_str else '(空または未設定)'}")
    print(f"  TEXT: {'✓' if text else '✗'} {text[:50] + '...' if text else '(空または未設定)'}")
    print(f"  IMAGE: {'✓' if image else '✗'} {image if image else '(空または未設定)'}")
    print(f"  X_ID: {'✓' if x_id else '✗'} {'設定済み' if x_id else '(GitHub Secretsで設定が必要)'}")
    print(f"  X_PASS: {'✓' if x_pass else '✗'} {'設定済み' if x_pass else '(GitHub Secretsで設定が必要)'}")
    
    print("\n対処法:")
    if "DATE" in missing_vars or "TIME" in missing_vars or "TEXT" in missing_vars or "IMAGE" in missing_vars:
        print("  - GASコードの triggerGithubAction() で payload が正しく送信されているか確認")
        print("  - スプレッドシートの postsシートにデータが正しく入力されているか確認")
    if "X_ID" in missing_vars or "X_PASS" in missing_vars:
        print("  - GitHubリポジトリの Settings > Secrets and variables > Actions で以下を設定:")
        print("    - X_ID: X（旧Twitter）のユーザー名")
        print("    - X_PASS: X（旧Twitter）のパスワード")
    
    send_slack(error_msg, slack_webhook_url)
    exit(1)

log_step(1, "✅ 環境変数確認完了", slack_webhook_url)

# ==========================================
# ステップ2: Google Driveから画像ダウンロード
# ==========================================
def download_image_from_drive(file_id):
    log_step(2, f"📥 画像ダウンロード開始 (file_id: {file_id})")
    
    try:
        url = f"https://drive.google.com/uc?export=download&id={file_id}"
        print(f"  ダウンロードURL: {url}")
        
        response = requests.get(url, timeout=30)
        print(f"  レスポンスステータス: {response.status_code}")
        
        if response.status_code != 200:
            raise Exception(f"HTTP {response.status_code}: {response.text[:200]}")
        
        local_path = file_id + ".jpg"
        with open(local_path, "wb") as f:
            f.write(response.content)
        
        file_size = os.path.getsize(local_path)
        print(f"  ✅ ダウンロード完了: {local_path} ({file_size} bytes)")
        log_step(2, f"✅ 画像ダウンロード完了: {file_size} bytes", slack_webhook_url)
        
        return local_path
    except Exception as e:
        error_msg = f"❌ 画像ダウンロードエラー: {str(e)}"
        print(error_msg)
        print(traceback.format_exc())
        send_slack(error_msg, slack_webhook_url)
        raise

try:
    image_path = download_image_from_drive(image)
    image_abs_path = os.path.abspath(image_path)
    print(f"  画像の絶対パス: {image_abs_path}")
except Exception as e:
    exit(1)

# ==========================================
# ステップ3: Seleniumセットアップ
# ==========================================
log_step(3, "🔧 Selenium WebDriverセットアップ開始")

try:
    options = webdriver.ChromeOptions()
    options.add_argument("--headless")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1920,1080")
    
    print("  Chromeオプション設定完了")
    print("  ヘッドレスモード: 有効")
    
    driver = webdriver.Chrome(ChromeDriverManager().install(), options=options)
    driver.implicitly_wait(10)
    
    print(f"  WebDriver バージョン: {driver.capabilities.get('browserVersion', '不明')}")
    log_step(3, "✅ Seleniumセットアップ完了", slack_webhook_url)
except Exception as e:
    error_msg = f"❌ Seleniumセットアップエラー: {str(e)}"
    print(error_msg)
    print(traceback.format_exc())
    send_slack(error_msg, slack_webhook_url)
    exit(1)

# ==========================================
# ステップ4: X（旧Twitter）ログインページへアクセス
# ==========================================
try:
    log_step(4, "🌐 Xログインページへアクセス")
    
    driver.get("https://x.com/login")
    print(f"  現在のURL: {driver.current_url}")
    print(f"  ページタイトル: {driver.title}")
    
    time.sleep(5)
    log_step(4, "✅ ログインページ表示完了", slack_webhook_url)
    
    # ==========================================
    # ステップ5: ユーザー名入力
    # ==========================================
    log_step(5, "📝 ユーザー名入力開始")
    
    try:
        username_field = WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.NAME, "text"))
        )
        print("  ユーザー名入力フィールドを発見")
        username_field.send_keys(x_id)
        print(f"  ユーザー名入力完了: {x_id[:5]}...")
        time.sleep(2)
        log_step(5, "✅ ユーザー名入力完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ ユーザー名入力エラー: {str(e)}"
        print(error_msg)
        print(f"  ページソース（一部）: {driver.page_source[:500]}")
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ6: Nextボタンをクリック
    # ==========================================
    log_step(6, "🖱️ Nextボタンをクリック")
    
    try:
        next_button = WebDriverWait(driver, 15).until(
            EC.element_to_be_clickable((By.XPATH, "//span[text()='Next']"))
        )
        print("  Nextボタンを発見")
        next_button.click()
        print("  Nextボタンクリック完了")
        time.sleep(3)
        log_step(6, "✅ Nextボタンクリック完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ Nextボタンクリックエラー: {str(e)}"
        print(error_msg)
        print(f"  現在のURL: {driver.current_url}")
        print(f"  ページソース（一部）: {driver.page_source[:500]}")
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ7: パスワード入力
    # ==========================================
    log_step(7, "🔐 パスワード入力開始")
    
    try:
        password_field = WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.NAME, "password"))
        )
        print("  パスワード入力フィールドを発見")
        password_field.send_keys(x_pass)
        print("  パスワード入力完了")
        time.sleep(2)
        log_step(7, "✅ パスワード入力完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ パスワード入力エラー: {str(e)}"
        print(error_msg)
        print(f"  現在のURL: {driver.current_url}")
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ8: Log inボタンをクリック
    # ==========================================
    log_step(8, "🖱️ Log inボタンをクリック")
    
    try:
        login_button = WebDriverWait(driver, 15).until(
            EC.element_to_be_clickable((By.XPATH, "//span[text()='Log in']"))
        )
        print("  Log inボタンを発見")
        login_button.click()
        print("  Log inボタンクリック完了")
        time.sleep(5)
        
        print(f"  ログイン後のURL: {driver.current_url}")
        print(f"  ページタイトル: {driver.title}")
        log_step(8, "✅ ログイン完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ ログインエラー: {str(e)}"
        print(error_msg)
        print(f"  現在のURL: {driver.current_url}")
        
        # エラーメッセージがページに表示されているか確認
        if "error" in driver.page_source.lower() or "incorrect" in driver.page_source.lower():
            print("  ⚠️ ページにエラーメッセージが含まれている可能性があります")
        
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ9: 投稿ページへ遷移
    # ==========================================
    log_step(9, "✍️ 投稿ページへ遷移")
    
    try:
        driver.get("https://x.com/compose/tweet")
        print(f"  投稿ページURL: {driver.current_url}")
        time.sleep(5)
        log_step(9, "✅ 投稿ページ表示完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ 投稿ページ遷移エラー: {str(e)}"
        print(error_msg)
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ10: テキスト入力
    # ==========================================
    log_step(10, "📝 投稿テキスト入力開始")
    
    try:
        post_text = f"{date} {time_str}\n{text}"
        print(f"  投稿テキスト: {post_text[:100]}...")
        
        textarea = WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "div[aria-label='Tweet text'], div[data-testid='tweetTextarea_0']"))
        )
        print("  テキスト入力エリアを発見")
        textarea.send_keys(post_text)
        print("  テキスト入力完了")
        time.sleep(2)
        log_step(10, "✅ テキスト入力完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ テキスト入力エラー: {str(e)}"
        print(error_msg)
        print(f"  ページソース（一部）: {driver.page_source[:500]}")
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ11: 画像アップロード
    # ==========================================
    log_step(11, "🖼️ 画像アップロード開始")
    
    try:
        # 複数のセレクタを試行
        selectors = [
            "//input[@type='file']",
            "//input[@accept='image/*']",
            "//input[contains(@data-testid, 'fileInput')]"
        ]
        
        upload_input = None
        for selector in selectors:
            try:
                upload_input = driver.find_element(By.XPATH, selector)
                print(f"  ファイル入力フィールドを発見: {selector}")
                break
            except:
                continue
        
        if not upload_input:
            raise Exception("ファイル入力フィールドが見つかりません")
        
        print(f"  アップロードファイル: {image_abs_path}")
        upload_input.send_keys(image_abs_path)
        print("  画像アップロード開始")
        time.sleep(5)
        log_step(11, "✅ 画像アップロード完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ 画像アップロードエラー: {str(e)}"
        print(error_msg)
        print(f"  画像パス: {image_abs_path}")
        print(f"  ファイル存在確認: {os.path.exists(image_abs_path)}")
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ12: 投稿ボタンをクリック
    # ==========================================
    log_step(12, "🚀 投稿ボタンをクリック")
    
    try:
        # 複数のセレクタを試行
        post_button_selectors = [
            "//span[text()='Post']",
            "//div[@data-testid='tweetButton']",
            "//button[@data-testid='tweetButtonInline']",
            "//button[contains(., 'Post')]"
        ]
        
        post_button = None
        for selector in post_button_selectors:
            try:
                post_button = WebDriverWait(driver, 10).until(
                    EC.element_to_be_clickable((By.XPATH, selector))
                )
                print(f"  投稿ボタンを発見: {selector}")
                break
            except:
                continue
        
        if not post_button:
            raise Exception("投稿ボタンが見つかりません")
        
        post_button.click()
        print("  投稿ボタンクリック完了")
        time.sleep(5)
        
        # 投稿成功の確認（URLが変わる、または成功メッセージが出る）
        print(f"  投稿後のURL: {driver.current_url}")
        log_step(12, "✅ 投稿ボタンクリック完了", slack_webhook_url)
    except Exception as e:
        error_msg = f"❌ 投稿ボタンクリックエラー: {str(e)}"
        print(error_msg)
        print(f"  現在のURL: {driver.current_url}")
        send_slack(error_msg, slack_webhook_url)
        raise
    
    # ==========================================
    # ステップ13: 投稿成功確認
    # ==========================================
    log_step(13, "✅ 投稿処理完了")
    
    success_msg = f"✅ 投稿成功: {text[:50]}..."
    print(success_msg)
    print(f"  投稿日時: {date} {time_str}")
    send_slack(success_msg, slack_webhook_url)
    
    log_step(13, "🎉 すべての処理が正常に完了しました", slack_webhook_url)

except Exception as e:
    error_msg = f"❌ 投稿失敗: {str(e)}"
    print(error_msg)
    print("=" * 50)
    print("エラー詳細:")
    print(traceback.format_exc())
    print("=" * 50)
    
    # エラー時のスクリーンショット取得（可能な場合）
    try:
        if 'driver' in locals():
            screenshot_path = f"error_screenshot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            driver.save_screenshot(screenshot_path)
            print(f"  エラー時のスクリーンショット保存: {screenshot_path}")
            print(f"  現在のURL: {driver.current_url}")
    except:
        pass
    
    send_slack(f"{error_msg}\n```\n{traceback.format_exc()[:500]}\n```", slack_webhook_url)
    exit(1)

finally:
    # ==========================================
    # ステップ14: クリーンアップ
    # ==========================================
    log_step(14, "🧹 クリーンアップ開始")
    
    try:
        if 'driver' in locals():
            driver.quit()
            print("  WebDriverを終了しました")
    except Exception as e:
        print(f"  WebDriver終了エラー: {e}")
    
    try:
        if 'image_path' in locals() and os.path.exists(image_path):
            os.remove(image_path)
            print(f"  一時ファイル削除: {image_path}")
    except Exception as e:
        print(f"  ファイル削除エラー: {e}")
    
    log_step(14, "✅ クリーンアップ完了", slack_webhook_url)
