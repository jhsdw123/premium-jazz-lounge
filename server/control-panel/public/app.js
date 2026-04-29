// Premium Jazz Lounge — Pool tab controller
// vanilla ES module, no external deps

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  prompts: [],
  tracks: [],
  selected: new Set(),
  bulkInProgress: false,
  playingTrackId: null,
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

    // 업로드 dropdown
    const uploadSelect = $('#promptSelect');
    const uploadCur = uploadSelect.value;
    uploadSelect.innerHTML = '<option value="">(없음)</option>';

    // 필터 dropdown
    const filterSelect = $('#filterPrompt');
    const filterCur = filterSelect.value;
    filterSelect.innerHTML = '<option value="">전체</option>';

    for (const p of state.prompts) {
      const label = p.nickname || p.prompt_text.slice(0, 50);
      const text = `${label} (${p.use_count})`;

      const o1 = document.createElement('option');
      o1.value = p.id; o1.textContent = text;
      uploadSelect.appendChild(o1);

      const o2 = document.createElement('option');
      o2.value = p.id; o2.textContent = text;
      filterSelect.appendChild(o2);
    }
    if (uploadCur) uploadSelect.value = uploadCur;
    if (filterCur) filterSelect.value = filterCur;
  } catch (e) {
    toast(`prompts 로드 실패: ${e.message}`, 'error');
  }
}

async function refreshInstruments() {
  try {
    const j = await apiGet('/api/instruments');
    const sel = $('#filterInstrument');
    const cur = sel.value;
    sel.innerHTML = '<option value="">전체</option>';
    for (const it of j.instruments || []) {
      const o = document.createElement('option');
      o.value = it.name;
      o.textContent = `${it.name} (${it.count})`;
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  } catch (e) {
    // 비치명적 — 필터 dropdown 만 비어있게 두고 진행
    console.warn('instruments 로드 실패:', e.message);
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

// ─── Filter form ↔ URL ────────────────────────────────────────────
function readFiltersFromUrl() {
  const p = new URLSearchParams(location.search);
  return {
    search: p.get('search') || '',
    promptId: p.get('prompt') || '',
    hasVocals: p.get('vocals') || '',
    usedFilter: p.get('used') || 'all',
    prefixOrder: p.get('prefix') || 'any',
    instrument: p.get('instrument') || '',
    minDuration: p.get('min') || '',
    maxDuration: p.get('max') || '',
    orderBy: p.get('sort') || 'newest',
  };
}

function writeFiltersToUrl(f) {
  const p = new URLSearchParams();
  if (f.search) p.set('search', f.search);
  if (f.promptId) p.set('prompt', f.promptId);
  if (f.hasVocals) p.set('vocals', f.hasVocals);
  if (f.usedFilter && f.usedFilter !== 'all') p.set('used', f.usedFilter);
  if (f.prefixOrder && f.prefixOrder !== 'any') p.set('prefix', f.prefixOrder);
  if (f.instrument) p.set('instrument', f.instrument);
  if (f.minDuration) p.set('min', f.minDuration);
  if (f.maxDuration) p.set('max', f.maxDuration);
  if (f.orderBy && f.orderBy !== 'newest') p.set('sort', f.orderBy);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

function applyFiltersToForm(f) {
  $('#searchInput').value = f.search;
  $('#filterPrompt').value = f.promptId;
  $('#filterVocals').value = f.hasVocals;
  $('#filterUsed').value = f.usedFilter || 'all';
  $('#filterPrefix').value = f.prefixOrder || 'any';
  $('#filterInstrument').value = f.instrument || '';
  $('#filterMinDur').value = f.minDuration;
  $('#filterMaxDur').value = f.maxDuration;
  $('#filterOrder').value = f.orderBy || 'newest';
}

function readFiltersFromForm() {
  return {
    search: $('#searchInput').value.trim(),
    promptId: $('#filterPrompt').value,
    hasVocals: $('#filterVocals').value,
    usedFilter: $('#filterUsed').value,
    prefixOrder: $('#filterPrefix').value,
    instrument: $('#filterInstrument').value,
    minDuration: $('#filterMinDur').value,
    maxDuration: $('#filterMaxDur').value,
    orderBy: $('#filterOrder').value,
  };
}

function clearFilters() {
  applyFiltersToForm({
    search: '', promptId: '', hasVocals: '',
    usedFilter: 'all', prefixOrder: 'any', instrument: '',
    minDuration: '', maxDuration: '', orderBy: 'newest',
  });
}

async function applyFilters() {
  const f = readFiltersFromForm();
  writeFiltersToUrl(f);
  // 선택 상태는 필터 변경 시 유지하되, 필터링되어 사라진 행의 선택은 자연스럽게 안 보일 뿐
  await refreshTracks();
}

$('#applyFilterBtn').addEventListener('click', () => applyFilters());

$('#resetFilterBtn').addEventListener('click', async () => {
  clearFilters();
  state.selected.clear();
  updateBulkBar();
  await applyFilters();
});

// 검색만 debounce 자동 적용
let searchDebounceTimer = null;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => applyFilters(), 300);
});
// Enter 즉시 적용
$('#searchInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    clearTimeout(searchDebounceTimer);
    applyFilters();
  }
});

// ─── Track list ─────────────────────────────────────────────────────
async function refreshTracks() {
  const f = readFiltersFromForm();
  const p = new URLSearchParams();
  p.set('limit', '200');
  if (f.search) p.set('search', f.search);
  if (f.promptId) p.set('promptId', f.promptId);
  if (f.hasVocals) p.set('hasVocals', f.hasVocals);
  if (f.usedFilter) p.set('usedFilter', f.usedFilter);
  if (f.prefixOrder) p.set('prefixOrder', f.prefixOrder);
  if (f.instrument) p.set('instrument', f.instrument);
  if (f.minDuration) p.set('minDuration', f.minDuration);
  if (f.maxDuration) p.set('maxDuration', f.maxDuration);
  if (f.orderBy) p.set('orderBy', f.orderBy);

  try {
    const j = await apiGet(`/api/tracks?${p}`);
    state.tracks = j.tracks || [];
    renderTracks();
  } catch (e) {
    toast(`tracks 로드 실패: ${e.message}`, 'error');
    state.tracks = [];
    renderTracks();
  }
}

function renderTracks() {
  const tb = $('#trackBody');
  $('#trackCount').textContent = state.tracks.length
    ? `(${state.tracks.length})`
    : '';

  if (!state.tracks.length) {
    const f = readFiltersFromForm();
    const hasFilter = f.search || f.promptId || f.hasVocals
      || (f.usedFilter && f.usedFilter !== 'all')
      || (f.prefixOrder && f.prefixOrder !== 'any')
      || f.instrument || f.minDuration || f.maxDuration;
    tb.innerHTML = `<tr><td colspan="7" class="empty">${
      hasFilter ? '조건에 맞는 곡이 없습니다. 필터를 조정하세요.' : '아직 곡이 없습니다. mp3 파일을 드래그해서 추가하세요.'
    }</td></tr>`;
    updateBulkBar();
    return;
  }

  tb.innerHTML = '';
  for (const t of state.tracks) {
    const tr = document.createElement('tr');
    if (state.selected.has(t.id)) tr.classList.add('selected');

    const titleHtml = t.title?.title_en
      ? escapeHtml(t.title.title_en)
      : '<span class="no-title">(no title)</span>';
    const prefixBadge = t.prefix_order ? `<span class="prefix-badge">${t.prefix_order}</span>` : '';
    const vocalIcon = t.has_vocals ? '<span class="vocal-icon" title="보컬 포함">🎤</span>' : '';

    // 프롬프트 표시: 닉네임 우선, 없으면 prompt_text 전체.
    // 셀 자체는 CSS ellipsis 로 시각적 잘림 처리하고, title 속성으로 hover 시
    // 풀텍스트 노출. (이전엔 JS 에서 slice(0,28) 했는데 그러면 풀텍스트 hover
    // 도 못 봐서 사용자가 데이터 잘린 걸로 오해함.)
    const promptShort = t.prompt?.nickname
      || t.prompt?.prompt_text
      || '—';
    const promptFull = t.prompt?.prompt_text
      ? (t.prompt?.nickname ? `[${t.prompt.nickname}] ${t.prompt.prompt_text}` : t.prompt.prompt_text)
      : '';

    // 악기 chips
    const chipsHtml = (t.instruments && t.instruments.length)
      ? `<div class="instrument-chips">${
          t.instruments.map((i) => `<span class="instrument-chip">${escapeHtml(i)}</span>`).join('')
        }</div>`
      : '';

    // title_id 가 있으면 ♻ reroll, 없으면 ✨ generate
    const titleBtnIcon = t.title_id ? '♻' : '✨';
    const titleBtnTitle = t.title_id ? '제목 reroll' : '제목 생성';

    const isPlaying = state.playingTrackId === t.id;
    if (isPlaying) tr.classList.add('now-playing');
    const playBtnCls = `play-btn${isPlaying ? ' playing' : ''}`;

    tr.innerHTML = `
      <td class="col-check">
        <input type="checkbox" data-id="${t.id}"
               ${state.selected.has(t.id) ? 'checked' : ''} />
      </td>
      <td class="col-id">${t.id}</td>
      <td>
        <div>
          <button class="${playBtnCls}" data-track-id="${t.id}" title="재생/일시정지">▶</button>
          ${prefixBadge}${titleHtml}${vocalIcon}
        </div>
        <div class="filename">${escapeHtml(t.original_filename || '')}</div>
        ${chipsHtml}
      </td>
      <td class="col-duration">${fmtDuration(t.duration_actual_sec)}</td>
      <td class="col-prompt" title="${escapeHtml(promptFull)}">${escapeHtml(promptShort)}</td>
      <td class="col-action">
        <button class="row-btn reroll-btn" data-id="${t.id}" title="${titleBtnTitle}">${titleBtnIcon}</button>
      </td>
      <td class="col-action">
        <button class="row-btn delete-btn" data-id="${t.id}" title="삭제">🗑</button>
      </td>
    `;
    tb.appendChild(tr);
  }

  // Hook up handlers
  $$('.col-check input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = parseInt(cb.dataset.id, 10);
      if (cb.checked) state.selected.add(id);
      else state.selected.delete(id);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      updateBulkBar();
    });
  });
  $$('.reroll-btn').forEach((btn) =>
    btn.addEventListener('click', () => rerollOrGenerate(parseInt(btn.dataset.id, 10), btn))
  );
  $$('.delete-btn').forEach((btn) =>
    btn.addEventListener('click', () => deleteTrack(parseInt(btn.dataset.id, 10)))
  );
  $$('.play-btn').forEach((btn) =>
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      playTrack(parseInt(btn.dataset.trackId, 10));
    })
  );

  updateBulkBar();
}

async function deleteTrack(id) {
  if (!confirm(`trackId=${id} 을(를) 삭제하시겠습니까?\n(Storage + DB 영구 삭제)`)) return;
  try {
    await apiPost('/api/tracks/delete', { ids: [id] });
    toast(`삭제됨: id=${id}`, 'success');
    state.selected.delete(id);
    await Promise.all([refreshTracks(), refreshStats()]);
  } catch (e) {
    toast(`삭제 실패: ${e.message}`, 'error');
  }
}

async function rerollOrGenerate(trackId, btnEl) {
  const track = state.tracks.find((t) => t.id === trackId);
  const isReroll = !!track?.title_id;

  if (isReroll) {
    const cur = track.title?.title_en || `(id=${track.title_id})`;
    if (!confirm(`현재 제목 "${cur}" 을(를) reject 처리하고 새 제목을 받습니다.\n계속하시겠습니까?`)) return;
  }

  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '⏳';

  try {
    const endpoint = isReroll ? '/api/titles/reroll' : '/api/titles/generate';
    const body = isReroll ? { trackId, reason: 'manual reroll' } : { trackId };
    const j = await apiPost(endpoint, body);

    toast(`새 제목: ${j.title.title_en}`, 'success');

    // 해당 row 만 갱신 (전체 리프레시 X)
    const idx = state.tracks.findIndex((t) => t.id === trackId);
    if (idx >= 0) {
      state.tracks[idx] = {
        ...state.tracks[idx],
        title_id: j.title.id,
        title: { id: j.title.id, status: 'used', title_en: j.title.title_en },
      };
      renderTracks();
    }
    refreshStats();  // background refresh
  } catch (e) {
    toast(`${isReroll ? 'Reroll' : 'Generate'} 실패: ${e.message}`, 'error');
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

$('#refreshTracksBtn').addEventListener('click', () =>
  Promise.all([refreshTracks(), refreshStats()])
);

// ─── Bulk action bar ────────────────────────────────────────────────
function updateBulkBar() {
  const n = state.selected.size;
  $('#bulkCount').textContent = n;
  const enabled = n > 0 && !state.bulkInProgress;
  $('#bulkRetitleBtn').disabled = !enabled;
  $('#bulkBackfillBtn').disabled = !enabled;
  $('#bulkExtractBtn').disabled = !enabled;
  $('#bulkDeleteBtn').disabled = !enabled;
}

$('#selectAllBtn').addEventListener('click', () => {
  for (const t of state.tracks) state.selected.add(t.id);
  renderTracks();  // checkbox 상태 + selected row 클래스 갱신
});
$('#clearSelBtn').addEventListener('click', () => {
  state.selected.clear();
  renderTracks();
});

$('#bulkRetitleBtn').addEventListener('click', () => bulkRetitle());
$('#bulkBackfillBtn').addEventListener('click', () => bulkBackfill());
$('#bulkExtractBtn').addEventListener('click', () => bulkExtractInstruments());
$('#bulkDeleteBtn').addEventListener('click', () => bulkDelete());

// ─── Bulk progress UI (재사용) ─────────────────────────────────────
const bulkProgress = $('#bulkProgress');
const bulkFill = bulkProgress.querySelector('.progress-fill');
const bulkText = bulkProgress.querySelector('.progress-text');

function showBulkProgress(text = '시작…') {
  bulkProgress.hidden = false;
  bulkFill.style.width = '0%';
  bulkText.textContent = text;
}
function setBulkProgress(pct, text) {
  bulkFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (text) bulkText.textContent = text;
}
function hideBulkProgress() {
  bulkProgress.hidden = true;
  bulkFill.style.width = '0%';
  bulkText.textContent = '';
}

async function bulkRetitle() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  if (!confirm(`${ids.length}개 트랙의 제목을 일괄 재생성합니다.\n(이미 제목 있으면 reject 후 새로 생성)\n약 ${Math.ceil(ids.length * 4.5)}초 소요. 계속?`)) return;

  state.bulkInProgress = true;
  updateBulkBar();
  showBulkProgress(`0/${ids.length} 제목 작업 중…`);

  let ok = 0, errs = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const track = state.tracks.find((t) => t.id === id);
    const isReroll = !!track?.title_id;
    setBulkProgress(
      Math.round((i / ids.length) * 100),
      `${i + 1}/${ids.length} ${isReroll ? '리롤' : '생성'} 중… (id=${id})`
    );
    try {
      const endpoint = isReroll ? '/api/titles/reroll' : '/api/titles/generate';
      const body = isReroll ? { trackId: id, reason: 'bulk retitle' } : { trackId: id };
      await apiPost(endpoint, body);
      ok++;
    } catch (e) {
      errs++;
      console.warn(`bulk retitle id=${id}:`, e.message);
    }
    if (i < ids.length - 1) await sleep(4500);
  }
  setBulkProgress(100, `완료: 성공 ${ok}, 실패 ${errs}`);

  state.bulkInProgress = false;
  await Promise.all([refreshTracks(), refreshStats()]);
  setTimeout(hideBulkProgress, 2200);

  if (errs) toast(`일괄 retitle: 성공 ${ok}, 실패 ${errs}`, 'info');
  else toast(`일괄 retitle 완료: ${ok}개`, 'success');
}

async function bulkBackfill() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  if (!confirm(`${ids.length}개 트랙의 길이/BPM 을 ffprobe 로 일괄 재분석합니다. 계속?`)) return;

  state.bulkInProgress = true;
  updateBulkBar();
  showBulkProgress(`backfill 중… (${ids.length}곡 sequential)`);

  try {
    const j = await apiPost('/api/tracks/backfill', { ids });
    setBulkProgress(100,
      `완료: analyzed=${j.summary.analyzed}, dl=${j.summary.dlErrors}, an=${j.summary.anErrors}, upd=${j.summary.updErrors}`
    );
    if (j.summary.analyzed > 0) {
      toast(`backfill 완료: ${j.summary.analyzed}곡 분석`, 'success');
    } else {
      toast(`backfill: 분석된 곡 없음`, 'info');
    }
  } catch (e) {
    toast(`backfill 실패: ${e.message}`, 'error');
  }

  state.bulkInProgress = false;
  await Promise.all([refreshTracks(), refreshStats()]);
  setTimeout(hideBulkProgress, 2200);
}

async function bulkExtractInstruments() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  const overwrite = confirm(
    `${ids.length}개 트랙의 prompt_text 에서 악기를 재추출합니다.\n\n` +
    `[확인]: 기존 instruments 있어도 덮어쓰기\n` +
    `[취소]: 빈 instruments 만 채움 (안전)`
  );
  // confirm: OK = overwrite=true, Cancel = overwrite=false (작업 자체는 진행)
  // 작업 취소하려면 ESC 가 아니라 그냥 다른 버튼 안 누르면 됨

  state.bulkInProgress = true;
  updateBulkBar();
  showBulkProgress(`악기 추출 중… (${ids.length}곡)`);

  try {
    const j = await apiPost('/api/tracks/extract-instruments', { ids, overwrite });
    setBulkProgress(100,
      `완료: 갱신 ${j.summary.updated}, 스킵 ${j.summary.skipped}, 실패 ${j.summary.errors}`
    );
    if (j.summary.updated > 0) {
      toast(`악기 추출 완료: ${j.summary.updated}곡 갱신`, 'success');
    } else {
      toast(`악기 추출: 갱신 없음 (${overwrite ? 'master 비어있음 또는 prompt 없음' : '이미 다 채워져 있음'})`, 'info');
    }
  } catch (e) {
    toast(`악기 추출 실패: ${e.message}`, 'error');
  }

  state.bulkInProgress = false;
  await Promise.all([refreshTracks(), refreshStats(), refreshInstruments()]);
  setTimeout(hideBulkProgress, 1800);
}

async function bulkDelete() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  if (!confirm(`${ids.length}개 트랙을 영구 삭제합니다. (Storage + DB)\n되돌릴 수 없습니다. 계속?`)) return;

  state.bulkInProgress = true;
  updateBulkBar();
  showBulkProgress(`삭제 중…`);

  try {
    const j = await apiPost('/api/tracks/delete', { ids });
    setBulkProgress(100, `삭제됨: ${j.deleted} (Storage: ${j.removedFromStorage})`);
    toast(`${j.deleted}개 삭제 완료`, 'success');
    state.selected.clear();
  } catch (e) {
    toast(`일괄 삭제 실패: ${e.message}`, 'error');
  }

  state.bulkInProgress = false;
  await Promise.all([refreshTracks(), refreshStats()]);
  setTimeout(hideBulkProgress, 1800);
}

// ─── beforeunload guard during bulk ─────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (state.bulkInProgress) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

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
  fi.value = '';
});

// ─── Upload pipeline ────────────────────────────────────────────────
const CHUNK_SIZE = 5;
const TITLE_GEN_DELAY_MS = 4500;

const progressEl = $('#uploadProgress');
const fillEl = progressEl.querySelector('.progress-fill');
const textEl = progressEl.querySelector('.progress-text');

function setUploadProgress(pct, text) {
  fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  textEl.textContent = text || '';
}

async function handleFiles(files) {
  const promptIdRaw = $('#promptSelect').value;
  const promptId = promptIdRaw ? parseInt(promptIdRaw, 10) : null;
  const hasVocals = $('#hasVocals').checked;

  progressEl.hidden = false;
  setUploadProgress(0, `${files.length}개 파일 준비 중…`);

  const allUploadedIds = [];
  let dupCount = 0, errCount = 0;

  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const startIdx = i + 1;
    const endIdx = Math.min(i + CHUNK_SIZE, files.length);
    setUploadProgress(
      Math.round((i / files.length) * 50),
      `업로드 중 ${startIdx}–${endIdx} / ${files.length}…`
    );
    try {
      const result = await uploadChunk(chunk, promptId, hasVocals, (loaded, total) => {
        const chunkPct = total > 0 ? loaded / total : 0;
        const overall = ((i / files.length) + (chunkPct * chunk.length / files.length)) * 50;
        setUploadProgress(Math.round(overall), `업로드 중 ${startIdx}–${endIdx} / ${files.length}…`);
      });
      for (const r of result.results || []) {
        if (r.status === 'uploaded') allUploadedIds.push(r.trackId);
        else if (r.status === 'duplicate') {
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

  setUploadProgress(50, `업로드 완료 (성공 ${allUploadedIds.length}, 중복 ${dupCount}, 오류 ${errCount})`);

  await Promise.all([refreshTracks(), refreshStats()]);

  if (allUploadedIds.length) {
    await generateTitlesSequential(allUploadedIds);
  }

  progressEl.hidden = true;
  setUploadProgress(0, '');
  if (allUploadedIds.length === 0 && dupCount === 0 && errCount === 0) {
    toast('처리할 파일이 없습니다', 'info');
  } else if (errCount === 0 && allUploadedIds.length > 0) {
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
    setUploadProgress(
      50 + Math.round((i / total) * 50),
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
    if (i % 2 === 1) await refreshTracks();
    if (i < total - 1) await sleep(TITLE_GEN_DELAY_MS);
  }
  setUploadProgress(100, `제목 생성 완료 (성공 ${done}, 실패 ${errs})`);
  await Promise.all([refreshTracks(), refreshStats()]);
}

// ─── Audio preview (sticky player) ──────────────────────────────────
const audioPlayer = $('#audioPlayer');
const audioEl = $('#audioEl');
const npTitle = $('#npTitle');

function clearPlayingState() {
  state.playingTrackId = null;
  $$('.play-btn.playing').forEach((b) => b.classList.remove('playing'));
  $$('tr.now-playing').forEach((tr) => tr.classList.remove('now-playing'));
}

async function playTrack(trackId) {
  // 같은 곡 ▶ 다시 누르면 toggle 일시정지/재개
  if (state.playingTrackId === trackId && !audioEl.paused) {
    audioEl.pause();
    return;
  }
  if (state.playingTrackId === trackId && audioEl.paused && audioEl.src) {
    try { await audioEl.play(); } catch {}
    return;
  }

  // 다른 곡 ▶ → 기존 재생 중단 + URL 새로 fetch
  clearPlayingState();
  audioEl.pause();

  let info;
  try {
    const r = await fetch(`/api/tracks/${trackId}/audio-url`);
    info = await r.json();
    if (!r.ok || !info.ok) throw new Error(info.error || `HTTP ${r.status}`);
  } catch (e) {
    toast(`재생 URL 발급 실패: ${e.message}`, 'error');
    return;
  }

  audioEl.src = info.url;
  npTitle.textContent = info.title || info.originalFilename || `Track #${trackId}`;
  npTitle.title = info.originalFilename || '';
  audioPlayer.hidden = false;

  state.playingTrackId = trackId;
  // playing 표시
  const btn = document.querySelector(`.play-btn[data-track-id="${trackId}"]`);
  if (btn) btn.classList.add('playing');
  const row = btn?.closest('tr');
  if (row) row.classList.add('now-playing');

  try {
    await audioEl.play();
  } catch (e) {
    toast(`재생 실패: ${e.message}`, 'error');
    clearPlayingState();
    audioPlayer.hidden = true;
  }
}

$('#closePlayer').addEventListener('click', () => {
  audioEl.pause();
  audioEl.removeAttribute('src');
  audioEl.load();
  audioPlayer.hidden = true;
  clearPlayingState();
});

audioEl.addEventListener('ended', () => {
  // 재생 완료 — playing 표시만 해제, player 는 유지 (사용자가 시크/재생 가능)
  $$('.play-btn.playing').forEach((b) => b.classList.remove('playing'));
});

audioEl.addEventListener('play', () => {
  // 재개 시 ▶ 다시 활성화 표시
  if (state.playingTrackId != null) {
    const btn = document.querySelector(`.play-btn[data-track-id="${state.playingTrackId}"]`);
    if (btn) btn.classList.add('playing');
  }
});

audioEl.addEventListener('pause', () => {
  // 일시정지 — 행 highlight 는 유지하지만 ▶ pulse 는 멈춤
  if (!audioEl.ended) {
    $$('.play-btn.playing').forEach((b) => b.classList.remove('playing'));
  }
});

// ─── Init ───────────────────────────────────────────────────────────
async function init() {
  // 1) prompts + instruments 먼저 로드 (필터 dropdown 옵션 채우기 위해)
  await Promise.all([refreshStats(), refreshPrompts(), refreshInstruments()]);
  // 2) URL → form 적용
  applyFiltersToForm(readFiltersFromUrl());
  // 3) 트랙 로드
  await refreshTracks();
}
init();
