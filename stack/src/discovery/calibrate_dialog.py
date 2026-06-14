"""
DIALOG CALIBRATION (manifest-driven) — read-only capture of an app's task dialog DOM.

App-agnostic: driven entirely by apps/<app>/manifest.json. Captures the interactive
elements of the dialog that opens for a task's first data row, maps them to the
task's required/optional selector names, and writes them to the task's calibration
file. It NEVER confirms/submits — presses Escape to close. Nothing in the app changes.

USAGE (read-only, only on green light):
    python src/discovery/calibrate_dialog.py --app acme --task export-report
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src"))
from engine.manifest import load_manifest, get_task, ensure_logged_in, rel  # noqa: E402

EXTRACT_JS = r"""() => {
  const dlg = document.querySelector('[role="dialog"], .modal, [aria-modal="true"]') || document.body;
  const scoped = dlg !== document.body;
  const out = [];
  const sel = 'button, input, select, textarea, [role="button"], [role="combobox"], [role="option"], a';
  for (const el of dlg.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.value || '').trim().slice(0, 60),
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  return { scopedToDialog: scoped, count: out.length, elements: out };
}"""

# Semantic hints per selector name (extend as more apps/tasks are onboarded).
SELECTOR_HINTS = {
    "category_field": ["kategorie", "konto", "buchungskonto", "category", "account"],
    "tax_field": ["steuer", "ust", "umsatzsteuer", "tax", "vat"],
    "confirm_button": ["annehmen", "zuordnen", "übernehmen", "speichern", "buchen", "save", "assign", "accept"],
    "reject_button": ["ablehnen", "verwerfen", "reject", "discard"],
    "confirm_dialog_button": ["bestätig", "ja", "ok", "confirm", "yes"],
}


async def calibrate(app, task_name, manifest_path):
    from playwright.async_api import async_playwright

    manifest = load_manifest(app, manifest_path)
    name, task = get_task(manifest, task_name)
    out_file = rel(task["calibration"])
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    vp = manifest.get("viewport", {"width": 1280, "height": 900})

    result = {
        "appName": manifest["appName"], "task": name, "dialog": task.get("dialog"),
        "capturedAt": int(time.time()), "readOnly": True,
    }

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport=vp, locale=manifest.get("locale", "de-DE"))
        page = await ctx.new_page()
        await ensure_logged_in(page, ctx, manifest)
        print(f"[calibrate] logged in: {page.url}")

        await page.goto(task["entryUrl"], wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(3000)

        # Open a REAL data row (MUI DataGrid rows contain a currency amount). Require an
        # actual modal ([role=dialog]) to appear — never accept the list page as "opened".
        opened = False
        money = re.compile(r"\d[.,]\d{2}\s*€")
        rows = page.get_by_role("row").filter(has_text=money)
        for cand in [rows.first, rows.nth(1), page.get_by_role("row").nth(1)]:
            try:
                await cand.click(timeout=4000)
                await page.wait_for_timeout(1800)
                probe = await page.evaluate(EXTRACT_JS)
                if probe["scopedToDialog"]:
                    opened = True
                    break
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(400)
            except Exception as e:
                print(f"[calibrate] row click attempt failed: {e}")

        snap = await page.evaluate(EXTRACT_JS)
        result["dialogOpened"] = opened
        result["scopedToDialog"] = snap["scopedToDialog"]
        result["elements"] = snap["elements"]
        wanted = list(task.get("requiredSelectors", [])) + list(task.get("optionalSelectors", []))

        await page.keyboard.press("Escape")  # READ-ONLY: never confirm
        await page.wait_for_timeout(500)

        # Only map selectors if a real dialog actually opened — never write guesses
        # from the list/login page (that produced false matches before).
        if not (opened or snap["scopedToDialog"]):
            result["status"] = "dialog_not_opened"
            result["selectors"] = {}
            json.dump(result, open(out_file, "w"), ensure_ascii=False, indent=2)
            await browser.close()
            raise SystemExit(
                f"CALIBRATION FAILED: no dialog opened (captured {len(snap['elements'])} "
                f"elements from {page.url}). Wrote status=dialog_not_opened, NO selectors. "
                "The precision validator stays BLOCKED — by design, no guessing."
            )

        def find(needles):
            for el in snap["elements"]:
                hay = " ".join([el["text"], el["placeholder"], el["ariaLabel"], el["name"], el["dataTestId"]]).lower()
                if any(n in hay for n in needles):
                    return el
            return None

        result["status"] = "ok"
        result["selectors"] = {k: find(SELECTOR_HINTS.get(k, [k])) for k in wanted}

        json.dump(result, open(out_file, "w"), ensure_ascii=False, indent=2)
        print(f"[calibrate] wrote {out_file}  (dialogOpened={opened}, elements={len(snap['elements'])})")
        for k in wanted:
            v = result["selectors"][k]
            print(f"  {k}: {'FOUND ' + repr(v['text'] or v['placeholder']) if v else 'NOT FOUND — inspect elements[]'}")
        await browser.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--app")
    ap.add_argument("--task")
    ap.add_argument("--manifest")
    a = ap.parse_args()
    asyncio.run(calibrate(a.app, a.task, a.manifest))
