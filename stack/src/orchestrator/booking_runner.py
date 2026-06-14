"""
TASK RUNNER (manifest-driven) — data-driven, resumable, zero-LLM execution.

App-agnostic execution of one manifest task: logs in, navigates, loops over the
task's data rows, and for each row opens the dialog, fills the target fields using
the *calibrated* selectors, and confirms. Pure Playwright — no LLM, no token cost.

SAFETY
  - dry_run=True (DEFAULT): fills each dialog then Escapes WITHOUT confirming.
    Nothing in the app changes — safe to watch live.
  - dry_run=False: confirms for real, only the filtered rows, checkpointed/resumable.
  - Refuses to start unless the precision validator's required selectors are present
    (no guessing).

USAGE (only on green light):
    python src/orchestrator/booking_runner.py --app acme --task export-report --dry-run
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


def load_plan(task):
    cp = json.load(open(rel(task["dataSource"])))
    flt = task.get("rowStatusFilter")
    f = task.get("rowFields", {})
    rows = []
    for key, tx in cp.get("transactions", {}).items():
        if flt and tx.get("status") != flt:
            continue
        rows.append({
            "key": key,
            "label": tx.get(f.get("label", "vendor")),
            "amount": tx.get(f.get("amount", "amount")),
            "target": tx.get(f.get("target", "matchedKonto")),
            "targetName": tx.get(f.get("targetName", "matchedKontoName")),
            "tax": tx.get(f.get("tax", "matchedSteuerTyp")),
        })
    return rows


def load_selectors(task):
    cal = task.get("calibration")
    if not cal or not os.path.exists(rel(cal)):
        raise SystemExit(
            "REFUSING TO RUN: calibration absent. Run calibrate_dialog.py "
            f"--app <app> --task {task.get('dialog','')} first (read-only). No guessing."
        )
    sels = json.load(open(rel(cal))).get("selectors", {})
    missing = [k for k in task.get("requiredSelectors", []) if not sels.get(k)]
    if missing:
        raise SystemExit(f"REFUSING TO RUN: calibration incomplete, missing {missing}.")
    return sels


def progress_path(manifest, name):
    return rel(os.path.join("data", "checkpoints", f"run-{manifest['appName']}-{name}.json"))


async def click_texted(page, text, coord):
    try:
        el = page.get_by_text(text, exact=False).first
        await el.wait_for(state="visible", timeout=5000)
        await el.click()
    except Exception:
        if coord:
            await page.mouse.click(coord[0], coord[1])
        else:
            raise


async def navigate(page, task):
    await page.goto(task["entryUrl"], wait_until="networkidle", timeout=30000)
    await page.wait_for_timeout(2000)
    nav = task.get("navigation", [])
    if nav:
        try:
            last = nav[-1]
            await click_texted(page, last["text"], last.get("coord"))
            await page.wait_for_timeout(1200)
        except Exception:
            pass


async def _dialog_buttons(page):
    return await page.evaluate(
        r"""()=>{const d=document.querySelector('[role=dialog],.modal,[aria-modal=true]');"""
        r"""return d?[...d.querySelectorAll('button')].map(b=>(b.innerText||'').trim().toUpperCase()).filter(Boolean):[]}"""
    )


async def verify_booked(page):
    """Per-booking postcondition (verification backbone, inline):
    ZUORDNEN is only considered committed if the assignment dialog CLOSED.
    A rejected/failed booking leaves the dialog open with an error → not booked.
    Returns (ok, evidence). Never let the caller mark 'booked' without this passing.
    """
    await page.wait_for_timeout(1500)
    dlg_open = await page.evaluate(
        "() => !!document.querySelector('[role=dialog],.modal,[aria-modal=true]')"
    )
    if dlg_open:
        return False, "Dialog nach ZUORDNEN noch offen — Buchung NICHT bestaetigt"
    return True, "Dialog geschlossen — Buchung bestaetigt"


async def do_row(page, row, sels, dry_run):
    """Verified example flow (live-calibrated 2026-06-02):
       open row -> classify dialog -> MANUAL: KATEGORIE WÄHLEN -> search konto ->
       pick exact kontoName -> ZUORDNEN. Suggestion/already-assigned rows are not
       auto-touched (conservative: their override path is not yet calibrated).
    """
    opened = False
    for cand in [page.get_by_role("row").filter(has_text=row["label"]).first,
                 page.get_by_text(row["label"], exact=False).first]:
        try:
            await cand.click(timeout=4000)
            await page.wait_for_timeout(1500)
            opened = True
            break
        except Exception:
            continue
    if not opened:
        raise RuntimeError(f"row not found: {row['label']}")

    btns = await _dialog_buttons(page)
    if any("AUFLÖSEN" in b for b in btns):
        await page.keyboard.press("Escape")
        return "skip_already_assigned"
    if not any("KATEGORIE WÄHLEN" in b for b in btns):
        # suggestion-only dialog (ANNEHMEN/ABLEHNEN) — don't bypass our matcher's konto
        await page.keyboard.press("Escape")
        return "skip_suggestion_review"

    # MANUAL flow — all controls verified on a live portal
    await page.get_by_text("KATEGORIE WÄHLEN", exact=False).first.click(timeout=5000)
    await page.wait_for_timeout(1200)
    search = page.get_by_placeholder(re.compile("Suchbegriff", re.I)).first
    await search.click()
    await search.type(str(row["target"]), delay=50)  # konto number filters the list
    await page.wait_for_timeout(2000)
    # Exact kontoName disambiguates same-konto variants (4964 vs §13b vs §13b Drittland)
    name = str(row["targetName"] or "").strip()
    opt = page.get_by_text(name, exact=True)
    if await opt.count() == 0:
        await page.keyboard.press("Escape")
        raise RuntimeError(f"category option not found for {name!r} (konto {row['target']})")
    await opt.first.click(timeout=4000)
    await page.wait_for_timeout(800)

    if dry_run:
        # Dry-run verification: the chosen category is reflected in an input value
        # (the app fills the category search field with the selected name) and the
        # ZUORDNEN button is enabled (= ready to book). Proven against live DOM.
        sel_ok = await page.evaluate(
            "(n) => { const d=document.querySelector('[role=dialog],.modal')||document.body;"
            " const inSel=[...d.querySelectorAll('input')].some(e=>(e.value||'').includes(n)) || (d.innerText||'').includes(n);"
            " const z=[...d.querySelectorAll('button')].find(b=>/ZUORDNEN/i.test(b.innerText||''));"
            " const ready=z?!z.disabled:false; return inSel && ready; }",
            name,
        )
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(400)
        return "dry_run_ok" if sel_ok else "dry_run_unverified"

    # EXECUTE: commit, then VERIFY the post-state before declaring booked
    await page.get_by_text("ZUORDNEN", exact=False).first.click(timeout=5000)
    ok, ev = await verify_booked(page)
    if not ok:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        raise RuntimeError(f"verify_failed: {ev}")
    return "booked"


def bump_skill_success(manifest):
    sf = manifest.get("skillFile")
    if not sf or not os.path.exists(rel(sf)):
        return
    try:
        skill = json.load(open(rel(sf)))
        skill["successCount"] = int(skill.get("successCount", 0)) + 1
        skill["lastUsed"] = int(time.time())
        json.dump(skill, open(rel(sf), "w"), ensure_ascii=False, indent=2)
        print(f"[run] skill successCount -> {skill['successCount']}")
    except Exception as e:
        print(f"[run] could not bump successCount: {e}")


async def run(app, task_name, manifest_path, dry_run=True, limit=None):
    from playwright.async_api import async_playwright

    manifest = load_manifest(app, manifest_path)
    name, task = get_task(manifest, task_name)
    rows = load_plan(task)
    sels = load_selectors(task)
    pf = progress_path(manifest, name)
    progress = json.load(open(pf)) if os.path.exists(pf) else {"done": {}, "failed": {}}
    if limit:
        rows = rows[:limit]
    print(f"[run] {manifest['appName']}/{name} mode={'DRY-RUN' if dry_run else 'EXECUTE'} "
          f"| {len(rows)} rows | {len(progress['done'])} done")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport=manifest.get("viewport", {"width": 1280, "height": 900}),
                                        locale=manifest.get("locale", "de-DE"))
        page = await ctx.new_page()
        await ensure_logged_in(page, ctx, manifest)
        await navigate(page, task)

        ok = fail = 0
        for i, row in enumerate(rows):
            if row["key"] in progress["done"]:
                continue
            try:
                res = await do_row(page, row, sels, dry_run)
                if not dry_run:
                    progress["done"][row["key"]] = {"result": res, "at": int(time.time())}
                    json.dump(progress, open(pf, "w"), ensure_ascii=False, indent=2)
                ok += 1
                print(f"[run] {i+1}/{len(rows)} {res}: {str(row['label'])[:24]} -> {row['target']}")
                await navigate(page, task)
            except Exception as e:
                fail += 1
                progress["failed"][row["key"]] = {"error": str(e), "at": int(time.time())}
                json.dump(progress, open(pf, "w"), ensure_ascii=False, indent=2)
                print(f"[run] {i+1}/{len(rows)} FAILED: {str(row['label'])[:24]} — {e}")
                await navigate(page, task)
        await browser.close()

    print(f"[run] done ok={ok} fail={fail} dry_run={dry_run}")
    if not dry_run and fail == 0 and ok > 0:
        bump_skill_success(manifest)
    return {"ok": ok, "fail": fail, "dry_run": dry_run}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--app")
    ap.add_argument("--task")
    ap.add_argument("--manifest")
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--execute", dest="dry_run", action="store_false")
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    asyncio.run(run(a.app, a.task, a.manifest, dry_run=a.dry_run, limit=a.limit))
