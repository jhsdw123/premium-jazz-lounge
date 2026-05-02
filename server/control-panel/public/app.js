// Premium Jazz Lounge — Pool tab controller
// vanilla ES module, no external deps

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  prompts: [],
  tracks: [],
  tracksTotal: null,        // Phase 4-D-5-A: pjl_tracks 활성 트랙 총 개수 (서버에서 받음)
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

// Phase 4-D-5-A: 마지막 사용 시점 → 사람 친화적 표시 ('어제', '3주 전', ...).
function formatLastUsed(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  if (days < 30) return `${Math.floor(days / 7)}주 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

// Phase 4-D-5-B: '2026-05-02 14:30' 형식. expand 이력 항목의 절대 시각용.
function formatDateShort(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// Phase 4-D-5-B: 곡 행 클릭 시 바로 아래 한 줄 expand. 다시 클릭 시 닫힘.
async function toggleTrackUsageExpand(trackId, row) {
  // 이미 펼쳐져 있으면 제거 (토글 닫기)
  const existing = document.querySelector(`tr[data-usage-for="${trackId}"]`);
  if (existing) {
    existing.remove();
    row.classList.remove('expanded');
    return;
  }

  // 새 expand row 삽입 — loading 상태
  const expandRow = document.createElement('tr');
  expandRow.className = 'usage-expand-row';
  expandRow.setAttribute('data-usage-for', String(trackId));
  expandRow.innerHTML = `
    <td colspan="10">
      <div class="usage-loading">이력 로딩 중…</div>
    </td>
  `;
  row.parentNode.insertBefore(expandRow, row.nextSibling);
  row.classList.add('expanded');

  try {
    const j = await apiGet(`/api/tracks/${trackId}/usage`);
    renderUsageExpand(expandRow.querySelector('td'), j.usage || [], j.count || 0);
  } catch (e) {
    expandRow.querySelector('td').innerHTML =
      `<div class="usage-error">이력 조회 실패: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function renderUsageExpand(container, usage, count) {
  if (count === 0) {
    container.innerHTML = `<div class="usage-empty">아직 사용된 적 없습니다.</div>`;
    return;
  }
  const items = usage.map((u) => {
    const rel = formatLastUsed(u.used_at);
    const abs = formatDateShort(u.used_at);
    return `
      <div class="usage-item">
        <span class="usage-when" title="${escapeHtml(abs)}">${escapeHtml(rel)}</span>
        <span class="usage-pos">${u.track_position}번째 곡</span>
        <span class="usage-vid" title="${escapeHtml(abs)}">${escapeHtml(u.video_id || '')}</span>
      </div>
    `;
  }).join('');
  container.innerHTML = `
    <div class="usage-header">📋 사용 이력 (총 ${count}회)</div>
    <div class="usage-list">${items}</div>
  `;
}

// ─── Tab switching ──────────────────────────────────────────────────
function switchTab(tab) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `tab-${tab}`));
  if (tab === 'builder' && typeof window.builderOnEnter === 'function') {
    window.builderOnEnter();
  }
  if (tab === 'templates' && typeof window.templatesOnEnter === 'function') {
    window.templatesOnEnter();
  }
  if (tab === 'studio' && typeof window.studioOnEnter === 'function') {
    window.studioOnEnter();
  }
  if (tab === 'uploader' && typeof window.uploaderOnEnter === 'function') {
    window.uploaderOnEnter();
  }
}
window.switchTab = switchTab;
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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
    orderBy: p.get('sort') || 'recommend',
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
  if (f.orderBy && f.orderBy !== 'recommend') p.set('sort', f.orderBy);
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
  $('#filterOrder').value = f.orderBy || 'recommend';
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
    minDuration: '', maxDuration: '', orderBy: 'recommend',
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
  // Phase 4-D-5-A: 100곡 표시 (이전 200 → 100). 정렬이 사용 횟수 기반이라 더 적게 보여도 OK.
  p.set('limit', '100');
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
    state.tracksTotal = (typeof j.total === 'number') ? j.total : null;
    renderTracks();
  } catch (e) {
    toast(`tracks 로드 실패: ${e.message}`, 'error');
    state.tracks = [];
    state.tracksTotal = null;
    renderTracks();
  }
}

function renderTracks() {
  const tb = $('#trackBody');
  // Phase 4-D-5-A: '표시 N / 총 N' 형식. total 모르면 표시 카운트만.
  const shown = state.tracks.length;
  const total = state.tracksTotal;
  $('#trackCount').textContent = shown
    ? (total != null ? `(${shown} / 총 ${total} 곡)` : `(${shown})`)
    : '';

  if (!state.tracks.length) {
    const f = readFiltersFromForm();
    const hasFilter = f.search || f.promptId || f.hasVocals
      || (f.usedFilter && f.usedFilter !== 'all')
      || (f.prefixOrder && f.prefixOrder !== 'any')
      || f.instrument || f.minDuration || f.maxDuration;
    tb.innerHTML = `<tr><td colspan="10" class="empty">${
      hasFilter ? '조건에 맞는 곡이 없습니다. 필터를 조정하세요.' : '아직 곡이 없습니다. mp3 파일을 드래그해서 추가하세요.'
    }</td></tr>`;
    updateBulkBar();
    return;
  }

  tb.innerHTML = '';
  for (const t of state.tracks) {
    const tr = document.createElement('tr');
    tr.classList.add('track-row');
    tr.dataset.trackId = String(t.id);
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
      <td class="col-usage">${t.used_count || 0}</td>
      <td class="col-last-used" title="${t.last_used_at ? escapeHtml(t.last_used_at) : '한 번도 사용 안 함'}">${formatLastUsed(t.last_used_at)}</td>
      <td class="col-action">
        <button class="row-btn reroll-btn" data-id="${t.id}" title="${titleBtnTitle}">${titleBtnIcon}</button>
      </td>
      <td class="col-action">
        <button class="row-btn reset-usage-btn" data-id="${t.id}" title="사용 이력 리셋"${(t.used_count || 0) === 0 ? ' disabled' : ''}>🔄</button>
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
  $$('.reset-usage-btn').forEach((btn) =>
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      resetTrackUsage(parseInt(btn.dataset.id, 10));
    })
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

  // Phase 4-D-5-B: 행 클릭 → 사용 이력 expand. checkbox/button 클릭은 트리거 X.
  $$('.track-row').forEach((row) => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('input[type="checkbox"]')) return;
      if (ev.target.closest('button')) return;
      if (ev.target.closest('.col-action')) return;
      const id = parseInt(row.dataset.trackId, 10);
      if (Number.isFinite(id)) toggleTrackUsageExpand(id, row);
    });
  });

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

// Phase 4-D-5-C: 단일 곡 사용 이력 리셋 — used_count=0, last_used_at=null, 이력 삭제.
async function resetTrackUsage(id) {
  const t = state.tracks.find((x) => x.id === id);
  const cur = t?.used_count || 0;
  if (cur === 0) {
    toast('이미 사용 이력이 없습니다', 'info');
    return;
  }
  if (!confirm(`trackId=${id} 의 사용 이력을 리셋합니다.\n(used_count ${cur} → 0, 이력 row 삭제 — 곡 자체는 유지)\n계속?`)) return;
  try {
    const j = await apiPost(`/api/tracks/${id}/reset-usage`, {});
    toast(`리셋됨: id=${id} (이력 ${j.usageRowsDeleted}건 삭제)`, 'success');
    await Promise.all([refreshTracks(), refreshStats()]);
  } catch (e) {
    toast(`리셋 실패: ${e.message}`, 'error');
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

    // Phase 4-D-5-D: warning 응답이면 노란 toast — 단어 다양성 회피 실패한 fallback 결과.
    if (j.warning) {
      toast(`⚠ 새 제목: ${j.title.title_en} — ${j.warning.message} (issues: ${(j.warning.issues || []).join(', ')})`, 'warn', 8000);
    } else {
      toast(`새 제목: ${j.title.title_en}`, 'success');
    }

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
  $('#bulkResetUsageBtn').disabled = !enabled;
  $('#bulkDeleteBtn').disabled = !enabled;
  $('#sendToBuilderBtn').disabled = !enabled;
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
$('#bulkResetUsageBtn').addEventListener('click', () => bulkResetUsage());
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

  let ok = 0, warns = 0, errs = 0;
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
      const j = await apiPost(endpoint, body);
      if (j.warning) {
        warns++;
        console.warn(`[retitle warn] id=${id}: ${j.title.title_en}`, j.warning);
      }
      ok++;
    } catch (e) {
      errs++;
      console.warn(`bulk retitle id=${id}:`, e.message);
    }
    if (i < ids.length - 1) await sleep(4500);
  }
  setBulkProgress(100, `완료: 성공 ${ok} (경고 ${warns}), 실패 ${errs}`);

  state.bulkInProgress = false;
  await Promise.all([refreshTracks(), refreshStats()]);
  setTimeout(hideBulkProgress, 2200);

  if (errs) toast(`일괄 retitle: 성공 ${ok}, 경고 ${warns}, 실패 ${errs}`, 'info');
  else if (warns) toast(`일괄 retitle 완료: ${ok}개 — 그중 ${warns}개는 다양성 회피 실패 (수동 검토 권장)`, 'warn', 8000);
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

// Phase 4-D-5-C: 다중 선택 곡 사용 이력 일괄 리셋 (used_count=0, last_used_at=null, 이력 row 삭제).
async function bulkResetUsage() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  if (!confirm(`${ids.length}곡의 사용 이력을 리셋합니다.\n(used_count=0, 이력 row 삭제 — 곡 자체는 유지)\n계속?`)) return;

  state.bulkInProgress = true;
  updateBulkBar();
  showBulkProgress(`이력 리셋 중…`);

  try {
    const j = await apiPost('/api/tracks/reset-usage', { ids });
    setBulkProgress(100, `리셋됨: ${j.reset}곡 (이력 ${j.usageRowsDeleted}건 삭제)`);
    toast(`${j.reset}곡 이력 리셋 완료`, 'success');
    state.selected.clear();
  } catch (e) {
    toast(`일괄 리셋 실패: ${e.message}`, 'error');
  }

  state.bulkInProgress = false;
  await Promise.all([refreshTracks(), refreshStats()]);
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

// ─── Send to Builder ────────────────────────────────────────────────
const BUILDER_SS_KEY = 'pjl.builder.trackIds';

$('#sendToBuilderBtn').addEventListener('click', () => {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  sessionStorage.setItem(BUILDER_SS_KEY, JSON.stringify(ids));
  toast(`${ids.length}곡을 Builder 로 전송`, 'success');
  switchTab('builder');
});

// ─── Builder tab ────────────────────────────────────────────────────
const builder = {
  tracks: [],          // 정렬된 트랙 객체들 (Pool API 응답 형태)
  templates: [],
  series: [],
  unpinAll: false,
  suggestedTitles: [],
  loading: false,
  rendering: false,
};

function fmtMinSec(totalSec) {
  if (!totalSec || !Number.isFinite(totalSec)) return '0:00';
  const m = Math.floor(totalSec / 60);
  const s = String(Math.round(totalSec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function fmtNatural(totalSec) {
  // 25~35분 자연스러운 표시
  if (!totalSec) return '—';
  const min = Math.round(totalSec / 60);
  if (min < 20) return `${min}분 (짧음 — 25분 이상 권장)`;
  if (min < 25) return `${min}분 (다소 짧음)`;
  if (min <= 35) return `${min}분 (적정)`;
  if (min <= 45) return `${min}분 (다소 김)`;
  return `${min}분 (너무 김 — 45분 이하 권장)`;
}

// Builder 첫 진입 시 자동 정렬 힌트 — prefix_order 1~5 곡을 슬롯 1~5 에 배치,
// 나머지는 뒤쪽에 들어온 순서대로. 호출 시점은 builderOnEnter 진입 1회만.
// 이후 셔플/드래그 결과는 그대로 보존 (prefix_order 무시).
function arrangeTracksWithPins(rawTracks) {
  const slots = new Array(rawTracks.length);
  const pool = [];
  for (const t of rawTracks) {
    const po = t.prefix_order;
    if (po >= 1 && po <= 5 && po - 1 < rawTracks.length && !slots[po - 1]) {
      slots[po - 1] = t;
    } else {
      pool.push(t);
    }
  }
  let pi = 0;
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i]) slots[i] = pool[pi++];
  }
  return slots.filter(Boolean);
}

// 핀 = "화면에 보이는 위치 1~5" — 순수 인덱스 기준. prefix_order 는 무관.
function isPinnedAtIndex(idx) {
  return !builder.unpinAll && idx >= 0 && idx <= 4;
}

// builder.tracks 가 곧 디스플레이 순서.
function getOrderedTracksForRender() {
  return [...builder.tracks];
}

// Phase 4-D fix: Builder 곡 list 의 prompt 키워드 추출 + 색상 + 다양성 검사.
//
// 추출 우선순위:
//   1) prompt.nickname  — 형님이 직접 붙인 짧은 라벨 (있으면 그대로 사용)
//   2) 알려진 키워드 매칭 — prompt_text 안에 포함된 첫 일치
//   3) prompt_text 의 첫 단어
//   4) '?'
const KNOWN_PROMPT_KEYWORDS = [
  'Showa-era', 'Showa', 'Bayou', 'Dixie', 'New Orleans',
  'Smooth', 'Classic', 'Modern', 'Vintage',
  'Latin', 'Bossa', 'Cool', 'Hard Bop',
  'Swing', 'Be-bop', 'Bebop', 'Smoky', 'Dreamy',
  'Cafe', 'Lounge', 'Midnight', 'Sunset', 'Rainy',
  'Tokyo', 'Paris', 'Havana',
];
const PROMPT_COLORS = {
  'Showa-era': '#FFC107', 'Showa': '#FFC107',
  'Bayou': '#03A9F4', 'Dixie': '#E91E63',
  'New Orleans': '#9C27B0',
  'Smooth': '#4CAF50', 'Classic': '#FF9800', 'Modern': '#607D8B', 'Vintage': '#8D6E63',
  'Latin': '#F44336', 'Bossa': '#26A69A', 'Cool': '#00BCD4', 'Hard Bop': '#5D4037',
  'Swing': '#7E57C2', 'Be-bop': '#3949AB', 'Bebop': '#3949AB',
  'Smoky': '#795548', 'Dreamy': '#AB47BC',
  'Cafe': '#A1887F', 'Lounge': '#42A5F5', 'Midnight': '#1A237E',
  'Sunset': '#FF7043', 'Rainy': '#5C6BC0',
  'Tokyo': '#EF5350', 'Paris': '#EC407A', 'Havana': '#FFB300',
};

function extractPromptKeyword(t) {
  if (t?.prompt?.nickname) return t.prompt.nickname.trim();
  const text = t?.prompt?.prompt_text || '';
  if (!text) return '?';
  const lower = text.toLowerCase();
  for (const kw of KNOWN_PROMPT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  const firstWord = text.trim().split(/[\s,/.;:|]+/).filter(Boolean)[0];
  return firstWord || '?';
}

function getPromptColor(keyword) {
  if (PROMPT_COLORS[keyword]) return PROMPT_COLORS[keyword];
  // 알려지지 않은 키워드도 안정적인 색상 — 문자열 hash → HSL.
  let h = 0;
  for (let i = 0; i < keyword.length; i++) h = (h * 31 + keyword.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 55%, 45%)`;
}

// 같은 keyword 가 N 회 연속이면 그 인덱스들을 warning set 으로.
function findDiversityWarnings(tracks) {
  const warns = new Map();              // idx → { keyword, runLength }
  let runStart = 0;
  for (let i = 0; i <= tracks.length; i++) {
    const cur = i < tracks.length ? extractPromptKeyword(tracks[i]) : null;
    const prev = i > 0 ? extractPromptKeyword(tracks[i - 1]) : null;
    if (cur !== prev) {
      // run 종료 — 길이 ≥2 이면 마지막 (i-1) 까지 모두 warn.
      const runLen = i - runStart;
      if (runLen >= 2 && prev && prev !== '?') {
        for (let j = runStart; j < i; j++) {
          warns.set(j, { keyword: prev, runLength: runLen });
        }
      }
      runStart = i;
    }
  }
  return warns;
}

// 다양성 셔플 — keyword 별 그룹화 후 라운드로빈 인터리브.
// 1~5번 핀 슬롯은 유지 (unpinAll 이면 PIN_COUNT=0).
function shuffleForDiversity(tracks) {
  const PIN_COUNT = builder.unpinAll ? 0 : Math.min(5, tracks.length);
  const pinned = tracks.slice(0, PIN_COUNT);
  const free = tracks.slice(PIN_COUNT);

  // keyword 별 그룹화 — '?' 도 하나의 그룹.
  const groups = new Map();
  for (const t of free) {
    const kw = extractPromptKeyword(t);
    if (!groups.has(kw)) groups.set(kw, []);
    groups.get(kw).push(t);
  }
  // 큰 그룹 먼저 시작 → 그 그룹이 끝까지 잘 분산됨.
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const queues = ordered.map(([, arr]) => arr.slice());
  const result = [];
  let safety = free.length + 1;
  while (queues.some((q) => q.length) && safety-- > 0) {
    let lastKw = result.length ? extractPromptKeyword(result[result.length - 1]) : null;
    let placed = false;
    // 직전 곡과 다른 keyword 인 가장 큰 큐 우선.
    let bestIdx = -1;
    let bestLen = -1;
    for (let i = 0; i < queues.length; i++) {
      if (!queues[i].length) continue;
      const kw = ordered[i][0];
      if (kw === lastKw) continue;
      if (queues[i].length > bestLen) { bestLen = queues[i].length; bestIdx = i; }
    }
    if (bestIdx < 0) {
      // 모든 후보가 lastKw — 어쩔 수 없이 같은 그룹 한 개 더.
      for (let i = 0; i < queues.length; i++) {
        if (queues[i].length) { bestIdx = i; break; }
      }
      if (bestIdx < 0) break;
    }
    result.push(queues[bestIdx].shift());
    placed = true;
    if (!placed) break;
  }
  return [...pinned, ...result];
}

function renderBuilderTracks() {
  const container = $('#bTracks');
  const ordered = getOrderedTracksForRender();
  container.innerHTML = '';
  const warns = findDiversityWarnings(ordered);

  let totalDur = 0;
  ordered.forEach((t, idx) => {
    const pos = idx + 1;
    const dur = Number(t.duration_actual_sec) || Number(t.duration_raw_sec) || 0;
    totalDur += dur;
    const isPinSlot = isPinnedAtIndex(idx);
    const draggable = !isPinSlot;

    const row = document.createElement('div');
    row.className = 'btrack';
    row.dataset.id = t.id;
    if (draggable) row.draggable = true;

    const titleText = t.title?.title_en || t.original_filename || `Track ${t.id}`;
    const isPlaying = state.playingTrackId === t.id;
    const keyword = extractPromptKeyword(t);
    const promptColor = getPromptColor(keyword);
    const promptFull = t.prompt?.prompt_text
      ? (t.prompt.nickname ? `[${t.prompt.nickname}] ${t.prompt.prompt_text}` : t.prompt.prompt_text)
      : '';
    const warn = warns.get(idx);
    if (warn) row.classList.add('diversity-warn');

    const warnIcon = warn
      ? `<span class="bdiversity-warn" title="${escapeHtml(warn.keyword)} ${warn.runLength}연속 — 셔플 권장">⚠</span>`
      : '';

    row.innerHTML = `
      <span class="drag-handle ${draggable ? '' : 'locked'}" title="${draggable ? '드래그해서 순서 변경' : '핀 잠금'}">⋮⋮</span>
      <span class="pos">${pos}</span>
      <span class="pin-icon ${isPinSlot ? '' : 'unpinned'}" title="${isPinSlot ? `1~5번 고정 (셔플/드래그 제외)` : ''}">${isPinSlot ? '📌' : ''}</span>
      <button class="bplay play-btn ${isPlaying ? 'playing' : ''}" data-track-id="${t.id}" title="재생/일시정지">▶</button>
      <span class="btitle-cell">
        <span class="btitle-text" title="${escapeHtml(titleText)}">${escapeHtml(titleText)}</span>
        <span class="bprompt-tag" style="background:${promptColor};" title="${escapeHtml(promptFull)}">${escapeHtml(keyword)}</span>
        ${warnIcon}
      </span>
      <span class="bdur">${fmtMinSec(dur)}</span>
      <button class="bremove" data-id="${t.id}" title="제외">×</button>
    `;
    container.appendChild(row);
  });

  // 요약
  $('#bTrackCount').textContent = ordered.length;
  $('#bSumCount').textContent = ordered.length;
  $('#bSumDuration').textContent = fmtMinSec(totalDur);
  $('#bSumNatural').textContent = fmtNatural(totalDur);

  // 핸들러
  container.querySelectorAll('.bremove').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeBuilderTrack(parseInt(b.dataset.id, 10));
    })
  );
  // ▶ 재생 — Pool 의 playTrack 재사용 (같은 module). data-track-id 와 .play-btn 클래스
  // 가 동일해서 playing 상태 표시도 자동 동기화됨.
  container.querySelectorAll('.bplay').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      playTrack(parseInt(b.dataset.trackId, 10));
    })
  );

  setupDragDrop(container);
}

function setupDragDrop(container) {
  let dragId = null;
  container.querySelectorAll('.btrack[draggable="true"]').forEach((row) => {
    row.addEventListener('dragstart', (ev) => {
      dragId = parseInt(row.dataset.id, 10);
      row.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(dragId));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      container.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
      dragId = null;
    });
  });

  container.querySelectorAll('.btrack').forEach((row) => {
    row.addEventListener('dragover', (ev) => {
      if (dragId == null) return;
      const targetId = parseInt(row.dataset.id, 10);
      if (targetId === dragId) return;
      // 핀 슬롯 위로는 드롭 불가
      if (row.querySelector('.drag-handle.locked')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-target');
    });
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const targetId = parseInt(row.dataset.id, 10);
      if (dragId == null || targetId === dragId) return;
      reorderBuilderTracks(dragId, targetId);
    });
  });
}

function reorderBuilderTracks(srcId, targetId) {
  // 핀 슬롯(인덱스 0~4, unpinAll=false 일 때) 은 src/target 모두 거부.
  const srcIdx = builder.tracks.findIndex((t) => t.id === srcId);
  const tgtIdx = builder.tracks.findIndex((t) => t.id === targetId);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
  if (isPinnedAtIndex(srcIdx) || isPinnedAtIndex(tgtIdx)) return;

  const [src] = builder.tracks.splice(srcIdx, 1);
  const adj = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
  builder.tracks.splice(adj, 0, src);
  renderBuilderTracks();
}

function removeBuilderTrack(id) {
  // 단순 splice. 인덱스 기준 핀이라 뒤에서 한 칸씩 당겨오는 자연스러운 동작.
  // (사용자가 셔플/드래그로 정한 순서를 prefix_order 로 다시 흔들지 않음)
  builder.tracks = builder.tracks.filter((t) => t.id !== id);
  sessionStorage.setItem(BUILDER_SS_KEY, JSON.stringify(builder.tracks.map((t) => t.id)));
  renderBuilderTracks();
}

// 핀 = 인덱스 0~4 (화면 1~5번). 그 자리는 셔플/드래그 제외.
// unpinAll 이면 PIN_COUNT=0 → 전체가 free.
function shuffleNonPinned() {
  const PIN_COUNT = builder.unpinAll ? 0 : 5;
  const pinned = builder.tracks.slice(0, PIN_COUNT);
  const free = builder.tracks.slice(PIN_COUNT);
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  builder.tracks = [...pinned, ...free];
  renderBuilderTracks();
  return free.length;
}

$('#bShufflePartialBtn').addEventListener('click', () => {
  const n = shuffleNonPinned();
  toast(builder.unpinAll ? `전체 ${n}곡 셔플` : `핀 외 ${n}곡 셔플`, 'info');
});

$('#bShuffleAllBtn').addEventListener('click', () => {
  if (!confirm('1~5번 핀까지 모두 풀고 전체를 섞습니다. 계속?')) return;
  $('#bUnpinAll').checked = true;
  builder.unpinAll = true;
  shuffleNonPinned();
  toast('전체 셔플 완료', 'info');
});

// Phase 4-D fix: 같은 prompt 곡끼리 멀리 떨어지게 라운드로빈 재배치.
$('#bShuffleDiversityBtn').addEventListener('click', () => {
  if (!builder.tracks.length) return;
  builder.tracks = shuffleForDiversity(builder.tracks);
  renderBuilderTracks();
  const remaining = findDiversityWarnings(builder.tracks).size;
  if (remaining === 0) toast('다양성 셔플 완료 — 연속 곡 없음', 'success');
  else toast(`다양성 셔플 — 일부 (${remaining}곡) 는 prompt 부족으로 분산 불가`, 'warn', 5000);
});

$('#bUnpinAll').addEventListener('change', (ev) => {
  // 토글만. builder.tracks 순서는 그대로 유지 (사용자가 셔플/드래그한 결과 보존).
  builder.unpinAll = ev.target.checked;
  renderBuilderTracks();
});

// ─── AI 추천 ─────────────────────────────────────────────────────────
async function suggestTitles() {
  if (!builder.tracks.length) return;
  $('#bSuggestLoading').hidden = false;
  $('#bSuggestChips').innerHTML = '';
  $('#bSuggestBtn').disabled = true;
  $('#bSuggestRetryBtn').hidden = true;
  const seriesName = pickSeriesNameForContext();
  try {
    const j = await apiPost('/api/videos/suggest-titles', {
      trackIds: builder.tracks.map((t) => t.id),
      seriesName: seriesName || undefined,
    });
    builder.suggestedTitles = j.titles || [];
    renderSuggestChips();
    $('#bSuggestRetryBtn').hidden = false;
  } catch (e) {
    toast(`AI 추천 실패: ${e.message}`, 'error');
  } finally {
    $('#bSuggestLoading').hidden = true;
    $('#bSuggestBtn').disabled = false;
  }
}

function pickSeriesNameForContext() {
  const sel = $('#bSeries').value;
  if (sel === '__new') return $('#bSeriesNewName').value.trim();
  if (sel) {
    const s = builder.series.find((x) => String(x.id) === String(sel));
    return s?.name || '';
  }
  return '';
}

function renderSuggestChips() {
  const wrap = $('#bSuggestChips');
  wrap.innerHTML = '';
  for (const t of builder.suggestedTitles) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggest-chip';
    chip.textContent = t;
    chip.addEventListener('click', () => {
      $('#bTitle').value = t;
      toast(`제목 적용: ${t}`, 'info', 1500);
    });
    wrap.appendChild(chip);
  }
}

$('#bSuggestBtn').addEventListener('click', () => suggestTitles());
$('#bSuggestRetryBtn').addEventListener('click', () => suggestTitles());

// ─── Series ─────────────────────────────────────────────────────────
async function refreshSeries() {
  try {
    const j = await apiGet('/api/video-series');
    builder.series = j.series || [];
    const cur = $('#bSeries').value;
    const sel = $('#bSeries');
    sel.innerHTML = '<option value="">(시리즈 없음)</option>';
    for (const s of builder.series) {
      const o = document.createElement('option');
      o.value = String(s.id);
      o.textContent = `${s.name} (Vol.${s.current_vol})`;
      sel.appendChild(o);
    }
    const o = document.createElement('option');
    o.value = '__new';
    o.textContent = '+ 새 시리즈로 등록';
    sel.appendChild(o);
    if (cur) sel.value = cur;
    updateSeriesPreview();
  } catch (e) {
    console.warn('series 로드 실패:', e.message);
  }
}

function updateSeriesPreview() {
  const sel = $('#bSeries').value;
  const wrap = $('#bSeriesPreview');
  const newWrap = $('#bSeriesNewWrap');
  if (sel === '__new') {
    newWrap.hidden = false;
    const name = $('#bSeriesNewName').value.trim() || '(이름 입력)';
    wrap.hidden = false;
    wrap.innerHTML = `미리보기: <span class="preview-strong">${escapeHtml(name)} Vol.1</span>`;
  } else if (sel) {
    newWrap.hidden = true;
    const s = builder.series.find((x) => String(x.id) === String(sel));
    if (s) {
      wrap.hidden = false;
      wrap.innerHTML = `미리보기: <span class="preview-strong">${escapeHtml(s.name)} Vol.${s.current_vol + 1}</span>`;
    }
  } else {
    newWrap.hidden = true;
    wrap.hidden = true;
  }
}

$('#bSeries').addEventListener('change', updateSeriesPreview);
$('#bSeriesNewName').addEventListener('input', updateSeriesPreview);

// ─── Templates ──────────────────────────────────────────────────────
async function refreshTemplates() {
  try {
    const j = await apiGet('/api/templates');
    builder.templates = j.templates || [];
    const sel = $('#bTemplate');
    const cur = sel.value;
    sel.innerHTML = '';
    if (!builder.templates.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '(템플릿 없음 — seed-default-template.mjs 실행 필요)';
      sel.appendChild(o);
    } else {
      for (const t of builder.templates) {
        const o = document.createElement('option');
        o.value = String(t.id);
        o.textContent = `${t.name}${t.is_default ? ' ★ default' : ''}`;
        sel.appendChild(o);
      }
      // default 자동 선택
      const def = builder.templates.find((t) => t.is_default);
      if (cur) sel.value = cur;
      else if (def) sel.value = String(def.id);
    }
    updateTemplatePreview();
  } catch (e) {
    console.warn('templates 로드 실패:', e.message);
  }
}

function updateTemplatePreview() {
  const sel = $('#bTemplate').value;
  const t = builder.templates.find((x) => String(x.id) === String(sel));
  const wrap = $('#bTemplatePreview');
  if (!t) { wrap.textContent = ''; return; }
  const desc = t.description ? ` — ${t.description}` : '';
  wrap.innerHTML = `<span class="preview-strong">${escapeHtml(t.name)}</span>${escapeHtml(desc)}`;
}

$('#bTemplate').addEventListener('change', updateTemplatePreview);

// ─── 렌더 준비 완료 ──────────────────────────────────────────────────
$('#bRenderBtn').addEventListener('click', async () => {
  const title = $('#bTitle').value.trim();
  if (!title) {
    toast('영상 제목을 입력하세요', 'error');
    $('#bTitle').focus();
    return;
  }
  if (!builder.tracks.length) {
    toast('트랙이 없습니다. Pool 탭으로 돌아가서 다시 선택하세요', 'error');
    return;
  }
  const templateId = parseInt($('#bTemplate').value, 10) || null;
  const seriesSel = $('#bSeries').value;
  let seriesId = null, registerAsSeries = false, newSeriesName = null;
  if (seriesSel === '__new') {
    newSeriesName = $('#bSeriesNewName').value.trim();
    if (!newSeriesName) {
      toast('새 시리즈 이름을 입력하세요', 'error');
      $('#bSeriesNewName').focus();
      return;
    }
    registerAsSeries = true;
  } else if (seriesSel) {
    seriesId = parseInt(seriesSel, 10);
  }

  // registerAsSeries=true 면 영상 제목과 별개로 시리즈 이름 등록 — 시리즈 이름 우선시
  // server 는 registerAsSeries=true 일 때 영상 title 을 시리즈 이름으로 씀 → 보정:
  // 새 시리즈 이름이 영상 제목과 다르면 먼저 시리즈만 만들고, 그 id 로 진행.
  if (registerAsSeries && newSeriesName !== title) {
    try {
      const sj = await apiPost('/api/video-series', { series_name: newSeriesName });
      seriesId = sj.series.id;
      registerAsSeries = false;
    } catch (e) {
      // 이미 있는 이름이면 fetch 해서 id 회수
      if (/이미 존재/.test(e.message)) {
        const list = await apiGet('/api/video-series');
        const found = (list.series || []).find((s) => s.name === newSeriesName);
        if (found) { seriesId = found.id; registerAsSeries = false; }
        else { toast(`시리즈 등록 실패: ${e.message}`, 'error'); return; }
      } else {
        toast(`시리즈 등록 실패: ${e.message}`, 'error'); return;
      }
    }
  }

  const ordered = getOrderedTracksForRender();
  const trackIds = ordered.map((t) => t.id);

  builder.rendering = true;
  $('#bRenderBtn').disabled = true;
  $('#bRenderBtn').textContent = '🎬 처리 중…';

  try {
    const j = await apiPost('/api/videos', {
      title,
      trackIds,
      templateId,
      seriesId,
      registerAsSeries,
    });
    toast(`영상 프로젝트 생성됨 (build_id: ${j.buildId})`, 'success', 6000);
    console.log('[builder] video created:', j);

    // sessionStorage 클리어
    sessionStorage.removeItem(BUILDER_SS_KEY);

    // 안내 메시지
    setTimeout(() => {
      alert(
        `✅ 영상 프로젝트 생성 완료\n\n` +
        `Build ID: ${j.buildId}\n` +
        `Video ID: ${j.videoId}\n` +
        `Title: ${j.title}\n` +
        `Tracks: ${j.trackCount}곡 / ${fmtMinSec(j.totalDurationSec)}\n` +
        `Template: ${j.templateName}\n` +
        (j.seriesName ? `Series: ${j.seriesName} Vol.${j.volume}\n` : '') +
        `\n🎬 다음 단계: Phase 4-D 의 렌더 파이프라인이 완성되면 자동으로 영상 export 됩니다.\n` +
        `현재는 video/public/jazz-playlist.json 에 데이터가 기록되었으며,\n` +
        `cd video && npx remotion studio 로 미리보기 가능합니다.`
      );
    }, 100);

    // 상태 리셋
    builder.tracks = [];
    builder.suggestedTitles = [];
    $('#bTitle').value = '';
    $('#bSuggestChips').innerHTML = '';
    $('#bSuggestRetryBtn').hidden = true;
    $('#bSeries').value = '';
    $('#bSeriesNewName').value = '';
    updateSeriesPreview();
    $('#builderEmpty').hidden = false;
    $('#builderMain').hidden = true;
    refreshStats();
    refreshSeries();
  } catch (e) {
    toast(`영상 생성 실패: ${e.message}`, 'error', 6000);
  } finally {
    builder.rendering = false;
    $('#bRenderBtn').disabled = false;
    $('#bRenderBtn').textContent = '🎬 렌더 준비 완료';
  }
});

// Studio 로 이동 (Phase 4-D-2) — DB 에 영상 프로젝트 생성 + 곡별 signed URL + template config 를
//                                  sessionStorage 에 적재 → switchTab('studio')
$('#bStudioBtn')?.addEventListener('click', async () => {
  if (!builder.tracks.length) {
    toast('트랙이 없습니다. Pool 탭으로 돌아가서 다시 선택하세요', 'error');
    return;
  }
  const templateId = parseInt($('#bTemplate').value, 10) || null;
  if (!templateId) {
    toast('템플릿을 선택하세요', 'error');
    return;
  }

  const ordered = getOrderedTracksForRender();
  const trackIds = ordered.map((t) => t.id);

  // 자동 제목 — UI 가 hidden 이므로 timestamp 기반
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const autoTitle = `Untitled — ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  builder.rendering = true;
  $('#bStudioBtn').disabled = true;
  $('#bStudioBtn').textContent = '🎬 처리 중…';

  try {
    // 1) 영상 프로젝트 생성 (DB)
    const j = await apiPost('/api/videos', {
      title: autoTitle,
      trackIds,
      templateId,
      seriesId: null,
      registerAsSeries: false,
    });

    // 2) 각 곡의 signed audio URL 발급
    const urlMap = new Map();
    for (const t of ordered) {
      try {
        const ar = await fetch(`/api/tracks/${t.id}/audio-url`);
        const aj = await ar.json();
        if (ar.ok && aj.ok) urlMap.set(t.id, aj.url);
      } catch (e) {
        console.warn(`[builder] audio-url fetch 실패 (track ${t.id}):`, e.message);
      }
    }

    // 3) 템플릿 config 회수
    let templateRow = null;
    try {
      const tr = await apiGet(`/api/templates/${templateId}`);
      templateRow = tr.template || null;
    } catch (e) {
      console.warn(`[builder] template 회수 실패:`, e.message);
    }

    // 4) Studio 세션 데이터 구성
    let cursor = 0;
    const studioTracks = ordered.map((t) => {
      const dur = Number(t.duration_actual_sec) || Number(t.duration_raw_sec) || 180;
      const startSec = cursor;
      const endSec = startSec + dur;
      cursor = endSec;
      return {
        id: t.id,
        title: t.title?.title_en || t.original_filename?.replace(/\.[^/.]+$/, '') || `Track ${t.id}`,
        audioUrl: urlMap.get(t.id) || null,
        durationSec: dur,
        startSec,
        endSec,
      };
    });

    const session = {
      buildId: j.buildId,
      videoId: j.videoId,
      title: j.title,
      template: templateRow,
      tracks: studioTracks,
      totalDurationSec: cursor,
      createdAt: Date.now(),
    };

    sessionStorage.setItem('pjl.studio.session', JSON.stringify(session));
    sessionStorage.removeItem(BUILDER_SS_KEY);

    toast(`Studio 진입 (${studioTracks.length}곡 / ${fmtMinSec(cursor)})`, 'success', 3000);

    // 상태 리셋
    builder.tracks = [];
    $('#builderEmpty').hidden = false;
    $('#builderMain').hidden = true;
    refreshStats();

    // Studio 로 전환
    switchTab('studio');
  } catch (e) {
    toast(`Studio 진입 실패: ${e.message}`, 'error', 6000);
  } finally {
    builder.rendering = false;
    $('#bStudioBtn').disabled = false;
    $('#bStudioBtn').textContent = '🎬 Studio 로 이동';
  }
});

$('#bResetBtn').addEventListener('click', () => {
  if (!confirm('Builder 작업을 모두 초기화합니다. 계속?')) return;
  sessionStorage.removeItem(BUILDER_SS_KEY);
  builder.tracks = [];
  builder.suggestedTitles = [];
  $('#bTitle').value = '';
  $('#bSuggestChips').innerHTML = '';
  $('#bSuggestRetryBtn').hidden = true;
  $('#bSeries').value = '';
  $('#bSeriesNewName').value = '';
  updateSeriesPreview();
  $('#builderEmpty').hidden = false;
  $('#builderMain').hidden = true;
});

// ─── Builder onEnter (탭 전환 시) ────────────────────────────────────
window.builderOnEnter = async function builderOnEnter() {
  await Promise.all([refreshTemplates(), refreshSeries()]);

  const raw = sessionStorage.getItem(BUILDER_SS_KEY);
  if (!raw) {
    $('#builderEmpty').hidden = false;
    $('#builderMain').hidden = true;
    return;
  }

  let ids;
  try { ids = JSON.parse(raw); } catch { ids = []; }
  if (!Array.isArray(ids) || !ids.length) {
    $('#builderEmpty').hidden = false;
    $('#builderMain').hidden = true;
    return;
  }

  // GET /api/tracks?ids=... 로 곡 정보 조회
  try {
    const j = await apiGet(`/api/tracks?ids=${ids.join(',')}&limit=500`);
    const fetched = j.tracks || [];
    // 요청한 id 순서를 유지하기 위해 재정렬
    const map = new Map(fetched.map((t) => [t.id, t]));
    const orderedFromIds = ids.map((id) => map.get(id)).filter(Boolean);
    // 핀 적용 — prefix_order 1~5 트랙은 그 슬롯에 고정 배치
    builder.unpinAll = $('#bUnpinAll').checked;
    builder.tracks = arrangeTracksWithPins(orderedFromIds);
    if (!builder.tracks.length) {
      toast('선택했던 곡이 모두 사라졌습니다 (삭제됨?)', 'error');
      $('#builderEmpty').hidden = false;
      $('#builderMain').hidden = true;
      return;
    }
    $('#builderEmpty').hidden = true;
    $('#builderMain').hidden = false;
    renderBuilderTracks();
  } catch (e) {
    toast(`Builder 트랙 로드 실패: ${e.message}`, 'error');
    $('#builderEmpty').hidden = false;
    $('#builderMain').hidden = true;
  }
};

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
