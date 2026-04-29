// Premium Jazz Lounge — Pool tab controller
// vanilla ES module, no external deps

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  prompts: [],
  tracks: [],
};

// ─── Toast notifications ─────────────────────────────────────────────
function toast(msg, type = 'info', durationMs = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toaster').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.2s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 220);
  }, durationMs);
}

// ─── API helpers ─────────────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(path);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  const s = Math.round(parseFloat(sec));
  if (!Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

// ─── Tab switching ──────────────────────────────────────────────────
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `tab-${tab}`));
  });
});

// ─── Stats ──────────────────────────────────────────────────────────
async function refreshStats() {
  try {
    const j = await apiGet('/api/stats');
    $('#stat-tracks').textContent = j.stats?.pjl_tracks ?? '—';
    $('#stat-with-title').textContent = j.tracksWithTitle ?? '—';
    $('#stat-used').textContent = j.tracksUsed ?? '—';
    $('#stat-prompts').textContent = j.stats?.pjl_prompts ?? '—';
  } catch (e) {
    toast(`stats 로드 실패: ${e.message}`, 'error');
  }
}

// ─── Prompts ────────────────────────────────────────────────────────
async function refreshPrompts() {
  try {
    const j = await apiGet('/api/prompts');
    state.prompts = j.prompts || [];
    const select = $('#promptSelect');
    const cur = select.value;
    select.innerHTML = '<option value="">(없음)</option>';
    for (const p of state.prompts) {
      const opt = document.createElement('option');
      opt.value = p.id;
      const label = p.nickname || p.prompt_text.slice(0, 50);
      opt.textContent = `${label} (${p.use_count})`;
      select.appendChild(opt);
    }
    if (cur) select.value = cur;
  } catch (e) {
    toast(`prompts 로드 실패: ${e.message}`, 'error');
  }
}

$('#newPromptBtn').addEventListener('click', () => $('#newPromptDialog').showModal());
$('#cancelPromptBtn').addEventListener('click', () => $('#newPromptDialog').close());

$('#newPromptForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const promptText = $('#newPromptText').value.trim();
  if (!promptText) return;
  const nickname = $('#newPromptNickname').value.trim() || null;
  try {
    const j = await apiPost('/api/prompts', { promptText, nickname });
    toast(`Prompt 추가됨: ${j.prompt.nickname || j.prompt.prompt_text.slice(0, 30)}`, 'success');
    $('#newPromptDialog').close();
    $('#newPromptText').value = '';
    $('#newPromptNickname').value = '';
    await refreshPrompts();
    $('#promptSelect').value = String(j.prompt.id);
  } catch (e) {
    toast(`Prompt 추가 실패: ${e.message}`, 'error');
  }
});

// ─── Track list ─────────────────────────────────────────────────────
async function refreshTracks() {
  try {
    const j = await apiGet('/api/tracks?limit=200');
    state.tracks = j.tracks || [];
    renderTracks();
  } catch (e) {
    toast(`tracks 로드 실패: ${e.message}`, 'error');
  }
}

function renderTracks() {
  const tb = $('#trackBody');
  if (!state.tracks.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">아직 곡이 없습니다. mp3 파일을 드래그해서 추가하세요.</td></tr>';
    return;
  }
  tb.innerHTML = '';
  for (const t of state.tracks) {
    const tr = document.createElement('tr');
    const titleHtml = t.title?.title_en
      ? escapeHtml(t.title.title_en)
      : '<span class="no-title">(no title)</span>';
    const prefixBadge = t.prefix_order ? `<span class="prefix-badge">${t.prefix_order}</span>` : '';
    const vocalIcon = t.has_vocals ? '<span class="vocal-icon" title="보컬 포함">🎤</span>' : '';
    const promptName = t.prompt?.nickname || (t.prompt?.prompt_text ? t.prompt.prompt_text.slice(0, 28) : '—');
    tr.innerHTML = `
      <td class="col-id">${t.id}</td>
      <td>
        <div>${prefixBadge}${titleHtml}${vocalIcon}</div>
        <div class="filename">${escapeHtml(t.original_filename || '')}</div>
      </td>
      <td class="col-duration">${fmtDuration(t.duration_actual_sec)}</td>
      <td class="col-prompt">${escapeHtml(promptName)}</td>
      <td class="col-actions">
        <button class="delete-btn" data-id="${t.id}" title="삭제">🗑</button>
      </td>
    `;
    tb.appendChild(tr);
  }
  $$('.delete-btn').forEach((btn) =>
    btn.addEventListener('click', () => deleteTrack(parseInt(btn.dataset.id, 10)))
  );
}

async function deleteTrack(id) {
  if (!confirm(`trackId=${id} 을(를) 삭제하시겠습니까?\n(Storage + DB 영구 삭제)`)) return;
  try {
    await apiPost('/api/tracks/delete', { ids: [id] });
    toast(`삭제됨: id=${id}`, 'success');
    await Promise.all([refreshTracks(), refreshStats()]);
  } catch (e) {
    toast(`삭제 실패: ${e.message}`, 'error');
  }
}

$('#refreshTracksBtn').addEventListener('click', () =>
  Promise.all([refreshTracks(), refreshStats()])
);

// ─── Drop zone + file input ─────────────────────────────────────────
const dz = $('#dropzone');
const fi = $('#fileInput');
const dropClick = $('#dropClick');

dropClick.addEventListener('click', () => fi.click());

dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dz.classList.add('dragover');
});
dz.addEventListener('dragleave', (e) => {
  // dragleave fires on internal element transitions; only clear if we left dz entirely
  if (e.target === dz) dz.classList.remove('dragover');
});
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files).filter((f) => f.size > 0);
  if (files.length) handleFiles(files);
});

fi.addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  if (files.length) handleFiles(files);
  fi.value = '';  // 같은 파일 재선택 가능하게
});

// ─── Upload pipeline ────────────────────────────────────────────────
const CHUNK_SIZE = 5;          // multer 한도와 일치
const TITLE_GEN_DELAY_MS = 4500;  // Gemini free tier 15 RPM

const progressEl = $('#uploadProgress');
const fillEl = progressEl.querySelector('.progress-fill');
const textEl = progressEl.querySelector('.progress-text');

function setProgress(pct, text) {
  fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  textEl.textContent = text || '';
}

async function handleFiles(files) {
  const promptIdRaw = $('#promptSelect').value;
  const promptId = promptIdRaw ? parseInt(promptIdRaw, 10) : null;
  const hasVocals = $('#hasVocals').checked;

  progressEl.hidden = false;
  setProgress(0, `${files.length}개 파일 준비 중…`);

  const allUploadedIds = [];
  let dupCount = 0, errCount = 0;

  // 1) 청크 단위 업로드 (multer 5개/요청 한도)
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const startIdx = i + 1;
    const endIdx = Math.min(i + CHUNK_SIZE, files.length);
    setProgress(
      Math.round((i / files.length) * 50),  // 업로드는 progress 의 0–50%
      `업로드 중 ${startIdx}–${endIdx} / ${files.length}…`
    );

    try {
      const result = await uploadChunk(chunk, promptId, hasVocals, (loaded, total) => {
        const chunkPct = total > 0 ? loaded / total : 0;
        const overall = ((i / files.length) + (chunkPct * chunk.length / files.length)) * 50;
        setProgress(Math.round(overall), `업로드 중 ${startIdx}–${endIdx} / ${files.length}…`);
      });

      for (const r of result.results || []) {
        if (r.status === 'uploaded') {
          allUploadedIds.push(r.trackId);
        } else if (r.status === 'duplicate') {
          dupCount++;
          toast(`중복 (이미 trackId=${r.existingTrackId}): ${r.filename}`, 'info');
        } else if (r.status === 'error') {
          errCount++;
          toast(`업로드 오류 — ${r.filename}: ${r.error}`, 'error');
        }
      }
    } catch (e) {
      errCount++;
      toast(`청크 업로드 실패: ${e.message}`, 'error');
    }
  }

  setProgress(50, `업로드 완료 (성공 ${allUploadedIds.length}, 중복 ${dupCount}, 오류 ${errCount})`);

  // 2) 일단 트랙 리스트 새로고침 — 사용자가 분석된 길이를 즉시 확인 가능
  await Promise.all([refreshTracks(), refreshStats()]);

  // 3) 제목 생성 — 클라이언트에서 순차 + 4.5s sleep (진행률 표시)
  if (allUploadedIds.length) {
    await generateTitlesSequential(allUploadedIds);
  }

  // 4) 마무리
  progressEl.hidden = true;
  setProgress(0, '');
  if (allUploadedIds.length === 0 && dupCount === 0 && errCount === 0) {
    toast('처리할 파일이 없습니다', 'info');
  } else if (errCount === 0) {
    toast(`완료: ${allUploadedIds.length}개 업로드 + 제목 생성`, 'success');
  }
}

function uploadChunk(files, promptId, hasVocals, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/tracks/upload');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    });
    xhr.addEventListener('load', () => {
      let j;
      try { j = JSON.parse(xhr.responseText); }
      catch { return reject(new Error(`응답 파싱 실패 (HTTP ${xhr.status})`)); }
      if (xhr.status >= 200 && xhr.status < 300 && j.ok) resolve(j);
      else reject(new Error(j.error || `HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('네트워크 오류')));
    xhr.addEventListener('abort', () => reject(new Error('업로드 중단')));

    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    if (promptId) fd.append('promptId', String(promptId));
    fd.append('hasVocals', hasVocals ? 'true' : 'false');
    xhr.send(fd);
  });
}

async function generateTitlesSequential(trackIds) {
  const total = trackIds.length;
  let done = 0, errs = 0;
  for (let i = 0; i < total; i++) {
    setProgress(
      50 + Math.round(((i) / total) * 50),
      `제목 생성 중 ${i + 1}/${total}… (Gemini)`
    );
    try {
      await apiPost('/api/titles/generate', { trackId: trackIds[i] });
      done++;
    } catch (e) {
      errs++;
      console.warn(`title gen failed (trackId=${trackIds[i]}):`, e.message);
      toast(`제목 생성 실패 trackId=${trackIds[i]}: ${e.message}`, 'error');
    }
    // refresh midway so UI shows incremental titles
    if (i % 2 === 1) await refreshTracks();
    if (i < total - 1) await sleep(TITLE_GEN_DELAY_MS);
  }
  setProgress(100, `제목 생성 완료 (성공 ${done}, 실패 ${errs})`);
  await Promise.all([refreshTracks(), refreshStats()]);
}

// ─── Init ───────────────────────────────────────────────────────────
async function init() {
  await Promise.all([refreshStats(), refreshPrompts(), refreshTracks()]);
}
init();
