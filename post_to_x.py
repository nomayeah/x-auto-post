import os
import time
import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from slack_sdk.webhook import WebhookClient

# === 環境変数 ===
text = os.getenv("TEXT")
image = os.getenv("IMAGE")
slack_webhook_url = os.getenv("SLACK_WEBHOOK_URL")
drive_folder_id = os.getenv("DRIVE_FOLDER_ID")
x_email = os.getenv("X_EMAIL")
x_user = os.getenv("X_USERNAME")
x_pass = os.getenv("X_PASSWORD")

# === 必須チェック ===
missing = [k for k, v in {
    "TEXT": text, "IMAGE": image, "SLACK_WEBHOOK_URL": slack_webhook_url,
    "X_EMAIL": x_email, "X_USERNAME": x_user, "X_PASSWORD": x_pass
}.items() if not v]

if missing:
    if slack_webhook_url:
        WebhookClient(slack_webhook_url).send(text=f"❌ 必須環境変数が不足しています: {missing}")
    raise SystemExit()

# === Google Driveから画像DL ===
def download_image_from_drive(file_id):
    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    r = requests.get(url)
    path = f"/tmp/{file_id}.jpg"
    with open(path, "wb") as f:
        f.write(r.content)
    return path

image_path = download_image_from_drive(image)

# === Selenium設定 ===
options = webdriver.ChromeOptions()
options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
options.add_argument("--disable-blink-features=AutomationControlled")
options.add_argument("--window-size=1280,800")
options.add_experimental_option("excludeSwitches", ["enable-automation"])
options.add_experimental_option('useAutomationExtension', False)
# User-Agentを設定（Selenium検知回避）
options.add_argument("user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

service = Service(ChromeDriverManager().install())
driver = webdriver.Chrome(service=service, options=options)
# Selenium検知回避のためのJavaScript実行
driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', {
    'source': 'Object.defineProperty(navigator, "webdriver", {get: () => undefined})'
})
wait = WebDriverWait(driver, 20)

def send_slack(msg):
    try:
        WebhookClient(slack_webhook_url).send(text=msg)
    except Exception as e:
        print("Slack送信失敗:", e)

try:
    # 1️⃣ ログインページへ
    print("🌐 Xログインページにアクセス中...")
    driver.get("https://x.com/i/flow/login")
    send_slack("🌐 Xログインページを開きました 6")
    time.sleep(5)  # ページロード待機
    print(f"現在のURL: {driver.current_url}")
    print(f"ページタイトル: {driver.title}")
    
    # ページの読み込みを待つ（複数のセレクタを試行）
    form_found = False
    form_selectors = [
        (By.NAME, "text"),  # メール/ユーザー名入力フィールド
        (By.CSS_SELECTOR, "input[type='text']"),
        (By.CSS_SELECTOR, "input[name='text']"),
        (By.XPATH, "//input[@name='text']"),
        (By.TAG_NAME, "input"),  # フォールバック
    ]
    
    for selector_type, selector_value in form_selectors:
        try:
            print(f"ログインフォーム検出を試行: {selector_type}, {selector_value}")
            wait.until(EC.presence_of_element_located((selector_type, selector_value)))
            print(f"✅ ログインフォームを発見: {selector_type}, {selector_value}")
            form_found = True
            break
        except Exception as e:
            print(f"❌ セレクタ失敗: {selector_type}, {selector_value} - {e}")
            continue
    
    if form_found:
        send_slack("✅ ログインフォームが読み込まれました")
    else:
        # フォームが見つからなくても、ページが読み込まれていれば続行を試みる
        print("⚠️ ログインフォームが見つかりませんでしたが、続行を試みます")
        print(f"ページソース（一部）: {driver.page_source[:1000]}")
        send_slack("⚠️ ログインフォームが見つかりませんでしたが、続行を試みます")
        time.sleep(3)  # 追加の待機時間

    # 2️⃣ メール or ユーザー名入力
    try:
        # 複数のセレクタを試行
        email_box = None
        email_selectors = [
            (By.NAME, "text"),
            (By.CSS_SELECTOR, "input[name='text']"),
            (By.XPATH, "//input[@name='text']"),
            (By.CSS_SELECTOR, "input[type='text']"),
        ]
        
        for selector_type, selector_value in email_selectors:
            try:
                print(f"メール入力フィールド検出を試行: {selector_type}, {selector_value}")
                email_box = wait.until(EC.presence_of_element_located((selector_type, selector_value)))
                print(f"✅ メール入力フィールドを発見: {selector_type}, {selector_value}")
                break
            except Exception as e:
                print(f"❌ セレクタ失敗: {selector_type}, {selector_value} - {e}")
                continue
        
        if not email_box:
            raise Exception("メール入力フィールドが見つかりません")
        
        email_box.clear()
        email_box.send_keys(x_email)
        time.sleep(1)
        email_box.send_keys(Keys.RETURN)
        send_slack("📧 メールアドレス入力完了")
    except Exception as e:
        error_detail = f"⚠️ メール入力ステップでエラー: {str(e)}"
        print(error_detail)
        print(f"現在のURL: {driver.current_url}")
        try:
            screenshot_path = f"/tmp/email_error_{int(time.time())}.png"
            driver.save_screenshot(screenshot_path)
            print(f"スクリーンショット保存: {screenshot_path}")
            send_slack(f"{error_detail}\nスクリーンショット: {screenshot_path}")
        except:
            send_slack(error_detail)
        raise

    time.sleep(3)

    # 3️⃣ ユーザー名確認（出る場合のみ）
    try:
        # メール入力後のページ遷移を待つ
        print("メール入力後の遷移を待機中...")
        time.sleep(5)  # より長い待機時間
        
        print("ユーザー名入力フィールドを探しています...")
        username_box = wait.until(EC.presence_of_element_located((By.NAME, "text")))
        username_box.clear()
        username_box.send_keys(x_user)
        send_slack("👤 ユーザー名入力完了")
        time.sleep(1)
        
        # 「次へ」ボタンをクリック（Enterキーではなく、ボタンをクリック）
        print("「次へ」ボタンを探しています...")
        try:
            # 複数のセレクタで「次へ」ボタンを探す
            next_button = None
            next_selectors = [
                (By.XPATH, "//span[text()='次へ']"),
                (By.XPATH, "//button[contains(., '次へ')]"),
                (By.XPATH, "//span[contains(text(), '次へ')]"),
                (By.XPATH, "//button[@data-testid='ocfEnterTextNextButton']"),
                (By.CSS_SELECTOR, "button[data-testid='ocfEnterTextNextButton']"),
            ]
            
            for selector_type, selector_value in next_selectors:
                try:
                    next_button = wait.until(EC.element_to_be_clickable((selector_type, selector_value)))
                    print(f"✅ 「次へ」ボタンを発見: {selector_type}, {selector_value}")
                    break
                except:
                    continue
            
            if next_button:
                next_button.click()
                print("✅ 「次へ」ボタンをクリックしました")
                send_slack("✅ 「次へ」ボタンをクリックしました")
            else:
                # ボタンが見つからない場合はEnterキーを試す
                print("⚠️ 「次へ」ボタンが見つかりません。Enterキーを送信します")
                username_box.send_keys(Keys.RETURN)
        except Exception as e:
            print(f"⚠️ 「次へ」ボタンクリックエラー: {e}。Enterキーを送信します")
            username_box.send_keys(Keys.RETURN)
        
        # モーダル内のh1が「パスワードを入力」に変わるまで待機
        print("\nモーダル内のh1が「パスワードを入力」に変わるまで待機中...")
        max_wait_time = 30
        check_interval = 0.5
        waited_time = 0
        password_modal_found = False
        
        while waited_time < max_wait_time:
            try:
                # モーダル要素を取得
                modal = None
                try:
                    modal = driver.find_element(By.XPATH, "//div[@role='dialog']")
                except:
                    try:
                        modal = driver.find_element(By.XPATH, "//div[@aria-modal='true']")
                    except:
                        pass
                
                if modal:
                    # モーダル内のh1を確認
                    h1_elements = modal.find_elements(By.TAG_NAME, "h1")
                    for h1 in h1_elements:
                        try:
                            h1_text = h1.text
                            if "パスワード" in h1_text or "Password" in h1_text:
                                print(f"✅ パスワード入力モーダルを検出: {h1_text}（{waited_time:.1f}秒後）")
                                password_modal_found = True
                                break
                        except:
                            continue
                
                if password_modal_found:
                    break
                    
            except Exception as e:
                print(f"   チェック中エラー: {e}")
            
            time.sleep(check_interval)
            waited_time += check_interval
            if int(waited_time) % 5 == 0 and int(waited_time) > 0:
                print(f"   待機中... ({int(waited_time)}秒経過)")
        
        if not password_modal_found:
            print("⚠️ パスワード入力モーダルが見つかりませんでしたが、続行します")
        
        # 追加の待機（モーダル内要素の完全な読み込み）
        time.sleep(2)
    except Exception as e:
        print(f"ユーザー名入力がスキップされました: {e}")
        send_slack("ℹ️ ユーザー名入力画面はスキップ")
        time.sleep(5)  # スキップ時も待機

    # 4️⃣ パスワード入力
    try:
        print("\n" + "=" * 50)
        print("🔍 パスワード入力フィールドを検出中...")
        print("=" * 50)
        print(f"現在のURL: {driver.current_url}")
        print(f"ページタイトル: {driver.title}")
        
        # 方法1: JavaScriptでDOMを監視してパスワードフィールドが出現するまで待機
        print("\n[方法1] JavaScriptでDOMを監視中...")
        password_box = None
        max_wait_time = 30
        check_interval = 0.5
        waited_time = 0
        
        while waited_time < max_wait_time:
            try:
                # JavaScriptでパスワードフィールドを探す
                password_box = driver.execute_script("""
                    // すべてのinput要素を取得
                    const inputs = document.querySelectorAll('input');
                    for (let input of inputs) {
                        if (input.type === 'password' || input.name === 'password') {
                            return input;
                        }
                    }
                    return null;
                """)
                
                if password_box:
                    # JavaScriptで見つかった要素をSelenium要素に変換
                    try:
                        # XPathで再検索
                        password_box = driver.find_element(By.NAME, "password")
                        print(f"✅ JavaScriptでパスワードフィールドを発見（{waited_time:.1f}秒後）")
                        break
                    except:
                        # CSSセレクタで再検索
                        try:
                            password_box = driver.find_element(By.CSS_SELECTOR, "input[type='password']")
                            print(f"✅ JavaScriptでパスワードフィールドを発見（{waited_time:.1f}秒後）")
                            break
                        except:
                            pass
                
                # すべてのinput要素をチェック（表示されているもののみ）
                all_inputs = driver.find_elements(By.TAG_NAME, "input")
                for input_elem in all_inputs:
                    try:
                        # 要素が表示されているか確認
                        if not input_elem.is_displayed():
                            continue
                        
                        input_type = input_elem.get_attribute("type")
                        input_name = input_elem.get_attribute("name")
                        if input_type == "password" or input_name == "password":
                            password_box = input_elem
                            print(f"✅ 全input要素からパスワードフィールドを発見（{waited_time:.1f}秒後）")
                            print(f"   type={input_type}, name={input_name}, displayed={input_elem.is_displayed()}")
                            break
                    except:
                        continue
                
                if password_box:
                    break
                    
            except Exception as e:
                print(f"   チェック中エラー: {e}")
            
            time.sleep(check_interval)
            waited_time += check_interval
            if int(waited_time) % 5 == 0 and int(waited_time) > 0:
                print(f"   待機中... ({int(waited_time)}秒経過)")
        
        # 方法2: iframe内を検索（Xのログインフォームがiframe内にある可能性）
        if not password_box:
            print("\n[方法2] iframe内を検索中...")
            try:
                # すべてのiframeを取得
                iframes = driver.find_elements(By.TAG_NAME, "iframe")
                print(f"   ページ内のiframe数: {len(iframes)}")
                for i, iframe in enumerate(iframes):
                    try:
                        driver.switch_to.frame(iframe)
                        print(f"   iframe[{i}]に切り替え")
                        
                        # iframe内のinput要素を検索
                        iframe_inputs = driver.find_elements(By.TAG_NAME, "input")
                        for input_elem in iframe_inputs:
                            try:
                                if not input_elem.is_displayed():
                                    continue
                                input_type = input_elem.get_attribute("type")
                                input_name = input_elem.get_attribute("name")
                                if input_type == "password" or input_name == "password":
                                    password_box = input_elem
                                    print(f"✅ iframe[{i}]内でパスワードフィールドを発見")
                                    break
                            except:
                                continue
                        
                        driver.switch_to.default_content()
                        if password_box:
                            break
                    except Exception as e:
                        print(f"   iframe[{i}]切り替えエラー: {e}")
                        try:
                            driver.switch_to.default_content()
                        except:
                            pass
            except Exception as e:
                print(f"   iframe検索エラー: {e}")
                try:
                    driver.switch_to.default_content()
                except:
                    pass
        
        # 方法3: モーダル内を直接検索
        if not password_box:
            print("\n[方法3] モーダル内を直接検索中...")
            try:
                # モーダル要素を取得
                modal = None
                try:
                    modal = driver.find_element(By.XPATH, "//div[@role='dialog']")
                except:
                    try:
                        modal = driver.find_element(By.XPATH, "//div[@aria-modal='true']")
                    except:
                        pass
                
                if modal:
                    # モーダル内のすべてのinput要素を取得
                    modal_inputs = modal.find_elements(By.TAG_NAME, "input")
                    print(f"   モーダル内のinput要素数: {len(modal_inputs)}")
                    for input_elem in modal_inputs:
                        try:
                            # 表示されているか確認
                            if not input_elem.is_displayed():
                                continue
                            input_type = input_elem.get_attribute("type")
                            input_name = input_elem.get_attribute("name")
                            print(f"   input: type={input_type}, name={input_name}, displayed={input_elem.is_displayed()}")
                            if input_type == "password" or input_name == "password":
                                password_box = input_elem
                                print(f"✅ モーダル内でパスワードフィールドを発見")
                                break
                        except:
                            continue
            except Exception as e:
                print(f"   モーダル内検索エラー: {e}")
        
        # 方法4: まだ見つからない場合、強制検索
        if not password_box:
            print("\n[方法4] 強制検索を試行中...")
            selectors = [
                (By.NAME, "password"),
                (By.CSS_SELECTOR, "input[type='password']"),
                (By.XPATH, "//input[@type='password']"),
                (By.XPATH, "//input[@name='password']"),
            ]
            
            for selector_type, selector_value in selectors:
                try:
                    password_box = driver.find_element(selector_type, selector_value)
                    print(f"✅ 強制検索でパスワードフィールドを発見: {selector_type}, {selector_value}")
                    break
                except:
                    continue
        
        if not password_box:
            # デバッグ情報を出力
            print("\n⚠️ パスワードフィールドが見つかりませんでした")
            print("📋 デバッグ情報:")
            try:
                all_inputs = driver.find_elements(By.TAG_NAME, "input")
                print(f"   ページ内の全input要素数: {len(all_inputs)}")
                for i, input_elem in enumerate(all_inputs[:10]):  # 最初の10個のみ
                    try:
                        input_type = input_elem.get_attribute("type")
                        input_name = input_elem.get_attribute("name")
                        input_id = input_elem.get_attribute("id")
                        print(f"   input[{i}]: type={input_type}, name={input_name}, id={input_id}")
                    except:
                        print(f"   input[{i}]: (属性取得失敗)")
            except Exception as e:
                print(f"   デバッグ情報取得エラー: {e}")
            
            send_slack("⚠️ パスワードフィールドが見つかりませんでした")
            raise Exception("パスワード入力フィールドが見つかりません")
        
        # パスワード入力
        print("パスワードを入力中...")
        password_box.clear()
        time.sleep(0.5)
        password_box.send_keys(x_pass)
        time.sleep(1)
        print("Enterキーを送信...")
        password_box.send_keys(Keys.RETURN)
        send_slack("🔐 パスワード入力完了")
        time.sleep(5)  # ログイン処理の待機
        print(f"パスワード入力後のURL: {driver.current_url}")
        
    except Exception as e:
        error_detail = f"❌ パスワード入力ステップで失敗: {str(e)}"
        print(error_detail)
        print(f"エラータイプ: {type(e).__name__}")
        # スクリーンショットを取得
        try:
            screenshot_path = f"/tmp/password_error_{int(time.time())}.png"
            driver.save_screenshot(screenshot_path)
            print(f"スクリーンショット保存: {screenshot_path}")
            send_slack(f"{error_detail}\nスクリーンショット: {screenshot_path}")
        except:
            send_slack(error_detail)
        raise

    # 5️⃣ 投稿ページへ遷移
    driver.get("https://x.com/compose/tweet")
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "div[aria-label='Tweet text']")))
    send_slack("📝 投稿画面を開きました")

    # 6️⃣ テキスト入力
    textarea = driver.find_element(By.CSS_SELECTOR, "div[aria-label='Tweet text']")
    textarea.send_keys(text)
    time.sleep(2)

    # 7️⃣ 画像アップロード
    try:
        upload = driver.find_element(By.XPATH, "//input[@type='file']")
        upload.send_keys(image_path)
        send_slack("🖼️ 画像アップロード完了")
        time.sleep(5)
    except Exception as e:
        send_slack(f"⚠️ 画像アップロード失敗: {e}")

    # 8️⃣ 投稿ボタンをクリック
    try:
        post_button = wait.until(
            EC.element_to_be_clickable(
                (By.XPATH, "//span[text()='Post' or text()='ポスト']")
            )
        )
        post_button.click()
        send_slack("🚀 投稿ボタンをクリックしました")
        time.sleep(5)
    except Exception as e:
        send_slack(f"❌ 投稿ボタンクリック失敗: {e}")
        raise

    send_slack(f"✅ 投稿成功: {text[:50]}...")

except Exception as e:
    error_msg = f"❌ 投稿失敗: {str(e)}"
    print(error_msg)
    print(f"エラータイプ: {type(e).__name__}")
    import traceback
    print(f"スタックトレース:\n{traceback.format_exc()}")
    
    # エラー時のスクリーンショット取得（可能な場合）
    try:
        screenshot_path = f"/tmp/error_{int(time.time())}.png"
        driver.save_screenshot(screenshot_path)
        print(f"スクリーンショット保存: {screenshot_path}")
        send_slack(f"{error_msg}\nスクリーンショット: {screenshot_path}")
    except:
        send_slack(error_msg)
finally:
    try:
        driver.quit()
    except:
        pass