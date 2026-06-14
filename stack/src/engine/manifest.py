"""
ENGINE / manifest loader — the app-agnostic core of the learn-and-execute product.

A manifest (apps/<app>/manifest.json) fully describes how to drive one app's
non-API mechanisms: auth, app-map, and per-task navigation + dialog + data + runner.
The scanner, calibrator, booking runner and precision validator all read this one
file — so onboarding a NEW app means writing a manifest + running calibration,
no new code.
"""
import json
import os
import re
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def rel(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def load_manifest(app=None, manifest_path=None):
    path = manifest_path or (f"apps/{app}/manifest.json" if app else None)
    if not path:
        raise SystemExit("need app name or manifest path")
    return json.load(open(rel(path)))


def get_task(manifest, task=None):
    tasks = manifest.get("tasks", {})
    if not tasks:
        raise SystemExit(f"manifest '{manifest.get('appName')}' has no tasks")
    if task:
        if task not in tasks:
            raise SystemExit(f"task '{task}' not in manifest (have: {list(tasks)})")
        return task, tasks[task]
    # default: the single/first task
    name = next(iter(tasks))
    return name, tasks[name]


def load_credentials(manifest):
    auth = manifest.get("auth", {})
    env_file = auth.get("credentialsEnv")
    creds = {}
    if env_file and os.path.exists(env_file):
        ek, pk = auth.get("emailKey", "EMAIL"), auth.get("passwordKey", "PASSWORD")
        for line in open(env_file):
            if line.startswith(ek + "="):
                creds["email"] = line.split("=", 1)[1].strip().strip('"')
            if line.startswith(pk + "="):
                creds["pw"] = line.split("=", 1)[1].strip().strip('"')
    return creds


async def _needs_login(page):
    """Robust auth detection: URL on a sign-in route OR a visible password field."""
    u = (page.url or "").lower()
    if any(k in u for k in ("login", "sign-in", "signin", "authenticate")):
        return True
    try:
        return await page.locator("input[type='password']").first.is_visible(timeout=1500)
    except Exception:
        return False


async def _dismiss_consent(page):
    """Click an accept/agree button if a consent overlay blocks the form (no-op otherwise)."""
    try:
        btn = page.get_by_role("button", name=re.compile("akzep|zustimm|einverstanden|alle|accept", re.I)).first
        if await btn.is_visible(timeout=1200):
            await btn.click()
            await page.wait_for_timeout(500)
    except Exception:
        pass


def _save_session(ctx_cookies, manifest):
    auth = manifest.get("auth", {})
    sess = auth.get("sessionFile")
    if not sess:
        return
    try:
        json.dump({"appName": manifest["appName"], "cookies": ctx_cookies,
                   "savedAt": int(time.time()), "expiresAt": int(time.time()) + 86400},
                  open(rel(sess), "w"))
    except Exception:
        pass


async def ensure_logged_in(page, ctx, manifest):
    """Restore session cookies; if still unauthenticated, do a credential login.

    Reliable by design: detects auth via URL *and* password field, dismisses any
    consent overlay, fills username/password by name (fallback to first text/password
    inputs), submits, then polls until off the sign-in route. Raises a clear error if
    login does not complete — it never proceeds half-authenticated. On success a fresh
    session is persisted so later passes skip the login entirely.
    """
    auth = manifest.get("auth", {})
    sess = auth.get("sessionFile")
    if sess and os.path.exists(rel(sess)):
        try:
            session = json.load(open(rel(sess)))
            exp = session.get("expiresAt", 0)
            # Only restore NON-expired cookies. Stale cookies make many apps return 403
            # (no login form renders) → never send expired cookies.
            if session.get("cookies") and (not exp or exp > time.time()):
                await ctx.add_cookies(session["cookies"])
        except Exception:
            pass

    await page.goto(manifest["dashboardUrl"], wait_until="networkidle", timeout=30000)
    await page.wait_for_timeout(2500)
    if not await _needs_login(page):
        return  # session still valid

    creds = load_credentials(manifest)
    if not creds.get("email"):
        raise SystemExit("not logged in and no credentials available (check manifest auth.credentialsEnv)")

    await _dismiss_consent(page)
    # Recovery: if no login form is visible (e.g. 403 from stale cookies), clear cookies
    # and reload the login page fresh so the username/password form renders.
    try:
        form_visible = await page.locator("input[name='username'], input[type='email'], input[type='password']").first.is_visible(timeout=3000)
    except Exception:
        form_visible = False
    if not form_visible:
        try:
            await ctx.clear_cookies()
        except Exception:
            pass
        await page.goto(manifest.get("loginUrl") or manifest["dashboardUrl"], wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2500)
        await _dismiss_consent(page)

    user = page.locator("input[name='username'], input[type='email'], input[type='text']").first
    pwd = page.locator("input[name='password'], input[type='password']").first
    await user.fill(creds["email"])
    await pwd.fill(creds["pw"])

    submitted = False
    for loc in (page.locator("button[type='submit']").first,
                page.get_by_role("button", name=re.compile("anmeld|login|sign.?in", re.I)).first):
        try:
            await loc.click(timeout=3000)
            submitted = True
            break
        except Exception:
            continue
    if not submitted:
        await pwd.press("Enter")

    for _ in range(6):  # up to ~12s for auth to complete
        await page.wait_for_timeout(2000)
        if not await _needs_login(page):
            break
    if await _needs_login(page):
        raise SystemExit(f"login failed — still on sign-in at {page.url} (check credentials / 2FA)")

    try:
        _save_session(await ctx.cookies(), manifest)
    except Exception:
        pass
