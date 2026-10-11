// 이펙트 필터 + 비주얼라이저 세부 조정 회귀 시험 (CLAUDE.md 규칙 9: 미리보기 = 녹화).
// 헤드리스 Chrome 으로 Template Editor 에 이펙트를 얹어 보고, 같은 구성을 Studio 에 띄워 나란히 찍는다.
//   사용: 패널(npm run dev)을 켠 채로  node tools/test-effects.mjs <출력폴더> [템플릿id]
//   결과: <출력폴더>/editor.png · studio.png (눈으로 대조) + 콘솔 오류 목록. DB 에는 아무것도 쓰지 않는다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('사용: node tools/test-effects.mjs <출력폴더> [템플릿id]'); process.exit(1); }
const TPL_ID = process.argv[3] ? parseInt(process.argv[3], 10) : null;
const PORT = 9334;
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = path.join(OUT, 'chrome-profile');
fs.mkdirSync(profile, { recursive: true });

// 시험에 얹을 이펙트 — 입자·블렌드·마스크·색 계열을 하나씩.
const FX = ['rain', 'bokeh', 'fog', 'grain', 'vignette'];

const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1700,1500', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
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
}

let failed = false;
try {
  ws = new WebSocket(await getWs());
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('[console.error] ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://localhost:4001/' });
  await sleep(2500);

  const tpl = await evalJs(`(async () => {
    const list = (await (await fetch('/api/templates')).json()).templates || [];
    const pick = ${TPL_ID ?? 'null'} != null ? list.find((t) => t.id === ${TPL_ID ?? 'null'}) : list[0];
    return pick ? { id: pick.id, name: pick.name } : null;
  })()`);
  if (!tpl) throw new Error('템플릿이 하나도 없다');
  console.log('TEMPLATE', JSON.stringify(tpl));

  // ── Editor: 템플릿 불러오고 이펙트를 화면 조작으로 추가
  await evalJs(`document.querySelector('[data-tab="templates"]').click()`);
  for (let i = 0; i < 60; i++) { if (await evalJs(`document.querySelectorAll('[data-load-id],[data-load]').length`) > 0) break; await sleep(500); }
  await evalJs(`(() => { const b = document.querySelector('[data-load-id="${tpl.id}"], [data-load="${tpl.id}"]'); if (!b) throw new Error('load button not found'); b.click(); })()`);
  await sleep(3000);
  const types = await evalJs(`[...document.querySelectorAll('#teFxType option')].map((o) => o.value)`);
  console.log('FX_TYPES', types.length, types.join(','));
  for (const t of FX) {
    await evalJs(`(() => { const s = document.querySelector('#teFxType'); s.value = '${t}'; document.querySelector('#teFxAddBtn').click(); })()`);
    await sleep(150);
  }
  // 속성 패널: 마지막에 추가한 이펙트의 슬라이더를 움직여 본다 (패널이 다시 그려지지 않는지 = 같은 입력칸이 살아 있는지)
  const propCheck = await evalJs(`(() => {
    const wrap = document.querySelector('#teProps');
    const before = wrap.querySelector('input[type="range"][data-fx-prop]');
    const color = wrap.querySelector('input[type="color"][data-fx-prop]');
    before.value = before.max; before.dispatchEvent(new Event('input', { bubbles: true }));
    if (color) { color.value = '#102030'; color.dispatchEvent(new Event('input', { bubbles: true })); }
    return {
      title: wrap.querySelector('h3')?.textContent,
      sliders: wrap.querySelectorAll('input[type="range"][data-fx-prop]').length,
      sameSlider: before.isConnected,
      sameColor: color ? color.isConnected : null,
      rows: document.querySelectorAll('#teFxList .te-fx-row').length,
      canvases: [...document.querySelectorAll('#teCanvasFrame canvas[data-fx-id]')].map((c) => c.style.mixBlendMode + '/' + c.width + 'x' + c.height),
    };
  })()`);
  console.log('EDITOR_FX', JSON.stringify(propCheck));
  if (propCheck.rows !== FX.length || !propCheck.sameSlider || propCheck.sameColor === false) failed = true;
  await evalJs(`document.querySelectorAll('#teCanvasInner .te-comp.selected').forEach((e) => e.classList.remove('selected'))`);
  await sleep(2500);
  await shot('editor.png', '#teCanvasFrame');

  // 비주얼라이저 세부 조정 슬라이더가 뜨는지 (템플릿에 비주얼라이저가 있을 때만)
  const viz = await evalJs(`(async () => {
    const el = document.querySelector('#teCanvasInner .te-comp-visualizer, #teCanvasInner [data-type="visualizer"]');
    if (!el) return null;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const sel = document.querySelector('#teProps select[data-prop="visualizerStyle"]');
    if (!sel) return { selected: false };
    sel.value = 'silk-ribbon'; sel.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { selected: true, detailSliders: document.querySelectorAll('#teProps input[data-prop^="vz"], #teProps input[data-prop^="silk"]').length, reset: !!document.querySelector('#teVizDetailReset') };
  })()`);
  console.log('VIZ_DETAIL', JSON.stringify(viz));
  if (viz?.selected && (!viz.detailSliders || !viz.reset)) failed = true;

  // ── Studio: 같은 템플릿 + 같은 이펙트 (메모리에서만 합친다 — DB 저장 없음)
  await evalJs(`(async () => {
    const m = await import('/effects-renderer.js');
    const j = await (await fetch('/api/templates/${tpl.id}')).json();
    j.template.config_json = { ...(j.template.config_json || {}), effects: ${JSON.stringify(FX)}.map((t) => m.defaultEffect(t)) };
    delete j.template.id;     // id 가 있으면 Studio 가 DB 에서 템플릿을 다시 받아 와 여기서 얹은 이펙트가 사라진다
    sessionStorage.setItem('pjl.studio.session', JSON.stringify({
      buildId: 'cdp-effects-' + Date.now(), title: 'effects-test',
      template: j.template, totalDurationSec: 180,
      tracks: [{ id: 504, title: 'Sample Track Title', durationSec: 180, startSec: 0, audioUrl: '' }],
    }));
    document.querySelector('[data-tab="studio"]').click();
  })()`);
  await sleep(6000);
  await shot('studio.png', '#studioCanvasFrame');
  const lit = await evalJs(`(() => {
    const cv = document.querySelector('#studioCanvas');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, 60).data;      // 맨 위 60줄 — 비네트로 어두워졌어도 0 은 아니다
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { w: cv.width, h: cv.height, topSum: sum };
  })()`);
  console.log('STUDIO', JSON.stringify(lit));
} catch (e) {
  failed = true;
  console.error('FAILED:', e.message);
} finally {
  console.log(logs.length ? 'LOGS\n' + [...new Set(logs)].slice(0, 30).join('\n') : 'LOGS (오류 없음)');
  try { ws?.close(); } catch {}
  proc.kill();
}
if (failed || logs.some((l) => l.startsWith('[exception]'))) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: OK');
