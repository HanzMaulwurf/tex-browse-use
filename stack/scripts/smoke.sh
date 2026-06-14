#!/usr/bin/env bash
# Regression smoke net for the computer-use / browser-use stack.
# Exercises every wired tier through the LIVE services. Exit 0 = all green.
set -u
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

jget(){ python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))" 2>/dev/null; }

echo "== health =="
for p in 18802 18803 18804 18805; do
  s=$(curl -s -m6 http://127.0.0.1:$p/health | jget status)
  [ "$s" = "healthy" ] && ok ":$p healthy" || no ":$p health=$s"
done

poll(){ # $1 base url path prefix (/task or /persistent), $2 id
  for i in $(seq 1 25); do
    sleep 3
    st=$(curl -s -m8 http://127.0.0.1:18802$1/$2 | jget status)
    case "$st" in completed) return 0;; failed|cancelled) echo "    (status=$st)"; return 1;; esac
  done
  echo "    (timeout, last=$st)"; return 1
}

echo "== computer-use /task =="
R=$(curl -s -m20 -XPOST http://127.0.0.1:18802/task -H 'Content-Type: application/json' \
  -d '{"task":"Report the main heading then say AUFGABE ERLEDIGT","url":"https://example.com","tenantId":"smoke"}')
ID=$(echo "$R" | jget id); S=$(echo "$R" | jget status)
if [ "$S" = "completed" ]; then ok "/task completed (fast)"; elif [ -n "$ID" ] && poll /task "$ID"; then ok "/task completed"; else no "/task"; fi

echo "== persistent /persistent =="
R=$(curl -s -m20 -XPOST http://127.0.0.1:18802/persistent -H 'Content-Type: application/json' \
  -d '{"task":"Report the main heading then say AUFGABE ERLEDIGT","url":"https://example.com","appName":"","tenantId":"smoke"}')
ID=$(echo "$R" | jget id); S=$(echo "$R" | jget status)
if [ "$S" = "completed" ]; then ok "/persistent completed (fast)"; elif [ -n "$ID" ] && poll /persistent "$ID"; then ok "/persistent completed"; else no "/persistent (id=$ID s=$S)"; fi

echo "== compiled /compiled/run =="
cat > data/compiled/_smoke.py <<'PY'
import asyncio,argparse
from playwright.async_api import async_playwright
async def run(url=None,storage_state=None,credentials=None):
    async with async_playwright() as pw:
        b=await pw.chromium.launch(headless=True,args=["--no-sandbox"]); c=await b.new_context(storage_state=storage_state or None)
        p=await c.new_page(); await p.goto(url or "https://example.com"); t=await p.title(); await b.close(); assert t; return t
if __name__=="__main__":
    ap=argparse.ArgumentParser(); ap.add_argument("--url"); ap.add_argument("--storage-state",dest="storage_state"); asyncio.run(run(**vars(ap.parse_args())))
PY
SP="$(pwd)/data/compiled/_smoke.py"
OKR=$(curl -s -m30 -XPOST http://127.0.0.1:18802/compiled/run -H 'Content-Type: application/json' \
  -d "{\"scriptPath\":\"$SP\",\"url\":\"https://example.com\",\"appName\":\"testapp\"}" | jget ok)
[ "$OKR" = "True" ] && ok "/compiled/run ok" || no "/compiled/run ok=$OKR"
rm -f data/compiled/_smoke.py

echo "== gateway /solve =="
SUC=$(curl -s -m170 -XPOST http://127.0.0.1:18804/solve -H 'Content-Type: application/json' \
  -d '{"task":"Report the link text on this page","url":"https://example.com"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['attempts'][0].get('success'))" 2>/dev/null)
[ "$SUC" = "True" ] && ok "/solve success" || no "/solve success=$SUC"

echo "== RESULT: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
