// 미리보기 = 녹화 회귀 시험 (CLAUDE.md 규칙 9).
// 헤드리스 Chrome 으로 같은 템플릿을 Template Editor / Studio 에 띄워 같은 영역을 확대 크롭한다.
//   사용: 패널(npm run dev)을 켠 채로  node tools/compare-editor-studio.mjs <출력폴더> [템플릿id]
//   결과: <출력폴더>/ed-*.png (에디터) vs st-*.png (Studio) 를 눈으로 대조. editor.png / studio.png 는 전체.
//   곡 id 504 를 재생한다 — 없어졌으면 아래 tracks 의 id 를 바꿀 것.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
const TPL_ID = process.argv[3] ? parseInt(process.argv[3], 10) : null;
const PORT = 9333;
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = path.join(OUT, 'chrome-profile');
fs.mkdirSync(profile, { recursive: true });

const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1500,1300', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome not reachable');
}

let ws, seq = 0;
const pending = new Map();
const logs = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function shot(name, sel) {
  const rect = await evalJs(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  return rect;
}

const REGIONS = { tl: [0, 0, 760, 300], np: [560, 100, 800, 330], clock: [900, 840, 320, 160], logo: [1380, 40, 520, 280], bar: [0, 0, 1920, 90] };
async function cropWorld(prefix, frameSel) {
  const fr = await evalJs(`(() => { const r = document.querySelector('${frameSel}').getBoundingClientRect(); const el = document.querySelector('${frameSel}'); return { x: r.x + el.clientLeft, y: r.y + el.clientTop, w: el.clientWidth }; })()`);
  const k = fr.w / 1920;
  for (const [name, [x, y, w, h]] of Object.entries(REGIONS)) {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: fr.x + x * k, y: fr.y + y * k, width: w * k, height: h * k, scale: 1 / k } });
    fs.writeFileSync(path.join(OUT, `${prefix}-${name}.png`), Buffer.from(r.data, 'base64'));
  }
}
try {
  ws = new WebSocket(await getWs());
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.type;
      if (t === 'error' || t === 'warning') logs.push(`[console.${t}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Log.entryAdded') {
      logs.push('[log.' + m.params.entry.level + '] ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: 'http://localhost:4001/' });
  await sleep(2500);

  // 템플릿 고르기 — 지정 없으면 컴포넌트 종류가 가장 다양한 것
  const tplInfo = await evalJs(`(async () => {
    const j = await (await fetch('/api/templates')).json();
    const list = j.templates || [];
    const score = (t) => new Set((t.config_json?.components || []).map((c) => c.type)).size * 100 + (t.config_json?.components || []).length;
    const pick = ${TPL_ID ?? 'null'} != null ? list.find((t) => t.id === ${TPL_ID ?? 'null'}) : [...list].sort((a, b) => score(b) - score(a))[0];
    return { count: list.length, id: pick?.id, name: pick?.name,
      comps: (pick?.config_json?.components || []).map((c) => ({ type: c.type, fontSize: c.fontSize, letterSpacing: c.letterSpacing, autoWrap: c.autoWrap, style: c.visualizerStyle, glow: c.glow, panel: c.panelEnabled, content: (c.content || '').slice(0, 40) })) };
  })()`);
  console.log('TEMPLATE', JSON.stringify(tplInfo, null, 1));

  // ── Editor
  await evalJs(`document.querySelector('[data-tab="templates"]').click()`);
  for (let i = 0; i < 60; i++) { if (await evalJs(`document.querySelectorAll('[data-load-id],[data-load]').length`) > 0) break; await sleep(500); }
  await evalJs(`(() => { const b = document.querySelector('[data-load-id="${tplInfo.id}"], [data-load="${tplInfo.id}"]'); if (!b) throw new Error('load button not found'); b.click(); })()`);
  await sleep(1500);
  await evalJs(`document.fonts.ready.then(() => true)`);
  await sleep(2500);
  // 선택 해제 (점선 테두리 제거)
  await evalJs(`document.querySelectorAll('#teCanvasInner .te-comp.selected').forEach((e) => e.classList.remove('selected'))`);
  const bgInfo = await evalJs(`(() => { const b = document.querySelector('#teCanvasBg'); return { cls: b.className, bg: (b.style.backgroundImage || '').slice(0, 80) }; })()`);
  console.log('EDITOR_BG', JSON.stringify(bgInfo));
  await evalJs(`(() => { const sel = document.querySelector('#tePreviewTrack'); const opt = [...sel.options].find((o) => o.value); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  for (let i = 0; i < 40; i++) { if (await evalJs(`!document.querySelector('#tePreviewPlay').disabled`)) break; await sleep(500); }
  await evalJs(`document.querySelector('#tePreviewPlay').click()`);
  await sleep(3500);
  const er = await shot('editor.png', '#teCanvasFrame');
  await cropWorld('ed', '#teCanvasFrame');
  await evalJs(`document.querySelector('#tePreviewPause')?.click()`);
  const edInfo = await evalJs(`(() => ({
    scale: document.querySelector('#teCanvasFrame').clientWidth / 1920,
    worlds: [...document.querySelectorAll('#teCanvasInner .te-world')].map((w) => ({ cls: w.className, w: w.style.width, h: w.style.height, t: w.style.transform })),
    amCanvases: [...document.querySelectorAll('#teCanvasInner .te-vis-am-container canvas:not([data-vis-custom-id])')].map((c) => c.width + 'x' + c.height),
  }))()`);
  console.log('EDITOR', JSON.stringify({ rect: er, ...edInfo }, null, 1));

  // ── Studio (같은 템플릿, 제목은 에디터 placeholder 와 동일하게)
  await evalJs(`(async () => {
    const j = await (await fetch('/api/templates/${tplInfo.id}')).json();
    sessionStorage.setItem('pjl.studio.session', JSON.stringify({
      buildId: 'cdp-compare-' + Date.now(), title: 'compare',
      template: j.template, totalDurationSec: 180,
      tracks: [{ id: 504, title: 'Sample Track Title', durationSec: 180, startSec: 0, audioUrl: '' }],
    }));
    document.querySelector('[data-tab="studio"]').click();
  })()`);
  await sleep(4000);
  await evalJs(`document.querySelector('#studioPlayBtn').click()`);
  await sleep(4000);
  const sr = await shot('studio.png', '#studioCanvasFrame');
  await cropWorld('st', '#studioCanvasFrame');
  await evalJs(`document.querySelector('#studioPauseBtn')?.click()`);
  const stInfo = await evalJs(`(() => ({
    amCanvases: [...document.querySelectorAll('#studioVisHost canvas')].map((c) => c.width + 'x' + c.height),
  }))()`);
  console.log('STUDIO', JSON.stringify({ rect: sr, ...stInfo }, null, 1));
  // 원본 해상도 캔버스도 저장
  const dataUrl = await evalJs(`document.querySelector('#studioCanvas').toDataURL('image/png')`).catch((e) => { logs.push('toDataURL: ' + e.message); return null; });
  if (dataUrl) fs.writeFileSync(path.join(OUT, 'studio-1920.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));

  console.log('LOGS', JSON.stringify(logs.slice(0, 30), null, 1));
} finally {
  try { ws?.close(); } catch {}
  proc.kill();
}
