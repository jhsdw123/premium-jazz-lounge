// 예약 렌더 통합 시험 — 헤드리스 Chrome 으로 대기열 2편을 실제로 녹화시킨다 (첫 편은 연장까지).
//
//   ⚠ 실제 폴더·DB 를 건드리지 않게, 패널을 시험용 환경변수로 따로 띄운 뒤 돌린다:
//       $env:PJL_RENDER_DIR = "<시험 폴더>"; $env:PJL_EXTEND_HOURS = "0.02"; npm run dev
//       node tools/test-render-queue.mjs <시험 폴더>
//   페이지 안에서 fetch 를 가로채: 곡 길이를 20초로 줄이고, 사용 이력·영상 프로젝트는 DB 에 안 남긴다.
//   포트는 4001 이어야 한다 (R2 CORS).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT) { console.error('사용: node tools/test-render-queue.mjs <시험 폴더>'); process.exit(1); }
const BASE = 'http://localhost:4001';
const PORT = 9334;
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = path.join(OUT, 'chrome-profile');
fs.mkdirSync(profile, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => (await fetch(BASE + p, {
  method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
})).json();

const q0 = await api('GET', '/api/render-queue');
if (path.resolve(q0.outDir) !== path.resolve(OUT)) {
  console.error(`패널의 저장 폴더(${q0.outDir})가 시험 폴더가 아닙니다 — 시험용 환경변수로 패널을 다시 띄우세요.`);
  process.exit(1);
}
if (q0.items.length) { console.error('대기열이 비어 있지 않습니다 — 시험을 멈춥니다.'); process.exit(1); }

const tpl = (await api('GET', '/api/templates?lite=1')).templates[0];
const tracks = (await api('GET', '/api/tracks?limit=3')).tracks;
console.log(`템플릿: ${tpl.name} (#${tpl.id}) · 곡: ${tracks.map((t) => t.id).join(', ')}`);
await api('POST', '/api/render-queue', { trackIds: [tracks[0].id, tracks[1].id], templateId: tpl.id, templateName: tpl.name, durationSec: 40, firstTitle: '시험 1' });
await api('POST', '/api/render-queue', { trackIds: [tracks[2].id], templateId: tpl.id, templateName: tpl.name, durationSec: 20, firstTitle: '시험 2' });

const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1500,1300', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

// 페이지가 뜨기 전에 심는다: 곡 길이 20초 · 사용 이력/영상 프로젝트는 가짜 응답.
const HOOK = `(() => {
  const real = window.fetch.bind(window);
  const fake = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    if (url.includes('/api/tracks/usage')) return fake({ ok: true, recorded: 0 });
    if (method === 'POST' && /\\/api\\/videos$/.test(url)) return fake({ ok: true, buildId: 'rq-test-' + Date.now(), videoId: null, title: '예약 렌더 시험' });
    if (/\\/api\\/tracks\\?ids=/.test(url)) {
      const j = await (await real(input, init)).json();
      for (const t of j.tracks || []) { t.duration_actual_sec = 20; t.duration_raw_sec = 20; }
      return fake(j);
    }
    return real(input, init);
  };
})();`;

let code = 1;
try {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
    if (!wsUrl) await sleep(200);
  }
  ws = new WebSocket(wsUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await send('Page.navigate', { url: BASE + '/' });
  for (let i = 0; i < 100; i++) {
    if (await evalJs(`typeof window.pjlStudioRunQueued === 'function' && typeof window.pjlRenderQueue === 'object'`).catch(() => false)) break;
    await sleep(300);
  }

  // Builder 탭에 카드가 제대로 그려졌나
  await evalJs(`window.switchTab('builder')`);
  await sleep(1500);
  console.log('대기열 카드:', await evalJs(`document.querySelector('#rqList').innerText.replace(/\\n+/g, ' | ')`));

  // 시작 → 묻는 창에서 첫 편만 연장, 60fps
  await evalJs(`(document.querySelector('#rqStartBtn').click(), 1)`);
  for (let i = 0; i < 40; i++) { if (await evalJs(`!document.querySelector('#rqAskModal').hidden`)) break; await sleep(250); }
  console.log('묻는 창:', await evalJs(`document.querySelector('#rqAskModal .recent-dialog').innerText.replace(/\\n+/g, ' | ')`));
  await evalJs(`(() => { const b = document.querySelectorAll('#rqAskList input'); b[0].checked = true; b[1].checked = false; document.querySelector('#rqAskFps').value = '60'; document.querySelector('#rqAskGo').click(); return 1; })()`);

  const t0 = Date.now();
  let last = '';
  for (;;) {
    await sleep(3000);
    const s = await evalJs(`JSON.stringify({ running: window.pjlRenderQueue.state.running, pill: document.querySelector('#rqPill').textContent, rec: (document.querySelector('#studioRecStatus')?.innerText || '').slice(0, 90) })`);
    if (s !== last) { console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`, s); last = s; }
    if (!JSON.parse(s).running && Date.now() - t0 > 8000) break;
    if (Date.now() - t0 > 12 * 60 * 1000) throw new Error('12분 넘게 안 끝남');
  }
  console.log('끝난 뒤 카드:', await evalJs(`document.querySelector('#rqList').innerText.replace(/\\n+/g, ' | ')`));

  const q = await api('GET', '/api/render-queue');
  const probe = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_packets:format=duration', '-of', 'csv=p=0', f]).toString().trim().replace(/\r?\n/g, ' / ');
  let ok = true;
  for (const [i, it] of q.items.entries()) {
    console.log(`\n[${i + 1}] status=${it.status} ext=${it.ext?.status || '-'} error=${it.error || it.ext?.error || '-'}`);
    if (it.file) console.log('   녹화본 :', path.basename(it.file), '→', probe(it.file));
    if (it.ext?.file) console.log('   연장본 :', path.basename(it.ext.file), '→', probe(it.ext.file));
    if (it.status !== 'done') ok = false;
  }
  if (q.items[0]?.ext?.status !== 'done') ok = false;
  if (q.items[1]?.ext?.status) ok = false;
  console.log(ok ? '\n✅ 통과' : '\n❌ 실패');
  code = ok ? 0 : 1;
} catch (e) {
  console.error('시험 오류:', e.message);
} finally {
  const bad = logs.filter((l) => /^\[(error|exception)\]/.test(l));
  if (bad.length) console.log('\n브라우저 오류 로그:\n' + bad.slice(0, 20).join('\n'));
  fs.writeFileSync(path.join(OUT, 'browser.log'), logs.join('\n'));
  try { ws?.close(); } catch {}
  proc.kill();
  process.exit(code);
}
