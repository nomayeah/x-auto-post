import os, time, requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from slack_sdk.webhook import WebhookClient
from webdriver_manager.chrome import ChromeDriverManager
from datetime import datetime

# 環境変数
date = os.getenv("DATE")       # YYYY-MM-DD
time_str = os.getenv("TIME")   # HH:mm
text = os.getenv("TEXT")
image = os.getenv("IMAGE")
slack_webhook_url = os.getenv("SLACK_WEBHOOK_URL")
drive_folder_id = os.getenv("DRIVE_FOLDER_ID")
x_id = os.getenv("X_ID")
x_pass = os.getenv("X_PASS")

# Google Driveから画像ダウンロード（共有フォルダ前提）
def download_image_from_drive(file_id):
    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    r = requests.get(url)
    local_path = file_id + ".jpg"  # 保存名
    with open(local_path, "wb") as f:
        f.write(r.content)
    return local_path

image_path = download_image_from_drive(image)

# Seleniumセットアップ
options = webdriver.ChromeOptions()
options.add_argument("--headless")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
driver = webdriver.Chrome(ChromeDriverManager().install(), options=options)

try:
    driver.get("https://x.com/login")
    time.sleep(5)

    driver.find_element(By.NAME, "text").send_keys(x_id)
    driver.find_element(By.XPATH, "//span[text()='Next']").click()
    time.sleep(3)

    driver.find_element(By.NAME, "password").send_keys(x_pass)
    driver.find_element(By.XPATH, "//span[text()='Log in']").click()
    time.sleep(5)

    driver.get("https://x.com/compose/tweet")
    time.sleep(5)

    # 投稿内容
    textarea = driver.find_element(By.CSS_SELECTOR, "div[aria-label='Tweet text']")
    # 日付と時間を先頭に付与
    textarea.send_keys(f"{date} {time_str}\n{text}")

    upload = driver.find_element(By.XPATH, "//input[@type='file']")
    upload.send_keys(os.path.abspath(image_path))
    time.sleep(5)

    driver.find_element(By.XPATH, "//span[text()='Post']").click()
    time.sleep(5)

    WebhookClient(slack_webhook_url).send(text=f"✅ 投稿成功: {text[:50]}...")

except Exception as e:
    WebhookClient(slack_webhook_url).send(text=f"❌ 投稿失敗: {str(e)}")
finally:
    driver.quit()
