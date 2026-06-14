"""
UNIVERSAL FLOW EXECUTOR — manifest-driven, app-agnostic action interpreter.

The per-app knowledge lives entirely in:
  - manifest task `flow`  : declarative ordered steps (this file interprets them)
  - calibration selectors : verified DOM selectors per step
  - matcher row fields    : the data ({target}, {targetName}, {label}, {amount})

→ ZERO per-app Python. A new portal = a new manifest flow + a calibration pass.
Reproduces a proven, calibrated booking flow exactly; generalises to any web portal.

Step ops:
  open_row        : find the data row by {label} and click it (opens the task dialog)
  require_buttons : classify dialog — skip[] → skip_already_assigned; if none of manual[] → skip_suggestion_review
  click           : click a calibrated selector (text→coord fallback)
  type            : click a calibrated input (by placeholder) and type a templated value
  pick_option     : click an option by exact/contains text (templated)
  confirm         : dry_run → verify selection + Escape (no commit); execute → click confirm + verify post-state
"""
import re


def _resolve(value, row):
    """Replace {field} placeholders from the row dict."""
    if not isinstance(value, str):
        return value
    out = value
    for k, v in row.items():
        out = out.replace("{" + k + "}", str(v if v is not None else ""))
    return out


async def _click_selector(page, sel):
    """Click a calibrated selector: prefer text, fall back to coordinate."""
    text = (sel or {}).get("text")
    if text:
        try:
            await page.get_by_text(text, exact=False).first.click(timeout=5000)
            return
        except Exception:
            pass
    if sel and sel.get("x") is not None:
        await page.mouse.click(sel["x"], sel["y"])
        return
    raise RuntimeError(f"selector not clickable: {sel}")


async def _dialog_buttons(page):
    return await page.evaluate(
        r"""()=>{const d=document.querySelector('[role=dialog],.modal,[aria-modal=true]');"""
        r"""return d?[...d.querySelectorAll('button')].map(b=>(b.innerText||'').trim().toUpperCase()).filter(Boolean):[]}"""
    )


async def execute_flow(page, row, flow, selectors, dry_run):
    """Run one data row through the declarative flow. Returns a result string.
    Raises RuntimeError('verify_failed: ...') if execute post-state can't be proven."""
    for step in flow:
        op = step.get("op")

        if op == "open_row":
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

        elif op == "require_buttons":
            btns = await _dialog_buttons(page)
            for s in step.get("skip", []):
                if any(s.upper() in b for b in btns):
                    await page.keyboard.press("Escape")
                    return "skip_already_assigned"
            manual = step.get("manual", [])
            if manual and not any(any(m.upper() in b for b in btns) for m in manual):
                await page.keyboard.press("Escape")
                return "skip_suggestion_review"

        elif op == "click":
            await _click_selector(page, selectors.get(step["selector"]))
            await page.wait_for_timeout(step.get("wait", 1200))

        elif op == "type":
            sel = selectors.get(step["selector"]) or {}
            ph = sel.get("placeholder")
            field = page.get_by_placeholder(re.compile(re.escape(ph[:20]), re.I)).first if ph else page.locator("input").last
            await field.click()
            await field.type(_resolve(step["value"], row), delay=40)
            await page.wait_for_timeout(step.get("wait", 2000))

        elif op == "pick_option":
            val = _resolve(step["value"], row)
            exact = step.get("match", "exact") == "exact"
            opt = page.get_by_text(val, exact=exact)
            if await opt.count() == 0:
                await page.keyboard.press("Escape")
                raise RuntimeError(f"option not found: {val!r}")
            await opt.first.click(timeout=4000)
            await page.wait_for_timeout(800)

        elif op == "confirm":
            sel = selectors.get(step["selector"]) or {}
            if dry_run:
                # verify selection reflected (input value) + confirm enabled, then back out
                ctext = sel.get("text", "ZUORDNEN")
                sel_ok = await page.evaluate(
                    "([n,c]) => { const d=document.querySelector('[role=dialog],.modal')||document.body;"
                    " const inSel=[...d.querySelectorAll('input')].some(e=>(e.value||'').includes(n))||(d.innerText||'').includes(n);"
                    " const z=[...d.querySelectorAll('button')].find(b=>new RegExp(c,'i').test(b.innerText||''));"
                    " return inSel && (z?!z.disabled:false); }",
                    [_resolve(step.get("expect", "{targetName}"), row), ctext],
                )
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(400)
                return "dry_run_ok" if sel_ok else "dry_run_unverified"
            # execute
            await _click_selector(page, sel)
            await page.wait_for_timeout(1500)
            if step.get("verify") == "dialog_closed":
                dlg = await page.evaluate("()=>!!document.querySelector('[role=dialog],.modal,[aria-modal=true]')")
                if dlg:
                    try:
                        await page.keyboard.press("Escape")
                    except Exception:
                        pass
                    raise RuntimeError("verify_failed: Dialog nach Confirm noch offen — nicht bestaetigt")
            return "booked"

        else:
            raise RuntimeError(f"unknown flow op: {op}")

    return "completed"
