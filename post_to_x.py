import os, time, requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from slack_sdk.webhook import WebhookClient
from webdriver_manager.chrome import ChromeDriverManager

text = os.getenv("TEXT")
image = os.getenv("IMAGE")
slack_webhook_url = os.getenv("SLACK_WEBHOOK_URL")
drive_folder_id = os.getenv("DRIVE_FOLDER_ID")
x_email = os.getenv("X_EMAIL")
x_username = os.getenv("X_USERNAME")
x_password = os.getenv("X_PASSWORD")

if not all([text, image, slack_webhook_url, drive_folder_id, x_email, x_username, x_password]):
    print("❌ 必須環境変数が不足しています")
    exit(1)

def download_image_from_drive(file_id):
    url = f"https://drive.google.com/uc?export=download&id={file_id}"
    r = requests.get(url)
    file_name = f"{file_id}.jpg"
    with open(file_name, "wb") as f:
        f.write(r.content)
    return os.path.abspath(file_name)

image_path = download_image_from_drive(image)

options = webdriver.ChromeOptions()
options.add_argument("--headless")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
driver = webdriver.Chrome(ChromeDriverManager().install(), options=options)

try:
    driver.get("https://x.com/login")
    time.sleep(5)
    driver.find_element(By.NAME, "text").send_keys(x_email)
    driver.find_element(By.XPATH, "//span[text()='Next']").click()
    time.sleep(3)
    driver.find_element(By.NAME, "password").send_keys(x_password)
    driver.find_element(By.XPATH, "//span[text()='Log in']").click()
    time.sleep(5)

    driver.get("https://x.com/compose/tweet")
    time.sleep(5)
    textarea = driver.find_element(By.CSS_SELECTOR, "div[aria-label='Tweet text']")
    textarea.send_keys(text)
    upload = driver.find_element(By.XPATH, "//input[@type='file']")
    upload.send_keys(image_path)
    time.sleep(5)
    driver.find_element(By.XPATH, "//span[text()='Post']").click()
    time.sleep(5)

    WebhookClient(slack_webhook_url).send(text=f"✅ 投稿成功: {text[:50]}...")
except Exception as e:
    WebhookClient(slack_webhook_url).send(text=f"❌ 投稿失敗: {str(e)}")
finally:
    driver.quit()