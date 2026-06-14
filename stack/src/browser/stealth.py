"""
SeleniumBase Anti-Detection Browser — HTTP API
Stellt einen stealth-fähigen Browser bereit für Seiten mit Bot-Detection
(Google, Cloudflare, Akamai, PerimeterX etc.)
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import base64
import os
import sys
import threading
import time

# SeleniumBase UC Mode = Undetected Chrome
from seleniumbase import SB

PORT = int(os.environ.get("STEALTH_PORT", "18803"))
browser_lock = threading.Lock()
sb_instance = None
sb_cm = None

def get_browser():
    global sb_instance, sb_cm
    if sb_instance is None:
        sb_cm = SB(uc=True, headless=True, locale_code="de", agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")
        sb_instance = sb_cm.__enter__()
    return sb_instance

class StealthHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[stealth] {args[0]}")

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "healthy", "service": "stealth-browser", "mode": "seleniumbase-uc"}).encode())
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        if self.path == "/navigate":
            url = body.get("url", "")
            with browser_lock:
                try:
                    sb = get_browser()
                    sb.open(url)
                    sb.sleep(2)  # Wait for page load + JS execution
                    sb.save_screenshot("/tmp/sb_screenshot.png"); screenshot = open("/tmp/sb_screenshot.png", "rb").read()
                    page_source = sb.get_page_source()[:5000]
                    title = sb.get_title()
                    current_url = sb.get_current_url()
                    self._respond(200, {
                        "url": current_url,
                        "title": title,
                        "screenshot": base64.b64encode(screenshot).decode(),
                        "pageSource": page_source,
                    })
                except Exception as e:
                    self._respond(500, {"error": str(e)})
            return

        if self.path == "/click":
            x, y = body.get("x", 0), body.get("y", 0)
            with browser_lock:
                try:
                    sb = get_browser()
                    sb.execute_script(f"document.elementFromPoint({x},{y}).click()")
                    sb.sleep(1)
                    sb.save_screenshot("/tmp/sb_screenshot.png"); screenshot = open("/tmp/sb_screenshot.png", "rb").read()
                    self._respond(200, {
                        "screenshot": base64.b64encode(screenshot).decode(),
                        "url": sb.get_current_url(),
                    })
                except Exception as e:
                    self._respond(500, {"error": str(e)})
            return

        if self.path == "/type":
            text = body.get("text", "")
            selector = body.get("selector", "input:focus, textarea:focus, [contenteditable]:focus")
            with browser_lock:
                try:
                    sb = get_browser()
                    sb.slow_type(selector, text, timeout=5)
                    sb.save_screenshot("/tmp/sb_screenshot.png"); screenshot = open("/tmp/sb_screenshot.png", "rb").read()
                    self._respond(200, {
                        "screenshot": base64.b64encode(screenshot).decode(),
                    })
                except Exception as e:
                    self._respond(500, {"error": str(e)})
            return

        if self.path == "/key":
            key = body.get("key", "")
            with browser_lock:
                try:
                    sb = get_browser()
                    sb.press_keys("body", key)
                    sb.sleep(1)
                    sb.save_screenshot("/tmp/sb_screenshot.png"); screenshot = open("/tmp/sb_screenshot.png", "rb").read()
                    self._respond(200, {
                        "screenshot": base64.b64encode(screenshot).decode(),
                        "url": sb.get_current_url(),
                    })
                except Exception as e:
                    self._respond(500, {"error": str(e)})
            return

        if self.path == "/screenshot":
            with browser_lock:
                try:
                    sb = get_browser()
                    sb.save_screenshot("/tmp/sb_screenshot.png"); screenshot = open("/tmp/sb_screenshot.png", "rb").read()
                    self._respond(200, {
                        "screenshot": base64.b64encode(screenshot).decode(),
                        "url": sb.get_current_url(),
                        "title": sb.get_title(),
                    })
                except Exception as e:
                    self._respond(500, {"error": str(e)})
            return

        if self.path == "/scroll":
            direction = body.get("direction", "down")
            amount = body.get("amount", 300)
            with browser_lock:
                try:
                    sb = get_browser()
                    delta = amount if direction == "down" else -amount
                    sb.execute_script(f"window.scrollBy(0, {delta})")
                    sb.sleep(0.5)
                    sb.save_screenshot("/tmp/sb_screenshot.png"); screenshot = open("/tmp/sb_screenshot.png", "rb").read()
                    self._respond(200, {"screenshot": base64.b64encode(screenshot).decode()})
                except Exception as e:
                    self._respond(500, {"error": str(e)})
            return

        self.send_response(404)
        self.end_headers()

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

if __name__ == "__main__":
    print(f"[stealth] SeleniumBase UC Mode browser on port {PORT}")
    print(f"[stealth] Anti-detection: Cloudflare, Google, Akamai, PerimeterX")
    server = HTTPServer(("127.0.0.1", PORT), StealthHandler)
    server.serve_forever()
