// Premium Jazz Lounge — Uploader (Phase 5-A)
// YouTube OAuth + 최근 영상 50개 + 재생목록 표시.
//
// 의존: 백엔드 /auth/youtube, /api/youtube/status|videos|playlists.

const $ = (s) => document.querySelector(s);
const TOTAL_LANGS = 16;

const uploader = {
  initialized: false,
  authPollTimer: null,
  videos: [],                  // 마지막 fetch 결과 (메타 패널 lookup 용)
  acDebounceTimer: null,
  acResults: [],
};

// Phase 5-B: 메타 패널이 다음 단계 (Phase 5-C/D) 에 넘겨주는 상태.
window.uploaderState = window.uploaderState || {
  selectedVideo: null,         // { id, title, thumbnail }
  sourceVideoId: null,         // 매칭된 영상 (DB 의 video_id, 예: 'vid_2026-...')
  tracks: [],                  // [{ position, track_id, title, length_sec, start_sec, timecode }]
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDateLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// ─── 인증 상태 확인 + 카드 토글 ───────────────────────────────────
async function checkAuth() {
  let data = null;
  try {
    const r = await fetch('/api/youtube/status');
    data = await r.json();
  } catch (e) {
    data = { ok: false, configured: false, authenticated: false, error: e.message };
  }
  const authCard = $('#uploaderAuthCard');
  const mainCard = $('#uploaderMainCard');
  const status = $('#uploaderAuthStatus');

  if (!data?.configured) {
    authCard.hidden = false;
    mainCard.hidden = true;
    if (status) status.textContent = '⚠ .env.local 에 YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET 미설정';
    return;
  }

  if (!data.authenticated) {
    authCard.hidden = false;
    mainCard.hidden = true;
    if (status) status.textContent = '미인증 — "YouTube 로그인" 클릭';
    return;
  }

  // 인증됨
  authCard.hidden = true;
  mainCard.hidden = false;
  if (status) status.textContent = '';
  await Promise.all([loadVideos(), loadPlaylists()]);
}

// ─── 인증 시작 (새 창) ───────────────────────────────────────────
function startAuthFlow() {
  const w = window.open('/auth/youtube', 'pjl_yt_auth', 'width=600,height=720');
  if (!w) {
    alert('팝업이 차단되었습니다. 브라우저 팝업 허용 후 다시 시도해주세요.');
    return;
  }
  // 창 닫히면 상태 재확인
  if (uploader.authPollTimer) clearInterval(uploader.authPollTimer);
  uploader.authPollTimer = setInterval(() => {
    if (w.closed) {
      clearInterval(uploader.authPollTimer);
      uploader.authPollTimer = null;
      checkAuth();
    }
  }, 800);
}

// ─── 영상 list ───────────────────────────────────────────────────
async function loadVideos() {
  const list = $('#uploaderVideoList');
  const countEl = $('#uploaderVideoCount');
  list.innerHTML = '<div class="video-grid-empty">영상 로딩 중…</div>';
  if (countEl) countEl.textContent = '';

  let j;
  try {
    const r = await fetch('/api/youtube/videos');
    j = await r.json();
    if (!j.ok) {
      if (j.authUrl) {
        // 토큰 만료 / 사라짐 → 인증 화면으로
        await checkAuth();
        return;
      }
      throw new Error(j.error || `HTTP ${r.status}`);
    }
  } catch (e) {
    list.innerHTML = `<div class="video-grid-empty" style="color:#f55;">로드 실패: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (countEl) countEl.textContent = `(${j.count}개)`;
  uploader.videos = j.videos || [];
  if (!j.videos.length) {
    list.innerHTML = '<div class="video-grid-empty">아직 업로드된 영상이 없습니다.</div>';
    return;
  }
  list.innerHTML = j.videos.map(renderVideoCard).join('');
}

function statusBadge(v) {
  const isScheduled = v.privacyStatus === 'private' && v.publishAt;
  if (isScheduled) {
    return `<span class="vc-badge scheduled" title="${escapeHtml(fmtDateTime(v.publishAt))} 공개 예정">📅 예약</span>`;
  }
  if (v.privacyStatus === 'public')   return `<span class="vc-badge public">공개</span>`;
  if (v.privacyStatus === 'unlisted') return `<span class="vc-badge unlisted">일부 공개</span>`;
  return `<span class="vc-badge private">비공개</span>`;
}

function locBadge(v) {
  const n = v.localizationCount || 0;
  const cls = n >= TOTAL_LANGS ? 'vc-loc-full' : n > 0 ? 'vc-loc-partial' : 'vc-loc-none';
  return `<span class="${cls}" title="번역된 언어 / 16">🌐 ${n}/${TOTAL_LANGS}</span>`;
}

function renderVideoCard(v) {
  const thumb = v.thumbnail
    ? `<img class="vc-thumb" src="${escapeHtml(v.thumbnail)}" loading="lazy" alt="">`
    : `<div class="vc-thumb-ph">no thumbnail</div>`;
  const dateStr = v.publishAt
    ? `예약: ${fmtDateTime(v.publishAt)}`
    : `업로드: ${fmtDateLocal(v.publishedAt)}`;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
  // Phase 5-B: 카드 본문 클릭 → 메타 패널. ↗ 링크는 stopPropagation 으로 YouTube 새 탭.
  return `
    <div class="video-card" data-video-id="${escapeHtml(v.id)}" title="클릭 → 메타 적용 패널" style="cursor:pointer;">
      ${thumb}
      <div class="vc-title">${escapeHtml(v.title)}</div>
      <div class="vc-meta">
        <span title="조회수">👁 ${(v.viewCount || 0).toLocaleString()}</span>
        ${locBadge(v)}
        <span class="spacer"></span>
        ${statusBadge(v)}
        <a href="${url}" target="_blank" rel="noopener" title="YouTube 에서 열기"
           style="text-decoration:none;color:var(--text-muted);padding:0 4px;"
           onclick="event.stopPropagation();">↗</a>
      </div>
      <div class="vc-date">${dateStr}</div>
    </div>
  `;
}

// ─── 재생목록 list ──────────────────────────────────────────────
async function loadPlaylists() {
  const list = $('#uploaderPlaylistList');
  const countEl = $('#uploaderPlaylistCount');
  list.innerHTML = '<div class="video-grid-empty">재생목록 로딩 중…</div>';
  if (countEl) countEl.textContent = '';

  let j;
  try {
    const r = await fetch('/api/youtube/playlists');
    j = await r.json();
    if (!j.ok) {
      if (j.authUrl) { await checkAuth(); return; }
      throw new Error(j.error || `HTTP ${r.status}`);
    }
  } catch (e) {
    list.innerHTML = `<div class="video-grid-empty" style="color:#f55;">로드 실패: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (countEl) countEl.textContent = `(${j.count}개)`;
  if (!j.playlists.length) {
    list.innerHTML = '<div class="video-grid-empty">아직 재생목록이 없습니다.</div>';
    return;
  }
  list.innerHTML = j.playlists.map(renderPlaylistCard).join('');
}

function renderPlaylistCard(p) {
  const thumb = p.thumbnail
    ? `<img class="vc-thumb" src="${escapeHtml(p.thumbnail)}" loading="lazy" alt="">`
    : `<div class="vc-thumb-ph">no thumbnail</div>`;
  const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(p.id)}`;
  return `
    <a class="video-card" href="${url}" target="_blank" rel="noopener" data-playlist-id="${escapeHtml(p.id)}" style="text-decoration:none;color:inherit;">
      ${thumb}
      <div class="vc-title">${escapeHtml(p.title)}</div>
      <div class="vc-meta">
        <span>🎬 ${p.itemCount}개</span>
        <span class="spacer"></span>
        <span class="vc-badge ${p.privacyStatus === 'public' ? 'public' : 'private'}">${escapeHtml(p.privacyStatus || '—')}</span>
      </div>
    </a>
  `;
}

// ─── Bind controls (한 번만) ────────────────────────────────────
function bindOnce() {
  if (uploader.initialized) return;
  $('#uploaderAuthBtn')?.addEventListener('click', startAuthFlow);
  $('#uploaderRefreshBtn')?.addEventListener('click', () => loadVideos());
  $('#uploaderRefreshPlaylistsBtn')?.addEventListener('click', () => loadPlaylists());

  // Phase 5-B: 영상 카드 클릭 → 메타 적용 패널. 위임 이벤트 — 리스트가 다시 그려져도 작동.
  $('#uploaderVideoList')?.addEventListener('click', (ev) => {
    if (ev.target.closest('a')) return;          // ↗ 링크는 그대로 진행
    const card = ev.target.closest('.video-card');
    if (!card) return;
    const id = card.dataset.videoId;
    const video = uploader.videos.find((v) => v.id === id);
    if (video) showMetaPanel(video);
  });

  uploader.initialized = true;
}

// ────────────────────────────────────────────────────────────────
// Phase 5-B: 메타 적용 패널 (slide-in)
// ────────────────────────────────────────────────────────────────
function ensureMetaPanel() {
  let panel = document.getElementById('uploaderMetaPanel');
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'uploaderMetaPanel';
  panel.style.cssText = [
    'position:fixed;top:0;right:0;height:100vh;',
    'width:min(560px,55vw);',
    'background:#0a0a0a;border-left:1px solid #2a2a2a;',
    'overflow-y:auto;padding:20px 24px;z-index:1000;',
    'box-shadow:-8px 0 24px rgba(0,0,0,0.6);',
    'display:none;color:var(--text);',
  ].join('');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;color:var(--jazz-gold);font-size:16px;">📤 메타 적용</h2>
      <button id="metaPanelClose" type="button"
        style="background:transparent;border:none;color:var(--text-muted);font-size:22px;cursor:pointer;line-height:1;padding:0 6px;">×</button>
    </div>

    <div id="metaVideoCard"
      style="margin-bottom:20px;padding:10px;background:#161616;border:1px solid #2a2a2a;border-radius:8px;">
      <img id="metaVideoThumbnail"
        style="width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:4px;margin-bottom:8px;background:#000;">
      <div id="metaVideoTitle" style="color:var(--text);font-size:13px;line-height:1.35;"></div>
      <div id="metaVideoBadges" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);"></div>
    </div>

    <div style="margin-bottom:20px;position:relative;">
      <label style="display:block;color:var(--jazz-gold);margin-bottom:6px;font-size:12px;font-weight:600;">
        첫 곡 제목 입력 (자동완성)
      </label>
      <input id="metaFirstTrackInput" type="text" autocomplete="off" spellcheck="false"
        placeholder="예: Showa Sunny..."
        style="width:100%;padding:9px 10px;background:#161616;color:var(--text);border:1px solid #2a2a2a;border-radius:4px;font-size:13px;">
      <div id="metaAutocomplete"
        style="position:absolute;left:0;right:0;top:calc(100% + 4px);background:#161616;border:1px solid #2a2a2a;border-radius:4px;max-height:280px;overflow-y:auto;display:none;z-index:1;"></div>
    </div>

    <div id="metaMatchInfo" style="display:none;margin-bottom:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="color:var(--text-muted);font-size:11px;">📅 <span id="metaMatchDate"></span></span>
        <button id="metaUseTracksBtn" type="button" class="te-btn gold" style="padding:6px 12px;font-size:12px;">이 곡들 사용</button>
      </div>
      <div id="metaTrackList" style="background:#0e0e0e;border:1px solid #2a2a2a;border-radius:6px;"></div>
    </div>

    <div id="metaNextStep" style="display:none;margin-top:24px;padding-top:16px;border-top:1px solid #2a2a2a;">
      <div style="color:var(--text-muted);font-size:12px;text-align:center;">
        ✓ 곡 확정 — 다음 단계 (Phase 5-C/D) 에서 메타 자동 생성 진행
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // close
  panel.querySelector('#metaPanelClose').addEventListener('click', () => {
    panel.style.display = 'none';
  });

  // ESC 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.style.display === 'block') {
      panel.style.display = 'none';
    }
  });

  // 자동완성
  bindAutocomplete(panel);

  return panel;
}

function showMetaPanel(video) {
  const panel = ensureMetaPanel();
  panel.dataset.videoId = video.id;
  panel.style.display = 'block';

  const thumb = panel.querySelector('#metaVideoThumbnail');
  if (video.thumbnail) {
    thumb.src = video.thumbnail;
    thumb.style.display = 'block';
  } else {
    thumb.removeAttribute('src');
    thumb.style.display = 'none';
  }
  panel.querySelector('#metaVideoTitle').textContent = video.title || '';
  panel.querySelector('#metaVideoBadges').innerHTML = `
    <span title="조회수">👁 ${(video.viewCount || 0).toLocaleString()}</span>
    <span>🌐 ${video.localizationCount || 0}/${TOTAL_LANGS}</span>
    <span style="margin-left:auto;">${stripBadgeMarkup(statusBadge(video))}</span>
  `;

  // 입력 / 매칭 초기화
  panel.querySelector('#metaFirstTrackInput').value = '';
  panel.querySelector('#metaAutocomplete').style.display = 'none';
  panel.querySelector('#metaAutocomplete').innerHTML = '';
  panel.querySelector('#metaMatchInfo').style.display = 'none';
  panel.querySelector('#metaTrackList').innerHTML = '';
  panel.querySelector('#metaNextStep').style.display = 'none';

  // 입력창 focus
  setTimeout(() => panel.querySelector('#metaFirstTrackInput').focus(), 50);

  // 다음 단계 핸드오프 정보의 일부 — 곡 확정 시점에 selectedVideo 채움.
  uploader._pendingVideo = {
    id: video.id,
    title: video.title,
    thumbnail: video.thumbnail || null,
  };
}

// statusBadge() 가 HTML 문자열 반환 — innerHTML 에 그대로 넣기 위해 식별자만.
function stripBadgeMarkup(html) { return html; }

// ─── 자동완성 ──────────────────────────────────────────────────
function bindAutocomplete(panel) {
  const input = panel.querySelector('#metaFirstTrackInput');
  const list = panel.querySelector('#metaAutocomplete');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q.length < 1) {
      list.style.display = 'none';
      return;
    }
    clearTimeout(uploader.acDebounceTimer);
    uploader.acDebounceTimer = setTimeout(() => fetchAutocomplete(q), 200);
  });

  // 외부 클릭 → 닫기
  document.addEventListener('click', (e) => {
    if (panel.style.display !== 'block') return;
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.style.display = 'none';
    }
  });

  // 위임 클릭 — autocomplete item
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.ac-item');
    if (!item) return;
    const trackId = parseInt(item.dataset.trackId, 10);
    if (Number.isFinite(trackId)) selectTrack(trackId);
  });
}

async function fetchAutocomplete(q) {
  const list = document.getElementById('metaAutocomplete');
  if (!list) return;
  try {
    const r = await fetch(`/api/tracks/autocomplete?q=${encodeURIComponent(q)}&limit=5`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    uploader.acResults = data.results || [];
    renderAutocomplete(uploader.acResults);
  } catch (e) {
    list.innerHTML = `<div style="padding:10px 12px;color:#f55;font-size:12px;">자동완성 실패: ${escapeHtml(e.message)}</div>`;
    list.style.display = 'block';
  }
}

function renderAutocomplete(results) {
  const list = document.getElementById('metaAutocomplete');
  if (!list) return;
  if (!results.length) {
    list.innerHTML = `<div style="padding:10px 12px;color:var(--text-muted);font-size:12px;">사용된 적 있는 곡 중 일치하는 게 없습니다.</div>`;
    list.style.display = 'block';
    return;
  }
  list.innerHTML = results.map((t) => `
    <div class="ac-item" data-track-id="${t.id}"
      style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #1f1f1f;"
      onmouseover="this.style.background='#1d1d1d'"
      onmouseout="this.style.background='transparent'">
      <div style="color:var(--text);font-size:13px;">${escapeHtml(t.title)}</div>
      <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">
        ${t.used_count}회 사용 · 최근: ${escapeHtml(formatLastUsedLocal(t.last_used_at))}
      </div>
    </div>
  `).join('');
  list.style.display = 'block';
}

// uploader.js 는 module — app.js 의 formatLastUsed 접근 X. 로컬에 동일 로직.
function formatLastUsedLocal(iso) {
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

// ─── 곡 선택 → 매칭 영상 fetch ─────────────────────────────────
async function selectTrack(trackId) {
  const input = document.getElementById('metaFirstTrackInput');
  const ac = document.getElementById('metaAutocomplete');
  const found = uploader.acResults.find((t) => t.id === trackId);
  if (found && input) input.value = found.title;
  if (ac) ac.style.display = 'none';

  let data;
  try {
    const r = await fetch(`/api/tracks/${trackId}/last-video`);
    data = await r.json();
  } catch (e) {
    alert(`매칭 fetch 실패: ${e.message}`);
    return;
  }

  if (!data.ok) {
    if (data.fallback === 'manual') {
      // 사용 이력 없음 — Phase 5-B-2 에서 수동 14곡 선택 모드 추가 예정.
      alert('이 곡은 아직 영상에 사용된 적 없습니다.\n수동 곡 선택 모드는 다음 단계에서 추가됩니다.');
      return;
    }
    alert(`매칭 실패: ${data.error || 'unknown'}`);
    return;
  }
  renderMatchedTracks(data);
}

function renderMatchedTracks(matchData) {
  const matchInfo = document.getElementById('metaMatchInfo');
  const trackList = document.getElementById('metaTrackList');
  const matchDate = document.getElementById('metaMatchDate');

  matchDate.textContent = `${fmtDateLocal(matchData.used_at)} 사용 · 영상 ID ${matchData.video_id} · ${matchData.track_count}곡`;

  trackList.innerHTML = matchData.tracks.map((t, i) => `
    <div style="display:flex;gap:12px;padding:8px 12px;border-bottom:1px solid #1f1f1f;font-size:13px;align-items:baseline;">
      <span style="color:var(--text-muted);font-family:ui-monospace,Menlo,monospace;min-width:24px;text-align:right;">${t.position || i + 1}.</span>
      <span style="color:var(--jazz-gold);font-family:ui-monospace,Menlo,monospace;min-width:54px;">${escapeHtml(t.timecode)}</span>
      <span style="color:var(--text);flex:1;">${escapeHtml(t.title)}</span>
      <span style="color:var(--text-muted);font-size:11px;font-family:ui-monospace,Menlo,monospace;">${formatTrackLength(t.length_sec)}</span>
    </div>
  `).join('');

  matchInfo.style.display = 'block';

  // "이 곡들 사용" 클릭 → window.uploaderState 채움
  const useBtn = document.getElementById('metaUseTracksBtn');
  if (useBtn) {
    useBtn.onclick = () => confirmTracks(matchData);
  }
}

function confirmTracks(matchData) {
  const pending = uploader._pendingVideo || null;
  window.uploaderState = {
    selectedVideo: pending,
    sourceVideoId: matchData.video_id,
    tracks: matchData.tracks,
  };
  console.log('[Uploader] 곡 확정:', window.uploaderState);
  document.getElementById('metaNextStep').style.display = 'block';
  alert(`✓ 곡 ${matchData.track_count}개 확정.\n\n다음 단계 (Phase 5-C/D) 에서 메타 자동 생성 진행.`);
}

function formatTrackLength(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 탭 진입 시 호출되는 hook (app.js 의 switchTab 에서 부름)
window.uploaderOnEnter = function uploaderOnEnter() {
  bindOnce();
  checkAuth();
};
