"""
Unified Browser/Computer Fallback Gateway  (Port 18804)

The universal "operate any app without an API" layer. When structured
integration (API / MCP / CLI / A2A) does not reach an app, this gateway
drives it through the browser:

  TIER 1  browser-use   DOM/CDP agent (browser_use 0.12.x + Bedrock EU)
                        cheap, structured, fast. First choice.
  TIER 2  computer-use  screenshot/vision agent (port 18802), auto-switches
                        to SeleniumBase UC stealth for bot-protected domains.
                        The escalation target when DOM automation fails.

Endpoints:
  GET  /health   honest capability report
  POST /route    {url}            -> which tier would run
  POST /run      {task,url,strategy?,tenantId?}  -> run ONE tier
  POST /solve    {task,url,tenantId?}            -> browser-use, escalate to
                                                   computer-use on failure
"""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json
import os
import time
import urllib.request
import asyncio
import traceback

PORT = int(os.environ.get("UNIFIED_PORT", "18804"))
COMPUTER_USE_URL = os.environ.get("COMPUTER_USE_URL", "http://127.0.0.1:18802")
BEDROCK_MODEL = os.environ.get("BEDROCK_MODEL", "eu.anthropic.claude-sonnet-4-6")
AWS_REGION = os.environ.get("AWS_REGION", "eu-central-1")

STEALTH_DOMAINS = {
    "google.com", "google.de", "google.at", "google.ch",
    "youtube.com", "linkedin.com", "facebook.com", "instagram.com",
    "amazon.de", "amazon.com", "ebay.de", "ebay.com",
    "twitter.com", "x.com", "tiktok.com",
}


def needs_stealth(url: str) -> bool:
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").replace("www.", "")
        return host in STEALTH_DOMAINS or any(host.endswith("." + d) for d in STEALTH_DOMAINS)
    except Exception:
        return False


def pick_tier(url: str, force: str = None) -> str:
    """Auto-select the cheapest tier that can handle the URL."""
    if force:
        return force
    # Bot-protected domains need vision+stealth (computer-use auto-switches to UC).
    if url and needs_stealth(url):
        return "computer-use"
    return "browser-use"


# ============================================================
# TIER 1 — browser-use (DOM/CDP agent, browser_use 0.12.x)
# ============================================================
async def _run_browser_use_async(task: str, url: str = None) -> dict:
    from browser_use import Agent
    from browser_use.browser.session import BrowserSession
    from browser_use.browser.profile import BrowserProfile
    from browser_use.llm.aws.chat_anthropic import ChatAnthropicBedrock

    llm = ChatAnthropicBedrock(
        model=BEDROCK_MODEL,
        aws_region=AWS_REGION,
        aws_access_key=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        temperature=0.0,
    )
    # chromium_sandbox=False is REQUIRED running as root, else chrome dies and
    # the CDP port never binds (BrowserStartEvent deadlocks for 30s).
    profile = BrowserProfile(headless=os.environ.get("BROWSER_HEADLESS", "true") != "false",
                             chromium_sandbox=False)
    session = BrowserSession(browser_profile=profile)
    full_task = task if not url else f"Go to {url} and then: {task}"
    agent = Agent(task=full_task, llm=llm, browser_session=session)
    try:
        hist = await agent.run(max_steps=int(os.environ.get("MAX_STEPS", "20")))
        final = hist.final_result()
        try:
            ok = bool(hist.is_successful())
        except Exception:
            ok = final is not None
        try:
            steps = hist.number_of_steps()
        except Exception:
            steps = 0
        return {"tier": "browser-use", "success": ok, "result": str(final) if final else None, "steps": steps}
    finally:
        try:
            await session.kill()
        except Exception:
            pass


def run_browser_use(task: str, url: str = None) -> dict:
    try:
        return asyncio.run(_run_browser_use_async(task, url))
    except Exception as e:
        return {"tier": "browser-use", "success": False, "error": str(e),
                "trace": traceback.format_exc().splitlines()[-3:]}


# ============================================================
# TIER 2 — computer-use (vision + stealth, port 18802)
# ============================================================
def _post(url: str, payload: dict, timeout: int = 30) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _get(url: str, timeout: int = 15) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def run_computer_use(task: str, url: str = None, tenant_id: str = "unified", poll_s: int = 180) -> dict:
    """Delegate to the computer-use agent (18802) and poll to completion."""
    try:
        started = _post(f"{COMPUTER_USE_URL}/task",
                        {"task": task, "url": url, "tenantId": tenant_id, "mode": "auto"})
    except Exception as e:
        return {"tier": "computer-use", "success": False, "error": f"dispatch failed: {e}"}

    if started.get("status") and started.get("status") != "running":
        return {"tier": "computer-use", "success": started.get("status") == "completed", "result": started}

    task_id = started.get("id")
    if not task_id:
        return {"tier": "computer-use", "success": False, "error": "no task id returned", "raw": started}

    deadline = time.time() + poll_s
    last = started
    while time.time() < deadline:
        time.sleep(3)
        try:
            last = _get(f"{COMPUTER_USE_URL}/task/{task_id}")
        except Exception:
            continue
        if last.get("status") in ("completed", "failed", "cancelled"):
            break
    return {"tier": "computer-use", "success": last.get("status") == "completed",
            "status": last.get("status"), "finalUrl": last.get("finalUrl"),
            "error": last.get("error"), "steps": len(last.get("steps", []))}


# ============================================================
# HTTP API
# ============================================================
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[unified] {args[0] if args else ''}")

    def _read(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n)) if n > 0 else {}

    def _send(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {
                "status": "healthy",
                "service": "unified-fallback-gateway",
                "tiers": {
                    "browser-use": "browser_use 0.12.x DOM/CDP agent (Bedrock EU) — primary",
                    "computer-use": f"vision+stealth agent ({COMPUTER_USE_URL}) — escalation",
                },
                "stealthDomains": sorted(STEALTH_DOMAINS),
            })
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        body = self._read()
        if self.path == "/route":
            url = body.get("url", "")
            self._send(200, {"url": url, "tier": pick_tier(url, body.get("force")),
                             "needsStealth": needs_stealth(url)})
            return

        if self.path == "/run":
            task = body.get("task", "")
            url = body.get("url")
            tenant = body.get("tenantId", "unified")
            tier = body.get("strategy") or pick_tier(url or "")
            if tier in ("fast", "browser-use", "harness"):  # harness aliased -> real DOM agent
                self._send(200, run_browser_use(task, url))
            elif tier in ("vision", "computer-use", "stealth"):
                self._send(200, run_computer_use(task, url, tenant))
            else:
                self._send(400, {"error": f"unknown strategy '{tier}'"})
            return

        if self.path == "/solve":
            # Universal entrypoint: cheap DOM tier first, escalate to vision on failure.
            task = body.get("task", "")
            url = body.get("url")
            tenant = body.get("tenantId", "unified")
            if url and needs_stealth(url):
                self._send(200, {"chosen": "computer-use (stealth domain)",
                                 "attempts": [run_computer_use(task, url, tenant)]})
                return
            t1 = run_browser_use(task, url)
            if t1.get("success"):
                self._send(200, {"chosen": "browser-use", "attempts": [t1]})
                return
            t2 = run_computer_use(task, url, tenant)
            self._send(200, {"chosen": "computer-use (escalated)", "attempts": [t1, t2]})
            return

        self._send(404, {"error": "unknown endpoint"})


if __name__ == "__main__":
    print(f"[unified] Universal Fallback Gateway on :{PORT}")
    print(f"[unified] TIER1 browser-use (DOM/CDP) -> TIER2 computer-use ({COMPUTER_USE_URL})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
