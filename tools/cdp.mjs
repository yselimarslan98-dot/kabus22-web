// Minimal headless-Chrome driver over the DevTools protocol for testing the game.
// Usage: node tools/cdp.mjs <url> <script.json>
// script: [{ "wait": ms } | { "eval": "js expr" } | { "shot": "file.png" } | { "key": "Enter", "hold": ms }]
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [, , url, scriptFile] = process.argv;
const steps = JSON.parse(readFileSync(scriptFile, 'utf8'));
const port = 9300 + Math.floor(Math.random() * 500);
// K22_PROFILE keeps IndexedDB (converted videos, saves) between runs.
const profile = process.env.K22_PROFILE || mkdtempSync(join(tmpdir(), 'k22cdp-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, id = 0, pausedResolve = null;
const pending = new Map();
const logs = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome başlamadı');
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});

try {
  ws = new WebSocket(await connect());
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Debugger.paused') {
      console.log('--- duraklatıldı, yığın ---');
      for (const fr of m.params.callFrames.slice(0, 25)) console.log(`  ${fr.functionName || '(anonim)'}  ${fr.url.split('/').slice(-2).join('/')}:${fr.location.lineNumber + 1}`);
      pausedResolve?.();
    }
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Debugger.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  const t0 = Date.now();
  for (const s of steps) {
    if (s.wait) await sleep(s.wait);
    if (s.pauseStack) {   // interrupt a page stuck in a loop and print where
      const done = new Promise(r => { pausedResolve = r; });
      send('Debugger.pause').catch(() => {});
      await Promise.race([done, sleep(10000)]);
      await send('Debugger.resume').catch(() => {});
      continue;
    }
    if (s.until) {   // wait until a JS expression is truthy (max s.timeout ms)
      const end = Date.now() + (s.timeout || 60000);
      while (Date.now() < end) {
        const r = await send('Runtime.evaluate', { expression: s.until, returnByValue: true }).catch(() => null);
        if (r?.result?.value) break;
        await sleep(250);
      }
    }
    if (s.eval) {
      let r = await Promise.race([send('Runtime.evaluate', { expression: s.eval, returnByValue: true, awaitPromise: true }), sleep(30000).then(() => null)]);
      if (!r) {   // page stuck: show where, then give up
        console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s.label || ''}: sayfa yanıt vermiyor`);
        const done = new Promise(res => { pausedResolve = res; });
        send('Debugger.pause').catch(() => {});
        await Promise.race([done, sleep(10000)]);
        break;
      }
      console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s.label || s.eval.slice(0, 60)} =>`, JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description, null, 0)?.slice(0, 4000));
    }
    if (s.key) {
      const code = s.key;
      const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Arrow') ? code : code;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: s.vk || 0 });
      await sleep(s.hold || 80);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: s.vk || 0 });
    }
    if (s.shot) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(s.shot, Buffer.from(r.data, 'base64'));
      console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ekran: ${s.shot}`);
    }
  }
} catch (e) {
  console.error('HATA', e.message);
} finally {
  console.log('--- konsol ---');
  const seen = new Map();
  for (const l of logs) seen.set(l, (seen.get(l) || 0) + 1);
  for (const [l, n] of seen) console.log((n > 1 ? n + 'x ' : '') + l.slice(0, 400));
  ws?.close();
  chrome.kill();
  process.exit(0);
}
