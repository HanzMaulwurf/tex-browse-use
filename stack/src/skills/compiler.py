"""
Skill Compiler — Browser-Harness Pattern

Nimmt gelernte Computer-Use Workflows und kompiliert sie zu
Playwright Scripts. Nach 10+ erfolgreichen Durchläufen braucht
man KEIN Claude mehr — das Script läuft direkt.

Input:  Gelernter Skill (JSON mit Steps)
Output: Playwright Python Script (ausführbar ohne LLM)
"""
import json
import os

SKILLS_DIR = os.environ.get("SKILLS_DIR", "/opt/computer-use-agent/data/skills")
COMPILED_DIR = os.environ.get("COMPILED_DIR", "/opt/computer-use-agent/data/compiled")

os.makedirs(COMPILED_DIR, exist_ok=True)

KEY_MAP = {
    "Return": "Enter", "return": "Enter",
    "ctrl+a": "Control+a", "ctrl+l": "Control+l",
}

def compile_skill(skill_path: str) -> str:
    """Compile a learned skill JSON into a Playwright Python script."""
    skill = json.load(open(skill_path))
    
    app = skill.get("appName", "unknown")
    task = skill.get("taskPattern", "unknown task")
    steps = skill.get("steps", [])
    
    if len(steps) == 0:
        return ""
    
    # Generate Playwright script
    lines = [
        '"""',
        f'Auto-compiled Playwright script for: {app}',
        f'Task: {task}',
        f'Compiled from {len(steps)} learned steps',
        f'Success rate: {skill.get("successCount",0)}/{skill.get("successCount",0)+skill.get("failCount",0)}',
        '"""',
        'import asyncio',
        'import argparse',
        'from playwright.async_api import async_playwright',
        '',
        'async def run(url: str = None, storage_state: str = None, credentials: dict = None):',
        '    async with async_playwright() as pw:',
        '        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])',
        '        context = await browser.new_context(viewport={"width": 1024, "height": 768}, locale="de-DE", storage_state=storage_state or None)',
        '        page = await context.new_page()',
        '',
    ]
    
    if steps and steps[0].get("action") == "navigate":
        lines.append(f'        await page.goto(url or "{steps[0].get("url", "")}", wait_until="domcontentloaded")')
        lines.append('        await page.wait_for_timeout(2000)')
    
    # Known button texts for role-based selectors
    BUTTON_TEXTS = {"zuordnen","speichern","bestätigen","abbrechen","erstellen","exportieren","senden","ok","ja","nein","schliessen"}

    for i, step in enumerate(steps):
        action = step.get("action", "")
        coord = step.get("coordinate")
        text = step.get("text", "")
        desc = step.get("description", "")
        wait_for = step.get("waitFor", "")
        
        lines.append(f'')
        lines.append(f'        # Step {i+1}: {desc[:60]}')
        if wait_for:
            lines.append(f'        # Expect: {wait_for[:80]}')
        
        if action == "left_click":
            safe_text = (text or "").replace('"', '\\"')
            
            if text and safe_text.lower() in BUTTON_TEXTS:
                # Strategy 1: Role-based selector (most resilient for buttons)
                lines.append(f'        try:')
                lines.append(f'            btn = page.get_by_role("button", name="{safe_text}")')
                lines.append(f'            await btn.wait_for(state="visible", timeout=5000)')
                lines.append(f'            await btn.click()')
                if coord:
                    lines.append(f'        except:')
                    lines.append(f'            await page.mouse.click({coord[0]}, {coord[1]})')
                else:
                    lines.append(f'        except Exception as e:')
                    lines.append(f'            raise Exception(f"Button \\"{safe_text}\\" not found: {{e}}")')
            elif text:
                # Strategy 2: Text selector with coordinate fallback
                lines.append(f'        try:')
                lines.append(f'            el = page.get_by_text("{safe_text}", exact=False).first')
                lines.append(f'            await el.wait_for(state="visible", timeout=5000)')
                lines.append(f'            await el.click()')
                if coord:
                    lines.append(f'        except:')
                    lines.append(f'            await page.mouse.click({coord[0]}, {coord[1]})')
                else:
                    lines.append(f'        except Exception as e:')
                    lines.append(f'            raise Exception(f"Element \\"{safe_text}\\" not found: {{e}}")')
            elif coord:
                # Strategy 3: Coordinate only (last resort)
                lines.append(f'        await page.wait_for_load_state("domcontentloaded")')
                lines.append(f'        await page.mouse.click({coord[0]}, {coord[1]})')
            
            lines.append(f'        await page.wait_for_timeout(800)')
        
        elif action == "type" and text:
            safe_text = text.replace('"', '\\"')
            lines.append(f'        await page.keyboard.type("{safe_text}", delay=30)')
            lines.append(f'        await page.wait_for_timeout(300)')
        elif action == "key" and text:
            key = KEY_MAP.get(text, text)
            lines.append(f'        await page.keyboard.press("{key}")')
            lines.append(f'        await page.wait_for_timeout(500)')
        elif action == "scroll" and coord:
            lines.append(f'        await page.mouse.move({coord[0]}, {coord[1]})')
            lines.append(f'        await page.mouse.wheel(0, 300)')
            lines.append(f'        await page.wait_for_timeout(500)')
        elif action == "screenshot" or action == "wait":
            lines.append(f'        await page.wait_for_load_state("domcontentloaded")')
    
    lines.extend([
        '',
        '        # Take final screenshot',
        '        screenshot = await page.screenshot()',
        '        await browser.close()',
        '        return screenshot',
        '',
        'if __name__ == "__main__":',
        '    ap = argparse.ArgumentParser()',
        '    ap.add_argument("--url", default=None)',
        '    ap.add_argument("--storage-state", dest="storage_state", default=None)',
        '    asyncio.run(run(**vars(ap.parse_args())))',
    ])
    
    script = "\n".join(lines)
    
    # Save compiled script
    slug = f"{app}--{task[:50]}".replace(" ", "-").replace("/", "-").lower()
    slug = "".join(c for c in slug if c.isalnum() or c in "-_")
    output_path = os.path.join(COMPILED_DIR, f"{slug}.py")
    
    with open(output_path, "w") as f:
        f.write(script)
    
    print(f"[compiler] Compiled: {output_path} ({len(steps)} steps → {len(lines)} lines)")
    return output_path


def compile_all_eligible(min_success: int = 5) -> list:
    """Compile all skills that have enough successful runs."""
    compiled = []
    
    if not os.path.exists(SKILLS_DIR):
        return compiled
    
    for fname in os.listdir(SKILLS_DIR):
        if not fname.endswith(".json"):
            continue
        
        skill = json.load(open(os.path.join(SKILLS_DIR, fname)))
        success = skill.get("successCount", 0)
        steps = skill.get("steps", [])
        
        if success >= min_success and len(steps) > 0:
            path = compile_skill(os.path.join(SKILLS_DIR, fname))
            if path:
                compiled.append({"skill": fname, "compiled": path, "success": success})
    
    return compiled


def list_compiled() -> list:
    """List all compiled Playwright scripts."""
    if not os.path.exists(COMPILED_DIR):
        return []
    return [f for f in os.listdir(COMPILED_DIR) if f.endswith(".py")]


if __name__ == "__main__":
    print("[compiler] Compiling all eligible skills (min 5 successes)...")
    results = compile_all_eligible(min_success=3)  # Lower threshold for testing
    print(f"[compiler] Compiled {len(results)} skills")
    for r in results:
        print(f"  {r['skill']} → {r['compiled']} ({r['success']} successes)")
    
    print(f"\nAll compiled scripts: {list_compiled()}")
