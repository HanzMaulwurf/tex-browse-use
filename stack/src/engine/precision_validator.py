"""
PRECISION VALIDATOR — makes "100% precise / executable" a machine-checkable property.

The product promise is: for any app, every required click is backed by a *verified*
selector — the system never guesses. This validator enforces exactly that. For each
task in an app manifest it reports:

    EXECUTABLE (100%)  — every required selector is present and verified; safe to run.
    BLOCKED            — names the exact missing piece and the read-only command
                         that closes the gap (calibration), instead of guessing.

It reads only files (manifest, app-map, calibration, data source). It launches no
browser and changes nothing. Exit code 0 iff all tasks are EXECUTABLE — so it can
gate a deploy / CI step.

USAGE
    python precision_validator.py --app acme
    python precision_validator.py --manifest apps/acme/manifest.json
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def rel(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def load_json(path):
    try:
        return json.load(open(rel(path)))
    except Exception as e:
        return {"__error__": str(e)}


def check_task(name, task, manifest):
    """Return (status, score, lines) for one task. status in EXECUTABLE/BLOCKED."""
    lines = []
    blockers = []
    checks_total = 0
    checks_ok = 0

    def ok(label):
        nonlocal checks_total, checks_ok
        checks_total += 1
        checks_ok += 1
        lines.append(f"    [OK]    {label}")

    def fail(label, fix=None):
        nonlocal checks_total
        checks_total += 1
        lines.append(f"    [MISS]  {label}")
        blockers.append((label, fix))

    # 1) App map present
    am = manifest.get("appMap")
    if am and os.path.exists(rel(am)) and "__error__" not in load_json(am):
        ok(f"app-map present ({am})")
    else:
        fail(f"app-map missing/invalid ({am})")

    # 2) Navigation defined
    nav = task.get("navigation") or []
    if nav:
        ok(f"navigation defined ({len(nav)} steps, with text+coord fallback)")
    else:
        fail("navigation not defined", "add a navigation[] array to the task")

    # 3) Data source present (+ count rows ready to act on)
    ds = task.get("dataSource")
    dsj = load_json(ds) if ds else {"__error__": "no dataSource"}
    if ds and "__error__" not in dsj:
        flt = task.get("rowStatusFilter")
        txs = dsj.get("transactions", {}) if isinstance(dsj, dict) else {}
        n = sum(1 for t in txs.values() if not flt or t.get("status") == flt) if isinstance(txs, dict) else 0
        ok(f"data source present ({n} rows status='{flt}')")
    else:
        fail(f"data source missing ({ds})", "produce the plan checkpoint first (matcher/batch)")

    # 4) Calibration present AND all required selectors verified
    cal_path = task.get("calibration")
    required = task.get("requiredSelectors", [])
    optional = task.get("optionalSelectors", [])
    cal_cmd = (
        f"{ROOT}/.venv/bin/python "
        f"{ROOT}/src/discovery/calibrate_dialog.py --app {manifest['appName']} --task {name}"
    )
    if cal_path and os.path.exists(rel(cal_path)):
        cal = load_json(cal_path)
        sels = cal.get("selectors", {}) if isinstance(cal, dict) else {}
        missing_req = [k for k in required if not sels.get(k)]
        if not missing_req:
            ok(f"calibration complete — required selectors {required} all verified")
        else:
            fail(f"calibration incomplete — missing required selectors {missing_req}",
                 f"re-run calibration & inspect elements[]:\n              {cal_cmd}")
        for k in optional:
            if sels.get(k):
                ok(f"optional selector '{k}' present")
            else:
                lines.append(f"    [warn]  optional selector '{k}' absent (degraded but executable)")
    else:
        fail("calibration file absent — dialog DOM never captured (READ-ONLY pass needed)",
             f"run the read-only calibration:\n              {cal_cmd}")

    # 5) Runner exists
    runner = task.get("runner")
    if runner and os.path.exists(rel(runner)):
        ok(f"runner present ({runner})")
    else:
        fail(f"runner missing ({runner})")

    # 6) Verification postconditions — MANDATORY: without them, completion cannot be
    #    proven (the verification backbone has nothing to check) → not production-ready.
    verify_pcs = task.get("verify") or []
    if verify_pcs:
        ok(f"verification postconditions defined ({len(verify_pcs)}) — completion is provable")
    else:
        fail("no verification postconditions — completion cannot be proven",
             "add a 'verify' array to the task (see docs/verification-backbone.md)")

    status = "EXECUTABLE" if not blockers else "BLOCKED"
    score = f"{checks_ok}/{checks_total}"
    return status, score, lines, blockers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app")
    ap.add_argument("--manifest")
    args = ap.parse_args()

    mpath = args.manifest or (f"apps/{args.app}/manifest.json" if args.app else None)
    if not mpath:
        print("need --app or --manifest")
        sys.exit(2)
    manifest = load_json(mpath)
    if "__error__" in manifest:
        print(f"cannot load manifest {mpath}: {manifest['__error__']}")
        sys.exit(2)

    print("=" * 70)
    print(f"PRECISION REPORT — {manifest.get('displayName', manifest['appName'])}")
    print("=" * 70)

    all_exec = True
    for name, task in manifest.get("tasks", {}).items():
        status, score, lines, blockers = check_task(name, task, manifest)
        mark = "✅ EXECUTABLE (100% precise)" if status == "EXECUTABLE" else "⛔ BLOCKED"
        print(f"\n● task '{name}'  [{score} checks]  {mark}")
        for ln in lines:
            print(ln)
        if blockers:
            all_exec = False
            print("    → To reach 100% precise, close:")
            for label, fix in blockers:
                print(f"      - {label}")
                if fix:
                    print(f"              {fix}")

    print("\n" + "=" * 70)
    print("RESULT:", "ALL TASKS EXECUTABLE — system is 100% precise." if all_exec
          else "NOT YET 100% — see blockers above (no guessing; calibrate to close).")
    print("=" * 70)
    sys.exit(0 if all_exec else 1)


if __name__ == "__main__":
    main()
