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

// Phase 5-B/5-C: 메타 패널이 다음 단계 (5-D ~ 5-F) 에 넘겨주는 상태.
window.uploaderState = window.uploaderState || {
  selectedVideo: null,         // { id, title, thumbnail } — 적용 대상 영상
  sourceVideoId: null,         // 매칭된 영상 (DB 의 video_id, 예: 'vid_2026-...')
  tracks: [],                  // [{ position, track_id, title, length_sec, start_sec, timecode }]
  // === Phase 5-C ===
  path: null,                  // 'A' | 'B' (사용자 선택)
  reuseSourceVideo: null,      // Path A 의 재사용 source 영상 (sourceMeta)
  generatedMeta: null,         // 자동 생성된 메타 (title.default / description.default / localizations / tags / missingLanguages)
  missingLanguages: [],        // 재사용 source 에 빠진 언어 코드 배열
};

// Phase 5-C: Path A workflow 의 ephemeral 상태 (한 번에 하나의 패널만 살아있음).
let pathASelectedSourceVideoId = null;
let pathACurrentLangTab = 'en';

const PATH_A_LANGUAGES = [
  'en', 'ko', 'ja', 'zh', 'zh-Hant',
  'es', 'fr', 'de', 'it', 'pt',
  'ru', 'nl', 'th', 'vi', 'id', 'ms', 'tl',
];

const LANG_LABELS = {
  'en': 'English', 'ko': '한국어', 'ja': '日本語',
  'zh': '中文 (简体)', 'zh-Hant': '中文 (繁體)',
  'es': 'Español', 'fr': 'Français', 'de': 'Deutsch',
  'it': 'Italiano', 'pt': 'Português', 'ru': 'Русский',
  'nl': 'Nederlands', 'th': 'ไทย', 'vi': 'Tiếng Việt',
  'id': 'Bahasa Indonesia', 'ms': 'Bahasa Melayu', 'tl': 'Filipino',
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
  $('#uploaderSettingsBtn')?.addEventListener('click', openSettingsModal);

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
// Phase 5-F: 설정 (localStorage) — default 재생목록 + 자동 예약
// ────────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'pjl.uploader.settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { defaultPlaylists: [], autoSchedule: true };
    const s = JSON.parse(raw);
    return {
      defaultPlaylists: Array.isArray(s.defaultPlaylists) ? s.defaultPlaylists : [],
      autoSchedule: s.autoSchedule !== false,
    };
  } catch (e) {
    return { defaultPlaylists: [], autoSchedule: true };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function ensureSettingsModal() {
  let modal = document.getElementById('uploaderSettingsModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'uploaderSettingsModal';
  modal.style.cssText = [
    'position:fixed;inset:0;background:rgba(0,0,0,0.7);',
    'z-index:1100;display:none;align-items:flex-start;justify-content:center;',
    'padding-top:60px;',
  ].join('');
  modal.innerHTML = `
    <div style="background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;width:min(560px,90vw);max-height:80vh;overflow-y:auto;padding:24px;color:var(--text);box-shadow:0 12px 48px rgba(0,0,0,0.8);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h3 style="margin:0;color:var(--jazz-gold);font-size:15px;">⚙️ Uploader 설정</h3>
        <button id="settingsCloseBtn" type="button" style="background:transparent;border:none;color:var(--text-muted);font-size:22px;cursor:pointer;line-height:1;padding:0 6px;">×</button>
      </div>

      <div style="margin-bottom:24px;">
        <h4 style="color:var(--jazz-gold);margin:0 0 8px;font-size:12px;font-weight:600;">Default 재생목록 (자동 추가)</h4>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">선택한 재생목록에 적용 시 자동으로 영상 추가.</div>
        <div id="defaultPlaylistList" style="max-height:340px;overflow-y:auto;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:6px;">
          <div style="padding:14px;color:var(--text-muted);font-size:12px;">로딩 중…</div>
        </div>
      </div>

      <div style="margin-bottom:24px;">
        <h4 style="color:var(--jazz-gold);margin:0 0 8px;font-size:12px;font-weight:600;">예약 시간</h4>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text);cursor:pointer;">
          <input type="checkbox" id="enableAutoSchedule">
          자동 예약 (다음 월/목 16:30 SGT 슬롯)
        </label>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="settingsCancelBtn" type="button" class="te-btn" style="padding:8px 16px;">취소</button>
        <button id="settingsSaveBtn" type="button" class="te-btn gold" style="padding:8px 16px;">저장</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#settingsCloseBtn').addEventListener('click', () => closeSettingsModal());
  modal.querySelector('#settingsCancelBtn').addEventListener('click', () => closeSettingsModal());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeSettingsModal();
  });
  modal.querySelector('#settingsSaveBtn').addEventListener('click', () => {
    const checked = Array.from(
      modal.querySelectorAll('#defaultPlaylistList input[type="checkbox"]:checked')
    ).map((cb) => cb.value);
    const settings = {
      defaultPlaylists: checked,
      autoSchedule: modal.querySelector('#enableAutoSchedule').checked,
    };
    saveSettings(settings);
    closeSettingsModal();
  });

  return modal;
}

function closeSettingsModal() {
  const modal = document.getElementById('uploaderSettingsModal');
  if (modal) modal.style.display = 'none';
}

async function openSettingsModal() {
  const modal = ensureSettingsModal();
  const settings = loadSettings();
  modal.querySelector('#enableAutoSchedule').checked = !!settings.autoSchedule;
  modal.style.display = 'flex';

  // 재생목록 fetch
  const list = modal.querySelector('#defaultPlaylistList');
  list.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:12px;">로딩 중…</div>';
  try {
    const r = await fetch('/api/youtube/playlists');
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (!data.playlists.length) {
      list.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:12px;">재생목록이 없습니다.</div>';
      return;
    }
    list.innerHTML = data.playlists.map((p) => {
      const checked = settings.defaultPlaylists.includes(p.id) ? 'checked' : '';
      const thumb = p.thumbnail
        ? `<img src="${escapeHtml(p.thumbnail)}" style="width:60px;aspect-ratio:16/9;object-fit:cover;border-radius:4px;background:#000;">`
        : `<div style="width:60px;aspect-ratio:16/9;background:#222;border-radius:4px;"></div>`;
      return `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #1a1a1a;cursor:pointer;">
          <input type="checkbox" value="${escapeHtml(p.id)}" ${checked} style="flex:0 0 auto;">
          ${thumb}
          <div style="flex:1;min-width:0;">
            <div style="color:var(--text);font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.title)}</div>
            <div style="color:var(--text-muted);font-size:10px;margin-top:2px;">${p.itemCount} 개 영상</div>
          </div>
        </label>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div style="padding:14px;color:#f55;font-size:12px;">로드 실패: ${escapeHtml(e.message)}</div>`;
  }
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
  Object.assign(window.uploaderState, {
    selectedVideo: pending,
    sourceVideoId: matchData.video_id,
    tracks: matchData.tracks,
    path: null,
    reuseSourceVideo: null,
    generatedMeta: null,
    missingLanguages: [],
  });
  console.log('[Uploader] 곡 확정:', window.uploaderState);
  renderPathSelector();
}

// ────────────────────────────────────────────────────────────────
// Phase 5-C: Path A — 기존 영상 메타 재사용 + Vol +1
// ────────────────────────────────────────────────────────────────
function renderPathSelector() {
  const container = document.getElementById('metaNextStep');
  if (!container) return;
  container.style.display = 'block';
  container.innerHTML = `
    <h3 style="color:var(--jazz-gold);margin:0 0 12px;font-size:13px;font-weight:600;">메타데이터 적용 방식</h3>
    <div style="display:flex;gap:10px;">
      <button id="pathABtn" type="button" class="te-btn gold" style="flex:1;padding:14px;text-align:left;cursor:pointer;">
        <div style="font-size:13px;font-weight:700;">📋 Path A: 기존 영상 재사용</div>
        <div style="font-size:11px;color:rgba(0,0,0,0.7);margin-top:4px;font-weight:500;">시리즈 영상 (Vol.X+1) — Vol 숫자만 교체</div>
      </button>
      <button id="pathBBtn" type="button" class="te-btn" style="flex:1;padding:14px;text-align:left;cursor:pointer;">
        <div style="font-size:13px;font-weight:600;">✨ Path B: 새 메타 생성</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">새 테마 (Vol.1) — Gemini 새로 생성</div>
      </button>
    </div>
  `;

  document.getElementById('pathABtn').addEventListener('click', () => {
    window.uploaderState.path = 'A';
    showPathASourceSelect();
  });
  document.getElementById('pathBBtn').addEventListener('click', () => {
    alert('Path B (새 메타 생성) 는 Phase 5-D 에서 구현 예정입니다.');
  });
}

// === Path A — 재사용 source 영상 선택 화면 ===
function showPathASourceSelect() {
  const container = document.getElementById('metaNextStep');
  if (!container) return;
  pathASelectedSourceVideoId = null;

  container.innerHTML = `
    <h3 style="color:var(--jazz-gold);margin:0 0 12px;font-size:13px;font-weight:600;">재사용할 영상 선택</h3>
    <div style="margin-bottom:10px;">
      <input type="text" id="pathASearch" placeholder="제목 검색 (예: Showa Vol.5)"
        autocomplete="off" spellcheck="false"
        style="width:100%;padding:9px 10px;background:#161616;color:var(--text);border:1px solid #2a2a2a;border-radius:4px;font-size:12px;">
    </div>
    <div id="pathASourceList" style="max-height:380px;overflow-y:auto;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:6px;"></div>
    <div style="display:flex;gap:8px;margin-top:14px;">
      <button id="pathACancelBtn" type="button" class="te-btn" style="flex:0 0 auto;padding:8px 16px;">← 뒤로</button>
      <button id="pathAApplyBtn" type="button" class="te-btn gold" style="flex:1;padding:8px 16px;" disabled>적용</button>
    </div>
  `;

  loadPathASourceList();

  document.getElementById('pathASearch').addEventListener('input', filterPathASource);
  document.getElementById('pathACancelBtn').addEventListener('click', () => renderPathSelector());
  document.getElementById('pathAApplyBtn').addEventListener('click', applyPathA);
}

function loadPathASourceList() {
  const videos = uploader.videos || [];
  const excludedId = window.uploaderState.selectedVideo?.id || null;
  const list = videos.filter((v) => v.id !== excludedId);
  renderPathASourceList(list);
}

function renderPathASourceList(videos) {
  const container = document.getElementById('pathASourceList');
  if (!container) return;
  if (!videos.length) {
    container.innerHTML = `<div style="padding:14px;color:var(--text-muted);font-size:12px;text-align:center;">재사용 가능한 영상이 없습니다.</div>`;
    return;
  }
  container.innerHTML = videos.map((v) => {
    const dateStr = fmtDateLocal(v.publishedAt);
    const thumb = v.thumbnail
      ? `<img src="${escapeHtml(v.thumbnail)}" loading="lazy" alt="" style="width:80px;aspect-ratio:16/9;object-fit:cover;border-radius:4px;background:#000;flex:0 0 auto;">`
      : `<div style="width:80px;aspect-ratio:16/9;background:#000;border-radius:4px;flex:0 0 auto;"></div>`;
    return `
      <div class="path-a-source-item" data-video-id="${escapeHtml(v.id)}"
        style="display:flex;gap:10px;padding:8px 10px;border-bottom:1px solid #1f1f1f;cursor:pointer;align-items:flex-start;">
        ${thumb}
        <div style="flex:1;min-width:0;">
          <div class="pa-title" style="color:var(--text);font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escapeHtml(v.title)}</div>
          <div style="color:var(--text-muted);font-size:11px;margin-top:4px;">
            👁 ${(v.viewCount || 0).toLocaleString()} · 🌐 ${v.localizationCount || 0}/${TOTAL_LANGS} · ${dateStr}
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.path-a-source-item').forEach((item) => {
    item.addEventListener('click', () => selectPathASource(item.dataset.videoId));
    item.addEventListener('mouseover', () => {
      if (item.dataset.videoId !== pathASelectedSourceVideoId) item.style.background = '#1a1a1a';
    });
    item.addEventListener('mouseout', () => {
      if (item.dataset.videoId !== pathASelectedSourceVideoId) item.style.background = 'transparent';
    });
  });
}

function filterPathASource(ev) {
  const q = String(ev.target.value || '').toLowerCase().trim();
  const items = document.querySelectorAll('.path-a-source-item');
  items.forEach((item) => {
    const title = (item.querySelector('.pa-title')?.textContent || '').toLowerCase();
    item.style.display = title.includes(q) ? 'flex' : 'none';
  });
}

function selectPathASource(videoId) {
  pathASelectedSourceVideoId = videoId;
  document.querySelectorAll('.path-a-source-item').forEach((item) => {
    const isSel = item.dataset.videoId === videoId;
    item.style.background = isSel ? '#2a2418' : 'transparent';
    item.style.borderLeft = isSel ? '3px solid var(--jazz-gold)' : '3px solid transparent';
  });
  const btn = document.getElementById('pathAApplyBtn');
  if (btn) btn.disabled = false;
}

async function applyPathA() {
  if (!pathASelectedSourceVideoId) return;
  const btn = document.getElementById('pathAApplyBtn');
  if (btn) { btn.disabled = true; btn.textContent = '처리 중…'; }

  let data;
  try {
    const r = await fetch('/api/uploader/path-a/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceVideoId: pathASelectedSourceVideoId,
        newTracks: window.uploaderState.tracks,
      }),
    });
    data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
  } catch (e) {
    alert(`Path A 실패: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '적용'; }
    return;
  }

  window.uploaderState.path = 'A';
  window.uploaderState.reuseSourceVideo = data.sourceMeta;
  window.uploaderState.generatedMeta = data.generated;
  window.uploaderState.missingLanguages = data.generated.missingLanguages || [];
  console.log('[Path A] generatedMeta:', data.generated);
  showPathAPreview(data);
}

function showPathAPreview(data) {
  const { generated, sourceMeta } = data;
  const container = document.getElementById('metaNextStep');
  if (!container) return;
  pathACurrentLangTab = sourceMeta.defaultLanguage || 'en';

  const langTabsHtml = PATH_A_LANGUAGES.map((lang) => {
    const isDefault = lang === sourceMeta.defaultLanguage;
    const exists = isDefault || !!generated.localizations?.[lang];
    const label = LANG_LABELS[lang] || lang;
    return `
      <button type="button" class="lang-tab" data-lang="${escapeHtml(lang)}" title="${escapeHtml(label)}"
        style="padding:5px 9px;background:${exists ? '#1a1a1a' : '#3a1818'};color:${exists ? 'var(--text)' : '#f55'};
               border:1px solid #333;cursor:pointer;border-radius:4px;font-size:11px;font-family:ui-monospace,Menlo,monospace;">
        ${escapeHtml(lang)}${exists ? '' : ' ⚠'}
      </button>
    `;
  }).join('');

  const missingHtml = generated.missingLanguages?.length ? `
    <div style="background:#3a1818;border-left:3px solid #f55;padding:10px 12px;margin-bottom:14px;font-size:11px;color:#fdd;border-radius:0 4px 4px 0;">
      ⚠ Source 영상에 없는 언어 (${generated.missingLanguages.length}개):
      <strong style="color:#fff;">${generated.missingLanguages.map(escapeHtml).join(', ')}</strong>
      <div style="color:#caa;margin-top:4px;">이 언어들은 적용되지 않음. 필요하면 Phase 5-D 의 Gemini 번역 사용.</div>
    </div>
  ` : '';

  const tagsHtml = (sourceMeta.tags || []).length
    ? sourceMeta.tags.map((t) => escapeHtml(t)).join(', ')
    : '<span style="color:var(--text-muted);">(없음)</span>';

  container.innerHTML = `
    <h3 style="color:var(--jazz-gold);margin:0 0 12px;font-size:13px;font-weight:600;">미리보기</h3>
    ${missingHtml}
    <div id="pathALangTabs" style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:14px;">${langTabsHtml}</div>

    <div style="margin-bottom:12px;">
      <label style="display:block;color:var(--text-muted);font-size:11px;margin-bottom:4px;">제목</label>
      <textarea id="pathAPreviewTitle" rows="2"
        style="width:100%;padding:8px 9px;background:#161616;color:var(--text);border:1px solid #2a2a2a;border-radius:4px;font-size:12px;resize:vertical;font-family:inherit;"></textarea>
    </div>

    <div style="margin-bottom:12px;">
      <label style="display:block;color:var(--text-muted);font-size:11px;margin-bottom:4px;">설명</label>
      <textarea id="pathAPreviewDescription" rows="18"
        style="width:100%;padding:8px 9px;background:#161616;color:var(--text);border:1px solid #2a2a2a;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;resize:vertical;"></textarea>
    </div>

    <div style="margin-bottom:14px;">
      <label style="display:block;color:var(--text-muted);font-size:11px;margin-bottom:4px;">해시태그 (Source 그대로)</label>
      <div style="padding:8px 9px;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:4px;font-size:11px;color:var(--text-muted);word-break:break-all;">
        ${tagsHtml}
      </div>
    </div>

    <div style="display:flex;gap:8px;">
      <button id="pathABackBtn" type="button" class="te-btn" style="flex:0 0 auto;padding:8px 16px;">← 뒤로</button>
      <button id="pathANextBtn" type="button" class="te-btn gold" style="flex:1;padding:8px 16px;">다음 단계 (Phase 5-F: 적용)</button>
    </div>
  `;

  // 첫 언어 탭 활성화
  switchLangTab(pathACurrentLangTab);

  // 탭 클릭
  container.querySelectorAll('.lang-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchLangTab(tab.dataset.lang));
  });

  // 텍스트 편집 → state 저장
  document.getElementById('pathAPreviewTitle').addEventListener('input', saveCurrentLangEdit);
  document.getElementById('pathAPreviewDescription').addEventListener('input', saveCurrentLangEdit);

  // 뒤로
  document.getElementById('pathABackBtn').addEventListener('click', () => showPathASourceSelect());

  // 다음 단계 → Phase 5-F (예약 + 재생목록 + 적용)
  document.getElementById('pathANextBtn').addEventListener('click', () => showApplyStep());
}

// ────────────────────────────────────────────────────────────────
// Phase 5-F: 적용 단계 — 예약 + 재생목록 + 드라이런 + 진짜 적용
// ────────────────────────────────────────────────────────────────
async function showApplyStep() {
  const container = document.getElementById('metaNextStep');
  if (!container) return;

  container.innerHTML = `
    <h3 style="color:var(--jazz-gold);margin:0 0 14px;font-size:13px;font-weight:600;">YouTube 적용</h3>

    <div style="margin-bottom:18px;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:6px;padding:12px;">
      <div style="color:var(--text-muted);font-size:11px;margin-bottom:8px;font-weight:600;">📅 예약 시간 (SGT)</div>
      <div id="scheduleInfo" style="font-size:11px;line-height:1.7;color:var(--text);margin-bottom:10px;">
        <span style="color:var(--text-muted);">계산 중…</span>
      </div>
      <label style="display:block;font-size:11px;color:var(--text-muted);margin-bottom:4px;">커스텀 (SGT, 비우면 예약 X)</label>
      <input type="datetime-local" id="customScheduleAt"
        style="width:100%;padding:7px 9px;background:#161616;color:var(--text);border:1px solid #2a2a2a;border-radius:4px;font-size:12px;font-family:inherit;">
    </div>

    <div style="margin-bottom:18px;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:6px;padding:12px;">
      <div style="color:var(--text-muted);font-size:11px;margin-bottom:8px;font-weight:600;">📋 재생목록 (default 자동 추가)</div>
      <div id="selectedPlaylists" style="font-size:11px;color:var(--text);">로딩 중…</div>
    </div>

    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <button id="applyBackBtn" type="button" class="te-btn" style="flex:0 0 auto;padding:8px 16px;">← 미리보기</button>
      <button id="dryRunBtn" type="button" class="te-btn" style="flex:1;padding:8px 16px;">🔍 드라이런</button>
      <button id="realApplyBtn" type="button" class="te-btn gold" style="flex:1;padding:8px 16px;opacity:0.5;cursor:not-allowed;" disabled>🚀 진짜 적용</button>
    </div>

    <div id="applyResult" style="display:none;"></div>
  `;

  document.getElementById('applyBackBtn').addEventListener('click', () => {
    showPathAPreview({
      generated: window.uploaderState.generatedMeta,
      sourceMeta: window.uploaderState.reuseSourceVideo,
    });
  });
  document.getElementById('dryRunBtn').addEventListener('click', () => runApply(true));
  document.getElementById('realApplyBtn').addEventListener('click', () => runApply(false));

  // 예약 시간 fetch
  try {
    const r = await fetch('/api/uploader/next-schedule');
    const data = await r.json();
    if (data.ok) {
      const info = document.getElementById('scheduleInfo');
      const lastSGT = data.lastScheduledAt
        ? new Date(data.lastScheduledAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })
        : '<span style="color:var(--text-muted);">없음</span>';
      info.innerHTML = `
        <div>마지막 예약: ${lastSGT}</div>
        <div>다음 슬롯: <span style="color:var(--jazz-gold);font-weight:600;">${escapeHtml(data.nextSlotSGT)}</span></div>
      `;
      // 커스텀 input default = 다음 슬롯 (SGT 로컬 시간으로 표시)
      const settings = loadSettings();
      if (settings.autoSchedule) {
        document.getElementById('customScheduleAt').value = nextSlotToInputValue(data.nextSlot);
      }
    } else {
      document.getElementById('scheduleInfo').innerHTML = `<span style="color:#f55;">${escapeHtml(data.error || '실패')}</span>`;
    }
  } catch (e) {
    document.getElementById('scheduleInfo').innerHTML = `<span style="color:#f55;">${escapeHtml(e.message)}</span>`;
  }

  // default 재생목록 표시
  const settings = loadSettings();
  const selectedDiv = document.getElementById('selectedPlaylists');
  if (!settings.defaultPlaylists.length) {
    selectedDiv.innerHTML = '<span style="color:var(--text-muted);">⚙️ 설정에서 default 재생목록 선택 필요.</span>';
  } else {
    try {
      const r = await fetch('/api/youtube/playlists');
      const data = await r.json();
      if (data.ok) {
        const sel = data.playlists.filter((p) => settings.defaultPlaylists.includes(p.id));
        selectedDiv.innerHTML = sel.length
          ? sel.map((p) => `<div style="padding:4px 0;">✅ ${escapeHtml(p.title)}</div>`).join('')
          : '<span style="color:var(--text-muted);">설정한 재생목록이 채널에 없음.</span>';
      }
    } catch (e) {
      selectedDiv.innerHTML = `<span style="color:#f55;">로드 실패: ${escapeHtml(e.message)}</span>`;
    }
  }
}

// ISO UTC → datetime-local input 값 (SGT 시간으로 표시).
//  datetime-local 은 timezone 정보 없이 로컬 시간 문자열을 받음.
//  여기서는 SGT 기준으로 "YYYY-MM-DDTHH:mm" 포맷.
function nextSlotToInputValue(isoUtc) {
  const d = new Date(isoUtc);
  // SGT = UTC+8 — 시간 컴포넌트를 SGT 로 직접 계산
  const sgtMs = d.getTime() + 8 * 60 * 60 * 1000;
  const sgt = new Date(sgtMs);
  const yyyy = sgt.getUTCFullYear();
  const mm = String(sgt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(sgt.getUTCDate()).padStart(2, '0');
  const HH = String(sgt.getUTCHours()).padStart(2, '0');
  const MM = String(sgt.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
}

// datetime-local input (SGT) → ISO UTC string
function inputValueToIsoUtc(localStr) {
  if (!localStr) return null;
  // localStr = "YYYY-MM-DDTHH:mm" — SGT 로 해석 후 UTC 로 변환
  const [datePart, timePart] = localStr.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  // SGT 시각 → UTC = SGT - 8h
  const sgtMs = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const utcMs = sgtMs - 8 * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

async function runApply(dryRun) {
  const resultDiv = document.getElementById('applyResult');
  const realBtn = document.getElementById('realApplyBtn');
  const dryBtn = document.getElementById('dryRunBtn');

  const generated = window.uploaderState.generatedMeta;
  const selectedVideo = window.uploaderState.selectedVideo;
  if (!generated || !selectedVideo?.id) {
    alert('내부 상태 누락 (selectedVideo / generatedMeta).');
    return;
  }

  if (!dryRun) {
    if (!confirm('진짜 YouTube 영상에 적용합니다.\n백업은 자동 생성됩니다. 계속?')) return;
  }

  const customStr = document.getElementById('customScheduleAt').value;
  const scheduleAt = inputValueToIsoUtc(customStr);
  const settings = loadSettings();

  dryBtn.disabled = true;
  realBtn.disabled = true;
  resultDiv.style.display = 'block';
  resultDiv.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:11px;">${dryRun ? '드라이런' : '적용'} 진행 중…</div>`;

  try {
    const r = await fetch('/api/uploader/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: selectedVideo.id,
        generatedMeta: generated,
        scheduleAt,
        playlistIds: settings.defaultPlaylists,
        dryRun,
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);

    if (dryRun) {
      resultDiv.innerHTML = `
        <div style="background:#0a2a0a;border-left:3px solid #4c4;padding:12px;margin-top:8px;border-radius:0 4px 4px 0;">
          <div style="color:#4c4;font-size:12px;font-weight:600;margin-bottom:6px;">✅ 드라이런 완료</div>
          <div style="color:var(--text-muted);font-size:10px;margin-bottom:8px;">백업: ${escapeHtml(data.backup)}</div>
          <pre style="font-size:10px;line-height:1.5;color:#ccc;background:#000;padding:10px;border-radius:4px;overflow-x:auto;margin:0;">${escapeHtml(JSON.stringify(data.plan, null, 2))}</pre>
          <div style="color:var(--text-muted);font-size:11px;margin-top:8px;">검증 후 "🚀 진짜 적용" 클릭.</div>
        </div>
      `;
      // 진짜 적용 활성화
      realBtn.disabled = false;
      realBtn.style.opacity = '1';
      realBtn.style.cursor = 'pointer';
    } else {
      const failedPlaylists = (data.playlists || []).filter((p) => !p.ok);
      const playlistMsg = failedPlaylists.length
        ? `<div style="color:#f55;font-size:11px;margin-top:6px;">⚠ 재생목록 추가 실패 ${failedPlaylists.length}개:<br>${failedPlaylists.map((p) => escapeHtml(p.error)).join('<br>')}</div>`
        : `<div style="color:#4c4;font-size:11px;margin-top:6px;">✅ 재생목록 ${data.playlists?.length || 0}개 추가</div>`;
      resultDiv.innerHTML = `
        <div style="background:#0a2a0a;border-left:3px solid #4c4;padding:14px;margin-top:8px;border-radius:0 4px 4px 0;">
          <div style="color:#4c4;font-size:13px;font-weight:600;margin-bottom:8px;">🎉 적용 완료</div>
          <div style="color:var(--text);font-size:11px;line-height:1.6;">
            <div>비디오: ${escapeHtml(data.videoId)}</div>
            <div>제목/설명/언어 업데이트: ✓</div>
            <div>예약: ${data.updated?.status ? '✓' : '— (변경 X)'}</div>
            ${playlistMsg}
            <div style="color:var(--text-muted);margin-top:6px;">백업: ${escapeHtml(data.backup)}</div>
          </div>
          <a href="${escapeHtml(data.youtubeUrl)}" target="_blank" rel="noopener"
            style="display:inline-block;margin-top:10px;padding:6px 12px;background:var(--jazz-gold);color:#000;text-decoration:none;border-radius:4px;font-size:11px;font-weight:700;">
            🎬 YouTube Studio 에서 확인 →
          </a>
        </div>
      `;
      // 자동 새 탭 열기
      window.open(data.youtubeUrl, '_blank');
    }
  } catch (e) {
    resultDiv.innerHTML = `
      <div style="background:#3a1818;border-left:3px solid #f55;padding:12px;margin-top:8px;border-radius:0 4px 4px 0;">
        <div style="color:#f55;font-size:12px;font-weight:600;">✗ ${dryRun ? '드라이런' : '적용'} 실패</div>
        <div style="color:#fdd;font-size:11px;margin-top:4px;">${escapeHtml(e.message)}</div>
      </div>
    `;
    dryBtn.disabled = false;
    if (!dryRun) {
      // 진짜 적용 실패 → 드라이런만 다시 가능
      realBtn.disabled = false;
      realBtn.style.opacity = '1';
      realBtn.style.cursor = 'pointer';
    }
    return;
  }

  dryBtn.disabled = false;
}

function switchLangTab(lang) {
  pathACurrentLangTab = lang;
  const generated = window.uploaderState.generatedMeta;
  const sourceMeta = window.uploaderState.reuseSourceVideo;
  if (!generated || !sourceMeta) return;

  // 탭 시각 갱신
  document.querySelectorAll('.lang-tab').forEach((t) => {
    const isSel = t.dataset.lang === lang;
    const isDefault = t.dataset.lang === sourceMeta.defaultLanguage;
    const exists = isDefault || !!generated.localizations?.[t.dataset.lang];
    t.style.background = isSel ? 'var(--jazz-gold)' : (exists ? '#1a1a1a' : '#3a1818');
    t.style.color = isSel ? '#000' : (exists ? 'var(--text)' : '#f55');
    t.style.fontWeight = isSel ? '700' : 'normal';
  });

  let title = '';
  let description = '';
  if (lang === sourceMeta.defaultLanguage) {
    title = generated.title?.default || '';
    description = generated.description?.default || '';
  } else if (generated.localizations?.[lang]) {
    title = generated.localizations[lang].title || '';
    description = generated.localizations[lang].description || '';
  } else {
    title = '(이 언어는 source 영상에 없음 — 적용 시 무시됨)';
    description = '';
  }

  const titleEl = document.getElementById('pathAPreviewTitle');
  const descEl = document.getElementById('pathAPreviewDescription');
  if (titleEl) titleEl.value = title;
  if (descEl) descEl.value = description;
}

function saveCurrentLangEdit() {
  const generated = window.uploaderState.generatedMeta;
  const sourceMeta = window.uploaderState.reuseSourceVideo;
  if (!generated || !sourceMeta) return;
  const lang = pathACurrentLangTab;
  const title = document.getElementById('pathAPreviewTitle')?.value ?? '';
  const description = document.getElementById('pathAPreviewDescription')?.value ?? '';

  if (lang === sourceMeta.defaultLanguage) {
    generated.title = generated.title || {};
    generated.description = generated.description || {};
    generated.title.default = title;
    generated.description.default = description;
  } else {
    generated.localizations = generated.localizations || {};
    if (!generated.localizations[lang]) generated.localizations[lang] = {};
    generated.localizations[lang].title = title;
    generated.localizations[lang].description = description;
  }
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
