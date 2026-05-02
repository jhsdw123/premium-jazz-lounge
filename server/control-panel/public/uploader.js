// Premium Jazz Lounge — Uploader (Phase 5-A)
// YouTube OAuth + 최근 영상 50개 + 재생목록 표시.
//
// 의존: 백엔드 /auth/youtube, /api/youtube/status|videos|playlists.

const $ = (s) => document.querySelector(s);
const TOTAL_LANGS = 16;

const uploader = {
  initialized: false,
  authPollTimer: null,
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
  return `
    <a class="video-card" href="${url}" target="_blank" rel="noopener" data-video-id="${escapeHtml(v.id)}" style="text-decoration:none;color:inherit;">
      ${thumb}
      <div class="vc-title">${escapeHtml(v.title)}</div>
      <div class="vc-meta">
        <span title="조회수">👁 ${(v.viewCount || 0).toLocaleString()}</span>
        ${locBadge(v)}
        <span class="spacer"></span>
        ${statusBadge(v)}
      </div>
      <div class="vc-date">${dateStr}</div>
    </a>
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
  uploader.initialized = true;
}

// 탭 진입 시 호출되는 hook (app.js 의 switchTab 에서 부름)
window.uploaderOnEnter = function uploaderOnEnter() {
  bindOnce();
  checkAuth();
};
