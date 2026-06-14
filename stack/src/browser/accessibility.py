"""
Accessibility Tree Extractor — das Beste aus Browser-Use, ohne den Overhead.

Extrahiert klickbare Elemente als Text statt Screenshots.
→ 10x billiger (200 Tokens statt 3500 pro Seite)
→ Für bekannte Apps mit klarem HTML
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import asyncio
import os

PORT = int(os.environ.get("A11Y_PORT", "18805"))

async def extract_tree(url: str) -> dict:
    """Extract clickable elements from a page as structured text."""
    from playwright.async_api import async_playwright
    
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1024, "height": 768}, locale="de-DE")
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(2000)
        
        # Extract all interactive elements
        elements = await page.evaluate("""() => {
            const results = [];
            const interactiveSelectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [href]';
            const els = document.querySelectorAll(interactiveSelectors);
            
            els.forEach((el, idx) => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return;
                if (rect.top > window.innerHeight) return;
                
                const text = (el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 80);
                if (!text && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') return;
                
                results.push({
                    idx: idx,
                    tag: el.tagName.toLowerCase(),
                    type: el.getAttribute('type') || '',
                    text: text,
                    role: el.getAttribute('role') || '',
                    x: Math.round(rect.x + rect.width / 2),
                    y: Math.round(rect.y + rect.height / 2),
                    href: el.getAttribute('href') || '',
                });
            });
            return results;
        }""")
        
        title = await page.title()
        current_url = page.url
        
        # Build text representation (what the LLM sees instead of screenshot)
        tree_text = f"Page: {title}\nURL: {current_url}\n\nInteractive Elements:\n"
        for el in elements:
            tag_str = el['tag']
            if el['type']: tag_str += f'[{el["type"]}]'
            if el['role']: tag_str += f'({el["role"]})'
            tree_text += f"  [{el['idx']}] <{tag_str}> \"{el['text']}\" @ ({el['x']},{el['y']})\n"
        
        await browser.close()
        
        return {
            "url": current_url,
            "title": title,
            "elementCount": len(elements),
            "elements": elements,
            "treeText": tree_text,
            "tokenEstimate": len(tree_text) // 4,
        }


class TreeHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): 
        print(f"[a11y] {args[0]}")

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "healthy", "service": "accessibility-tree", "port": PORT})
            return
        self._respond(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        
        if self.path == "/extract":
            url = body.get("url", "")
            if not url:
                self._respond(400, {"error": "missing url"})
                return
            try:
                result = asyncio.run(extract_tree(url))
                self._respond(200, result)
            except Exception as e:
                self._respond(500, {"error": str(e)})
            return
        
        self._respond(404, {"error": "not found"})

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())


if __name__ == "__main__":
    print(f"[a11y] Accessibility Tree Extractor on port {PORT}")
    print(f"[a11y] POST /extract {{url}} → structured elements (10x cheaper than screenshots)")
    HTTPServer(("127.0.0.1", PORT), TreeHandler).serve_forever()
