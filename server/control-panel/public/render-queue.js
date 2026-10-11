// 예약 렌더 — Builder 에서 [곡 + 템플릿] 을 여러 편 걸어 두고, 한 번 누르면 순서대로 녹화한다.
//   자기 전에 걸어 두는 용도. 시작할 때 영상마다 "3시간으로 연장할까요?" 를 묻고, 그 뒤로는 손댈 일이 없다.
//
//   대기열 상태·파일 쓰기·3시간 연장 = 서버 (lib/render-queue.mjs)
//   녹화 = Studio 그대로 (window.pjlStudioRunQueued) — 사람이 [Studio 로 이동] → [녹화] 누르는 것과 같은 코드
//
//   녹화는 이 페이지가 한다. 도는 동안 탭을 닫거나 새로고침하면 그 편은 끊긴다 (다시 시작하면 처음부터).

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FPS_KEY = 'pjl.renderQueue.fps';

const rq = {
  items: [],
  outDir: '',
  extendHours: 3,
  extendReady: false,
  running: false,
  stopAfter: false,     // 지금 편이 끝나면 멈춤
  currentId: null,
  summary: '',
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

function toast(msg, type = 'info', ms = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toaster')?.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

const fmtMin = (sec) => `${Math.round((sec || 0) / 60)}분`;
const fmtClock = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

async function refresh() {
  const j = await api('GET', '/api/render-queue');
  rq.items = j.items || [];
  rq.outDir = j.outDir || '';
  rq.extendHours = j.extendHours || 3;
  rq.extendReady = !!j.extendReady;
  render();
  return rq.items;
}

// ─── 화면 ─────────────────────────────────────────────────────────────
function statusBadge(it) {
  const ext = it.ext || {};
  if (it.status === 'rendering') {
    return rq.running && rq.currentId === it.id
      ? '<span class="rq-badge run">🎬 녹화 중</span>'
      : '<span class="rq-badge fail">끊김 — 다시 시작하면 처음부터</span>';
  }
  if (ext.status === 'running') return `<span class="rq-badge run">⏩ ${rq.extendHours}시간으로 늘리는 중</span>`;
  if (it.status === 'queued') return '<span class="rq-badge">대기</span>';
  if (it.status === 'stopped') return '<span class="rq-badge fail">중지됨 (부분 저장)</span>';
  if (it.status === 'failed') return '<span class="rq-badge fail">실패</span>';
  if (it.status === 'done') {
    if (ext.status === 'done') return `<span class="rq-badge ok">✅ 완료 + ${rq.extendHours}시간 본</span>`;
    if (ext.status === 'failed') return '<span class="rq-badge fail">✅ 녹화 완료 · 연장 실패</span>';
    return '<span class="rq-badge ok">✅ 완료</span>';
  }
  return '';
}

function render() {
  const card = $('#rqCard');
  if (!card) return;
  const items = rq.items;
  const waiting = items.filter((x) => x.status === 'queued' || x.status === 'rendering').length;
  const finished = items.length - waiting;
  $('#rqCount').textContent = String(waiting);
  $('#rqOutDir').textContent = rq.outDir;

  const list = $('#rqList');
  if (!items.length) {
    list.innerHTML = '<div class="rq-empty">예약된 영상이 없습니다. 곡과 템플릿을 고른 뒤 <b>📋 예약에 추가</b> 를 누르세요.</div>';
  } else {
    list.innerHTML = items.map((it, i) => {
      const ext = it.ext || {};
      const lines = [];
      if (it.file) lines.push(`📁 ${esc(baseName(it.file))}`);
      if (ext.file) lines.push(`📁 ${esc(baseName(ext.file))}`);
      if (ext.status === 'running' && ext.line) lines.push(esc(ext.line));
      if (it.note) lines.push(`ℹ ${esc(it.note)}`);
      if (it.error) lines.push(`⚠ ${esc(it.error)}`);
      if (ext.error) lines.push(`⚠ 연장: ${esc(ext.error)}`);
      if (ext.warn) lines.push(`⚠ ${esc(ext.warn)}`);
      const canRemove = !(it.status === 'rendering' && rq.running) && ext.status !== 'running';
      // 중지·실패한 편은 [예약 렌더링 시작] 이 건너뛴다 → 이 단추로 대기(queued)에 되돌려야 다시 돈다.
      const canRetry = !rq.running && (it.status === 'stopped' || it.status === 'failed');
      const extTag = it.status === 'queued' || it.status === 'rendering'
        ? (it.extend ? `<span class="rq-tag">+ ${rq.extendHours}시간 연장</span>` : '')
        : '';
      return `
        <div class="rq-row" data-id="${esc(it.id)}">
          <span class="rq-num">${i + 1}</span>
          <div class="rq-main">
            <div class="rq-title">${esc(it.templateName || '(템플릿)')} · ${it.trackIds.length}곡 · ${fmtMin(it.durationSec)} ${extTag}</div>
            <div class="rq-sub">첫 곡: ${esc(it.firstTitle || '—')}${it.finishedAt ? ` · ${fmtClock(it.finishedAt)} 끝` : ''}</div>
            ${lines.map((l) => `<div class="rq-sub">${l}</div>`).join('')}
          </div>
          ${statusBadge(it)}
          ${canRetry ? '<button class="bulk-btn rq-retry" type="button" title="처음부터 다시 녹화하도록 대기로 되돌린다 (부분 저장된 파일은 그대로 남는다)">↻ 다시 예약</button>' : ''}
          ${canRemove ? '<button class="bulk-btn rq-del" type="button" title="예약에서 빼기">✕</button>' : ''}
        </div>`;
    }).join('');
  }

  const startBtn = $('#rqStartBtn');
  const stopBtn = $('#rqStopBtn');
  startBtn.hidden = rq.running;
  startBtn.disabled = !items.some((x) => x.status === 'queued' || x.status === 'rendering');
  stopBtn.hidden = !rq.running;
  stopBtn.textContent = rq.stopAfter ? '⏹ 이번 영상까지만 하고 멈춥니다' : '⏹ 이번 영상까지만 하고 멈추기';
  stopBtn.disabled = rq.stopAfter;
  $('#rqClearBtn').hidden = !finished || rq.running;

  const pill = $('#rqPill');
  if (pill) {
    if (rq.running) {
      const idx = items.findIndex((x) => x.id === rq.currentId);
      const cur = items[idx];
      const what = cur?.ext?.status === 'running' ? `${rq.extendHours}시간으로 늘리는 중` : '녹화 중';
      const left = items.filter((x) => x.status === 'queued').length;
      pill.textContent = `📋 예약 렌더 — ${idx + 1}번째 ${what} · 남은 대기 ${left}편`;
      pill.hidden = false;
    } else if (rq.summary) {
      pill.textContent = rq.summary;
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
  }
}

// ─── 예약에 추가 (Builder 의 [📋 예약에 추가] 가 부른다) ──────────────
async function add({ tracks, templateId, templateName }) {
  const ids = tracks.map((t) => t.id);
  await refresh().catch(() => {});
  const pending = rq.items.filter((x) => x.status === 'queued' || x.status === 'rendering');
  const taken = new Set(pending.flatMap((x) => x.trackIds));
  const dup = ids.filter((id) => taken.has(id)).length;
  if (dup && !confirm(`이미 예약된 영상과 ${dup}곡이 겹칩니다.\n(예약된 곡은 녹화가 끝나야 '사용됨' 으로 표시됩니다.)\n\n그래도 추가할까요?`)) return false;
  const durationSec = tracks.reduce((s, t) => s + (Number(t.duration_actual_sec) || Number(t.duration_raw_sec) || 180), 0);
  const first = tracks[0];
  await api('POST', '/api/render-queue', {
    trackIds: ids,
    templateId,
    templateName,
    durationSec,
    firstTitle: first?.title?.title_en || (first?.original_filename || '').replace(/\.[^/.]+$/, '') || '',
  });
  await refresh();
  return true;
}

// ─── 시작 전 물어보기: 영상마다 3시간으로 연장할지 ────────────────────
function askBeforeStart(jobs) {
  return new Promise((resolve) => {
    const modal = $('#rqAskModal');
    const savedFps = parseInt(localStorage.getItem(FPS_KEY), 10) || 60;
    const total = jobs.reduce((s, j) => s + (j.durationSec || 0), 0);
    $('#rqAskList').innerHTML = jobs.map((j, i) => `
      <label class="rq-ask-row">
        <input type="checkbox" data-id="${esc(j.id)}" ${j.extend ? 'checked' : ''} ${rq.extendReady ? '' : 'disabled'} />
        <span class="rq-ask-text">
          <b>${i + 1}. ${esc(j.templateName || '(템플릿)')}</b> · ${j.trackIds.length}곡 · ${fmtMin(j.durationSec)}
          <span class="rq-sub">첫 곡: ${esc(j.firstTitle || '—')}</span>
        </span>
        <span class="rq-ask-q">${rq.extendHours}시간으로 연장</span>
      </label>`).join('');
    $('#rqAskNote').innerHTML = rq.extendReady
      ? `체크한 영상은 녹화가 끝나면 바로 <b>약 ${rq.extendHours}시간</b>으로 늘립니다 (바퀴 사이 디졸브 + 맨 앞 PJL 인트로). 원래 영상도 그대로 남습니다.`
      : '⚠ 늘리기 도구(PNL-3D-Studio\\tools\\loop-video.py)를 찾지 못해 연장은 할 수 없습니다. 녹화만 진행합니다.';
    $('#rqAskFps').value = String(savedFps);
    $('#rqAskTime').textContent = `녹화는 실제 시간만큼 걸립니다 — ${jobs.length}편 합쳐 약 ${fmtMin(total)}. 끝날 때까지 이 탭을 닫거나 새로고침하지 마세요.`;
    $('#rqAskAll').checked = rq.extendReady && jobs.every((j) => j.extend);
    $('#rqAskAll').disabled = !rq.extendReady;
    modal.hidden = false;

    const boxes = () => [...modal.querySelectorAll('#rqAskList input[type=checkbox]')];
    const onAll = () => boxes().forEach((b) => { if (!b.disabled) b.checked = $('#rqAskAll').checked; });
    const done = (val) => {
      modal.hidden = true;
      $('#rqAskAll').removeEventListener('change', onAll);
      $('#rqAskGo').removeEventListener('click', onGo);
      $('#rqAskCancel').removeEventListener('click', onCancel);
      resolve(val);
    };
    const onGo = () => done({
      fps: parseInt($('#rqAskFps').value, 10) || 60,
      extend: Object.fromEntries(boxes().map((b) => [b.dataset.id, b.checked])),
    });
    const onCancel = () => done(null);
    $('#rqAskAll').addEventListener('change', onAll);
    $('#rqAskGo').addEventListener('click', onGo);
    $('#rqAskCancel').addEventListener('click', onCancel);
  });
}

// ─── 한 편 준비: Builder 의 [Studio 로 이동] 과 같은 세션을 만든다 ────
async function buildSession(job) {
  const tj = await api('GET', `/api/tracks?ids=${job.trackIds.join(',')}&limit=500`);
  const map = new Map((tj.tracks || []).map((t) => [t.id, t]));
  const ordered = job.trackIds.map((id) => map.get(id)).filter(Boolean);
  if (ordered.length !== job.trackIds.length) {
    throw new Error(`예약한 곡 ${job.trackIds.length}곡 중 ${job.trackIds.length - ordered.length}곡이 사라졌습니다 (삭제됨?)`);
  }
  const tr = await api('GET', `/api/templates/${job.templateId}`);
  if (!tr.template) throw new Error('템플릿을 찾을 수 없습니다 (삭제됨?)');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const title = `Untitled — ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const vj = await api('POST', '/api/videos', {
    title, trackIds: job.trackIds, templateId: job.templateId, seriesId: null, registerAsSeries: false,
  });

  let cursor = 0;
  const tracks = ordered.map((t) => {
    const dur = Number(t.duration_actual_sec) || Number(t.duration_raw_sec) || 180;
    const startSec = cursor;
    cursor += dur;
    return {
      id: t.id,
      title: t.title?.title_en || t.original_filename?.replace(/\.[^/.]+$/, '') || `Track ${t.id}`,
      audioUrl: null,            // Studio 가 부팅·녹화 직전에 새로 발급받는다
      durationSec: dur,
      startSec,
      endSec: cursor,
    };
  });
  return {
    buildId: vj.buildId, videoId: vj.videoId, title: vj.title,
    template: tr.template, tracks, totalDurationSec: cursor, createdAt: Date.now(),
  };
}

// 녹화 조각을 서버로 보내 디스크에 쓴다. FileSystemWritableFileStream 과 같은 모양.
async function openSink(jobId) {
  const { name } = await api('POST', `/api/render-queue/${jobId}/file/open`);
  const url = `/api/render-queue/${jobId}/file`;
  return {
    name,
    async write({ position, data }) {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${url}?pos=${position}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data,
          });
          const j = await res.json().catch(() => ({}));
          if (res.ok && j.ok) return;
          lastErr = new Error(j.error || `HTTP ${res.status}`);
        } catch (e) { lastErr = e; }
        await sleep(1500);
      }
      // 못 쓰는 채로 30분을 더 굽는 것은 낭비 — 지금 멈춘다.
      if (window.pjlStudio) window.pjlStudio.recCancelled = true;
      throw new Error(`디스크에 쓰지 못함: ${lastErr?.message || lastErr}`);
    },
    close: () => api('POST', `${url}/close`, {}),
    abort: () => api('POST', `${url}/close`, { discard: true }),
  };
}

async function patch(id, body) {
  try { await api('POST', `/api/render-queue/${id}`, body); } catch (e) { console.warn('[예약] 상태 저장 실패:', e.message); }
}

async function runExtend(job) {
  await api('POST', `/api/render-queue/${job.id}/extend`);
  for (;;) {
    await sleep(4000);
    const items = await refresh().catch(() => null);
    const cur = items?.find((x) => x.id === job.id);
    if (!cur) return;
    if (cur.ext?.status !== 'running') return;
  }
}

async function runOne(job, fps) {
  let sink = null;
  try {
    await patch(job.id, { status: 'rendering', startedAt: new Date().toISOString(), error: null, note: null, fps });
    await refresh();
    const session = await buildSession(job);
    await patch(job.id, { videoId: session.videoId });
    sink = await openSink(job.id);
    const r = await window.pjlStudioRunQueued(session, sink, { fps });
    const end = { finishedAt: new Date().toISOString() };
    if (!r || !r.saved) {
      await patch(job.id, { ...end, status: 'failed', error: r?.error || r?.died || '녹화가 시작되지 못했거나 저장할 내용이 없습니다' });
      return 'failed';
    }
    if (r.died) {
      await patch(job.id, { ...end, status: 'failed', error: `인코더가 죽어 중간까지만 저장됨: ${r.died}` });
      return 'failed';
    }
    if (r.cancelled) {
      await patch(job.id, { ...end, status: 'stopped', error: '녹화 중지 — 거기까지만 저장됨' });
      return 'stopped';
    }
    if (r.trackErrors?.length) {
      await patch(job.id, { ...end, status: 'failed', error: `곡 ${r.trackErrors.length}개가 빠진 채 저장됨 — ${r.trackErrors[0]}` });
      return 'failed';
    }
    await patch(job.id, { ...end, status: 'done', note: r.fallbackUsed ? '도중에 GPU→CPU 인코더로 갈아탐 (결과는 정상)' : null });
    return 'done';
  } catch (e) {
    console.error('[예약] 실패:', e);
    // Studio 가 이미 마감했으면 서버엔 열린 파일이 없어 아무 일도 안 일어난다.
    if (sink) { try { await sink.abort(); } catch {} }
    await patch(job.id, { status: 'failed', finishedAt: new Date().toISOString(), error: e?.message || String(e) });
    return 'failed';
  }
}

async function start() {
  if (rq.running) return;
  if (window.pjlStudio?.recording) { toast('Studio 에서 이미 녹화 중입니다', 'error'); return; }
  if (typeof window.pjlStudioRunQueued !== 'function') { toast('Studio 가 아직 안 올라왔습니다 — 잠시 뒤 다시', 'error'); return; }
  await refresh();
  // 지난번에 끊긴 것(rendering 으로 굳은 것)은 처음부터 다시.
  for (const it of rq.items) if (it.status === 'rendering') await patch(it.id, { status: 'queued' });
  const jobs = (await refresh()).filter((x) => x.status === 'queued');
  if (!jobs.length) { toast('예약된 영상이 없습니다', 'error'); return; }

  const answer = await askBeforeStart(jobs);
  if (!answer) return;
  localStorage.setItem(FPS_KEY, String(answer.fps));
  for (const j of jobs) await patch(j.id, { extend: !!answer.extend[j.id] });

  rq.running = true;
  rq.stopAfter = false;
  rq.summary = '';
  const tally = { done: 0, failed: 0, stopped: 0, extended: 0, extendFailed: 0 };
  try {
    for (;;) {
      const items = await refresh();
      const job = items.find((x) => x.status === 'queued');
      if (!job || rq.stopAfter) break;
      rq.currentId = job.id;
      const result = await runOne(job, answer.fps);
      tally[result]++;
      await refresh().catch(() => {});
      if (result === 'stopped') break;          // 사람이 녹화 중지를 눌렀다 — 뒤의 것도 돌리지 않는다
      if (result === 'done' && job.extend && rq.extendReady) {
        try {
          await runExtend(job);
          const cur = rq.items.find((x) => x.id === job.id);
          if (cur?.ext?.status === 'done') tally.extended++; else tally.extendFailed++;
        } catch (e) {
          tally.extendFailed++;
          await patch(job.id, { note: `연장 시작 실패: ${e.message}` });
        }
      }
    }
  } finally {
    rq.running = false;
    rq.currentId = null;
    const left = rq.items.filter((x) => x.status === 'queued').length;
    rq.summary = `📋 예약 렌더 끝 (${fmtClock(new Date().toISOString())}) — 완료 ${tally.done}`
      + (tally.extended ? ` · ${rq.extendHours}시간 본 ${tally.extended}` : '')
      + (tally.failed ? ` · 실패 ${tally.failed}` : '')
      + (tally.extendFailed ? ` · 연장 실패 ${tally.extendFailed}` : '')
      + (tally.stopped ? ' · 중지됨' : '')
      + (left ? ` · 남은 대기 ${left}` : '');
    document.title = `${tally.failed || tally.extendFailed || tally.stopped ? '⚠' : '✅'} 예약 렌더 끝 — ${document.title.replace(/^[✅⚠] 예약 렌더 끝 — /, '')}`;
    await refresh().catch(() => render());
  }
}

// ─── 바인딩 ───────────────────────────────────────────────────────────
function bind() {
  if (!$('#rqCard')) return;
  $('#rqStartBtn').addEventListener('click', () => start().catch((e) => toast(`예약 렌더 시작 실패: ${e.message}`, 'error', 6000)));
  $('#rqStopBtn').addEventListener('click', () => { rq.stopAfter = true; render(); });
  $('#rqClearBtn').addEventListener('click', async () => {
    try { await api('POST', '/api/render-queue/clear-finished'); await refresh(); } catch (e) { toast(e.message, 'error'); }
  });
  $('#rqList').addEventListener('click', async (ev) => {
    const retry = ev.target.closest('.rq-retry');
    if (retry) {
      const rid = retry.closest('.rq-row')?.dataset.id;
      if (!rid) return;
      try { await api('POST', `/api/render-queue/${rid}`, { status: 'queued', error: null, note: null }); await refresh(); } catch (e) { toast(e.message, 'error'); }
      return;
    }
    const btn = ev.target.closest('.rq-del');
    if (!btn) return;
    const id = btn.closest('.rq-row')?.dataset.id;
    try { await api('DELETE', `/api/render-queue/${id}`); await refresh(); } catch (e) { toast(e.message, 'error'); }
  });
  $('#rqPill')?.addEventListener('click', () => {
    // 도는 중엔 탭을 바꾸지 않는다 — 녹화 화면(Studio 탭)이 가려진다.
    if (rq.running) return;
    rq.summary = '';
    render();
    window.switchTab?.('builder');
  });
  window.addEventListener('beforeunload', (e) => {
    if (rq.running) { e.preventDefault(); e.returnValue = ''; }
  });
  refresh().catch((e) => console.warn('[예약] 대기열 읽기 실패:', e.message));
}

window.pjlRenderQueue = { add, refresh, start, state: rq };
bind();
