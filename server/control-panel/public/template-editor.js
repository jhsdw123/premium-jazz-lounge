// Premium Jazz Lounge — Template Editor (Phase 4-C-1-A)
// vanilla ES module. interact.js 는 글로벌 (CDN 으로 로드).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const te = {
  templates: [],           // GET /api/templates
  components: [],          // 현재 캔버스 컴포넌트들
  bgUrl: null,             // 배경 이미지 URL
  selectedId: null,        // 선택된 컴포넌트 id
  editingTemplate: null,   // 현재 편집 기준 템플릿 (있으면 새 저장 시 dup, 없으면 fresh)
  initialized: false,
};

// ─── Toast (app.js 의 토스터 재사용) ─────────────────────────────
function toast(msg, type = 'info', durationMs = 4000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toaster')?.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.2s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 220);
  }, durationMs);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

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
async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ─── Component factories ────────────────────────────────────────
let _idCounter = 1;
function nextId() {
  _idCounter += 1;
  return `c${Date.now().toString(36)}_${_idCounter}`;
}

function defaultsFor(type) {
  const baseSize = { width: 600, height: 120 };
  const base = {
    id: nextId(),
    type,
    x: (CANVAS_W - baseSize.width) / 2,
    y: (CANVAS_H - baseSize.height) / 2,
    width: baseSize.width,
    height: baseSize.height,
    rotation: 0,
    opacity: 1.0,
  };
  switch (type) {
    case 'text':
      return {
        ...base,
        content: '{{trackTitle}}',
        fontSize: 72,
        fontFamily: 'Playfair Display, serif',
        color: '#FFFFFF',
        textShadow: '0 0 20px rgba(212,175,55,0.8)',
        textAlign: 'center',
      };
    case 'image':
      return { ...base, src: '', fit: 'contain', width: 400, height: 400 };
    case 'visualizer':
      return {
        ...base,
        width: 1200, height: 200,
        x: (CANVAS_W - 1200) / 2, y: 800,
        style: 'bars',
        color: '#D4AF37',
        glowIntensity: 0.6,
        barCount: 64,
        barGap: 4,
      };
    case 'progress':
      return {
        ...base,
        width: 1600, height: 8,
        x: (CANVAS_W - 1600) / 2, y: 1020,
        style: 'melody',
        bgColor: 'rgba(255,255,255,0.1)',
        fillColor: '#D4AF37',
      };
  }
  return base;
}

// ─── 어두운 텍스트 색상 → 그림자 자동 약화 ───────────────────
function isDarkColor(hex) {
  if (!hex || typeof hex !== 'string') return false;
  const m = hex.replace('#', '');
  if (m.length !== 6) return false;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  // perceived luminance (Rec. 709)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 110;
}

// ─── 옛 schema → 새 schema 어댑터 ─────────────────────────────
function loadConfigToCanvas(cfg) {
  // 새 형식: components[] 가 있으면 그대로
  if (Array.isArray(cfg?.components)) {
    return cfg.components.map((c) => ({ ...c, id: c.id || nextId() }));
  }
  // 옛 형식 → 변환
  const result = [];
  if (cfg?.title) {
    result.push({
      id: nextId(),
      type: 'text',
      x: (CANVAS_W - 1200) / 2,
      y: 480,
      width: 1200, height: 160,
      rotation: 0, opacity: 1.0,
      content: cfg.title.text || '{{trackTitle}}',
      fontSize: cfg.title.fontSize ?? 72,
      fontFamily: cfg.title.fontFamily || 'Playfair Display, serif',
      color: cfg.title.color || '#FFFFFF',
      textShadow: cfg.title.textShadow || '0 0 20px rgba(212,175,55,0.8)',
      textAlign: 'center',
    });
  }
  if (cfg?.visualizer) {
    const v = cfg.visualizer;
    const w = v.width ?? 1200;
    const h = v.height ?? 200;
    result.push({
      id: nextId(),
      type: 'visualizer',
      x: (v.position?.x ?? CANVAS_W / 2) - w / 2,
      y: (v.position?.y ?? 800) - h / 2,
      width: w, height: h,
      rotation: 0, opacity: 1.0,
      style: v.style || 'bars',
      color: v.color || '#D4AF37',
      glowIntensity: v.glowIntensity ?? 0.6,
      barCount: v.barCount ?? 64,
      barGap: v.barGap ?? 4,
    });
  }
  if (cfg?.progressBar) {
    const p = cfg.progressBar;
    const w = p.width ?? 1600;
    const h = p.height ?? 8;
    result.push({
      id: nextId(),
      type: 'progress',
      x: (p.position?.x ?? CANVAS_W / 2) - w / 2,
      y: (p.position?.y ?? 1020) - h / 2,
      width: w, height: h,
      rotation: 0, opacity: 1.0,
      style: p.style || 'melody',
      bgColor: p.bgColor || 'rgba(255,255,255,0.1)',
      fillColor: p.fillColor || '#D4AF37',
    });
  }
  return result;
}

// ─── Render ─────────────────────────────────────────────────────
function getScale() {
  const frame = $('#teCanvasFrame');
  if (!frame) return 1;
  return frame.clientWidth / CANVAS_W;
}

function placeholderText(content) {
  if (!content) return '';
  return String(content)
    .replace(/\{\{trackTitle\}\}/g, 'Track Title (preview)')
    .replace(/\{\{trackNumber\}\}/g, '1')
    .replace(/\{\{totalTracks\}\}/g, '14');
}

function renderBars(c) {
  const count = Math.max(1, Math.min(120, parseInt(c.barCount, 10) || 64));
  const gap = Math.max(0, parseInt(c.barGap, 10) || 4);
  const totalGap = gap * (count - 1);
  const innerW = c.width - totalGap;
  const barW = Math.max(1, innerW / count);
  const colorRgba = (c.color || '#D4AF37');
  let html = `<div class="te-comp-visualizer" style="
    color: ${colorRgba};
    width: 100%; height: 100%;
    filter: drop-shadow(0 0 ${4 + (c.glowIntensity ?? 0.6) * 6}px ${colorRgba});
  ">`;
  for (let i = 0; i < count; i++) {
    // pseudo-random heights (균등하지 않게 — 미리보기 느낌)
    const seed = (i * 9301 + 49297) % 233280 / 233280;
    const h = 20 + Math.round(seed * 80);
    html += `<span class="te-bar" style="width:${barW}px; height:${h}%; margin-right:${i === count - 1 ? 0 : gap}px;"></span>`;
  }
  html += `</div>`;
  return html;
}

function renderProgress(c) {
  return `<div class="te-progress-track" style="background:${c.bgColor || 'rgba(255,255,255,0.1)'};">
    <div class="te-progress-fill" style="background:${c.fillColor || '#D4AF37'};"></div>
  </div>`;
}

function renderTextInner(c) {
  const shadow = isDarkColor(c.color) ? 'none' : (c.textShadow || 'none');
  return `<div class="text-render" style="
    color: ${c.color || '#FFFFFF'};
    font-size: ${c.fontSize || 72}px;
    font-family: ${c.fontFamily || 'Playfair Display, serif'};
    text-align: ${c.textAlign || 'center'};
    text-shadow: ${shadow};
    line-height: 1.1;
  ">${escapeHtml(placeholderText(c.content || ''))}</div>`;
}

function renderImageInner(c) {
  if (!c.src) {
    return `<div style="color:var(--text-muted);font-size:11px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:rgba(255,255,255,0.04);border:1px dashed var(--border-strong);">(이미지 없음)</div>`;
  }
  const fit = c.fit || 'contain';
  return `<img src="${escapeHtml(c.src)}" style="object-fit:${fit};width:100%;height:100%;" />`;
}

function renderComponentInner(c) {
  switch (c.type) {
    case 'text':       return renderTextInner(c);
    case 'image':      return renderImageInner(c);
    case 'visualizer': return renderBars(c);
    case 'progress':   return renderProgress(c);
  }
  return '';
}

function applyComponentTransform(el, c) {
  const s = getScale();
  el.style.left = `${c.x * s}px`;
  el.style.top = `${c.y * s}px`;
  el.style.width = `${c.width * s}px`;
  el.style.height = `${c.height * s}px`;
  el.style.opacity = String(c.opacity ?? 1);
  el.dataset.x = String(c.x);
  el.dataset.y = String(c.y);
  el.dataset.w = String(c.width);
  el.dataset.h = String(c.height);

  // Text/visualizer 의 fontSize 등 내부 비주얼 요소도 scale 반영
  if (c.type === 'text') {
    const tr = el.querySelector('.text-render');
    if (tr) tr.style.fontSize = `${(c.fontSize || 72) * s}px`;
  }
}

function renderCanvas() {
  const inner = $('#teCanvasInner');
  if (!inner) return;
  inner.innerHTML = '';
  for (const c of te.components) {
    const el = document.createElement('div');
    el.className = `te-comp te-comp-${c.type}`;
    el.dataset.id = c.id;
    if (c.id === te.selectedId) el.classList.add('selected');
    el.innerHTML = `
      ${renderComponentInner(c)}
      <button class="te-del" type="button" title="삭제">✕</button>
      <div class="te-handle"></div>
      <div class="te-opacity">
        <input type="range" min="0" max="100" value="${Math.round((c.opacity ?? 1) * 100)}" />
      </div>
    `;
    applyComponentTransform(el, c);
    inner.appendChild(el);
    bindComponentInteractions(el, c);
  }
  $('#teCompCount').textContent = String(te.components.length);
  renderBg();
  renderProps();
}

function renderBg() {
  const bgEl = $('#teCanvasBg');
  if (!bgEl) return;
  if (te.bgUrl) {
    bgEl.classList.remove('empty');
    bgEl.style.backgroundImage = `url("${te.bgUrl}")`;
  } else {
    bgEl.classList.add('empty');
    bgEl.style.backgroundImage = '';
  }
}

// ─── interact.js bindings ─────────────────────────────────────
function bindComponentInteractions(el, c) {
  const scale = () => getScale();

  // 클릭 시 선택
  el.addEventListener('mousedown', (ev) => {
    if (ev.target.classList.contains('te-del')) return;
    if (ev.target.closest('.te-opacity')) return;
    selectComponent(c.id);
  });

  // 삭제 버튼
  el.querySelector('.te-del').addEventListener('click', (ev) => {
    ev.stopPropagation();
    removeComponent(c.id);
  });

  // 투명도 슬라이더
  const opIn = el.querySelector('.te-opacity input');
  opIn.addEventListener('input', (ev) => {
    ev.stopPropagation();
    const v = parseInt(opIn.value, 10) / 100;
    updateComponent(c.id, { opacity: v });
    el.style.opacity = String(v);
    if (te.selectedId === c.id) renderProps();
  });
  opIn.addEventListener('mousedown', (ev) => ev.stopPropagation());

  if (typeof window.interact !== 'function') return;

  // 드래그 (본체)
  window.interact(el).draggable({
    inertia: false,
    listeners: {
      move(ev) {
        if (ev.target.classList.contains('te-handle')) return;
        const cur = te.components.find((x) => x.id === c.id);
        if (!cur) return;
        const s = scale();
        const nx = cur.x + ev.dx / s;
        const ny = cur.y + ev.dy / s;
        cur.x = Math.round(nx);
        cur.y = Math.round(ny);
        applyComponentTransform(el, cur);
        if (te.selectedId === cur.id) renderProps();
      },
    },
    allowFrom: '.te-comp',
    ignoreFrom: '.te-handle, .te-del, .te-opacity',
  });

  // 리사이즈 (우하단 핸들)
  window.interact(el).resizable({
    edges: { right: '.te-handle', bottom: '.te-handle' },
    listeners: {
      move(ev) {
        const cur = te.components.find((x) => x.id === c.id);
        if (!cur) return;
        const s = scale();
        cur.width = Math.max(20, Math.round(cur.width + ev.deltaRect.width / s));
        cur.height = Math.max(10, Math.round(cur.height + ev.deltaRect.height / s));
        applyComponentTransform(el, cur);
        // 비주얼라이저는 width/height 변경 시 bar 다시 그리기
        if (cur.type === 'visualizer' || cur.type === 'progress' || cur.type === 'image' || cur.type === 'text') {
          el.querySelector('.te-bar')?.parentElement?.remove();
          const tr = el.querySelector('.text-render');
          const img = el.querySelector('img');
          const pt = el.querySelector('.te-progress-track');
          const noImage = el.querySelector('div[style*="이미지 없음"]');
          // 강제 재렌더 — 본체만 교체
          const oldExtra = el.querySelectorAll('.te-del, .te-handle, .te-opacity');
          // 내부 첫 자식만 교체
          const newInner = document.createElement('div');
          newInner.style.width = '100%'; newInner.style.height = '100%';
          newInner.innerHTML = renderComponentInner(cur);
          // 기존 내부 텍스트/img/visualizer 제거
          [...el.children].forEach((ch) => {
            if (!ch.classList.contains('te-del') && !ch.classList.contains('te-handle') && !ch.classList.contains('te-opacity')) {
              ch.remove();
            }
          });
          // newInner 의 자식만 prepend
          while (newInner.firstChild) {
            el.insertBefore(newInner.firstChild, el.firstChild);
          }
        }
        if (te.selectedId === cur.id) renderProps();
      },
    },
  });
}

// 윈도우 리사이즈 시 컴포넌트 transform 다시 적용 (scale 변경)
window.addEventListener('resize', () => {
  if (!te.initialized) return;
  const inner = $('#teCanvasInner');
  if (!inner) return;
  for (const c of te.components) {
    const el = inner.querySelector(`[data-id="${c.id}"]`);
    if (el) applyComponentTransform(el, c);
  }
});

// ─── State mutators ─────────────────────────────────────────────
function selectComponent(id) {
  te.selectedId = id;
  // 선택 표시만 갱신 (전체 re-render 하면 interact 핸들러 다시 바인딩되어 비싸짐)
  $$('#teCanvasInner .te-comp').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  renderProps();
}

function updateComponent(id, patch) {
  const idx = te.components.findIndex((c) => c.id === id);
  if (idx < 0) return;
  te.components[idx] = { ...te.components[idx], ...patch };
  // 시각 갱신 — transform 만 바뀐 게 아니라면 inner re-render
  const el = $(`#teCanvasInner [data-id="${id}"]`);
  if (!el) return;
  // inner 다시 그리기
  const old = el.querySelectorAll('.te-del, .te-handle, .te-opacity');
  [...el.children].forEach((ch) => {
    if (!ch.classList.contains('te-del') && !ch.classList.contains('te-handle') && !ch.classList.contains('te-opacity')) {
      ch.remove();
    }
  });
  const inner = document.createElement('div');
  inner.style.width = '100%'; inner.style.height = '100%';
  inner.innerHTML = renderComponentInner(te.components[idx]);
  while (inner.firstChild) {
    el.insertBefore(inner.firstChild, el.firstChild);
  }
  applyComponentTransform(el, te.components[idx]);
}

function removeComponent(id) {
  te.components = te.components.filter((c) => c.id !== id);
  if (te.selectedId === id) te.selectedId = null;
  renderCanvas();
}

function addComponent(type) {
  const c = defaultsFor(type);
  if (type === 'image') {
    // 이미지는 src 가 있어야 의미 있음 — 업로드 dialog 띄우기
    promptImageUpload((url) => {
      c.src = url;
      te.components.push(c);
      te.selectedId = c.id;
      renderCanvas();
    });
    return;
  }
  te.components.push(c);
  te.selectedId = c.id;
  renderCanvas();
}

// ─── Properties panel ─────────────────────────────────────────
function renderProps() {
  const wrap = $('#teProps');
  if (!wrap) return;
  const c = te.components.find((x) => x.id === te.selectedId);
  if (!c) {
    wrap.classList.add('empty');
    wrap.innerHTML = '컴포넌트를 클릭하면 여기서 속성을 편집합니다.';
    return;
  }
  wrap.classList.remove('empty');
  let typeFields = '';
  if (c.type === 'text') {
    typeFields = `
      <div class="te-prop" style="grid-column: 1 / -1;">
        <label>Content (변수: {{trackTitle}}, {{trackNumber}}, {{totalTracks}})</label>
        <input type="text" data-prop="content" value="${escapeHtml(c.content || '')}" />
      </div>
      <div class="te-prop"><label>Font Size</label><input type="number" data-prop="fontSize" value="${c.fontSize || 72}" min="8" max="500" /></div>
      <div class="te-prop"><label>Font Family</label>
        <select data-prop="fontFamily">
          <option ${c.fontFamily?.startsWith('Playfair') ? 'selected' : ''} value="Playfair Display, serif">Playfair Display</option>
          <option ${c.fontFamily?.startsWith('Inter') ? 'selected' : ''} value="Inter, sans-serif">Inter</option>
          <option ${c.fontFamily?.startsWith('Georgia') ? 'selected' : ''} value="Georgia, serif">Georgia</option>
          <option ${c.fontFamily?.startsWith('Cinzel') ? 'selected' : ''} value="Cinzel, serif">Cinzel</option>
          <option ${c.fontFamily?.includes('monospace') ? 'selected' : ''} value="SF Mono, Menlo, monospace">Mono</option>
        </select>
      </div>
      <div class="te-prop"><label>Color</label><input type="color" data-prop="color" value="${c.color || '#FFFFFF'}" /></div>
      <div class="te-prop"><label>Text Align</label>
        <select data-prop="textAlign">
          <option value="left" ${c.textAlign === 'left' ? 'selected' : ''}>Left</option>
          <option value="center" ${(!c.textAlign || c.textAlign === 'center') ? 'selected' : ''}>Center</option>
          <option value="right" ${c.textAlign === 'right' ? 'selected' : ''}>Right</option>
        </select>
      </div>
      <div class="te-prop" style="grid-column: 1 / -1;">
        <label>Text Shadow (글로우)</label>
        <input type="text" data-prop="textShadow" value="${escapeHtml(c.textShadow || '')}" placeholder="0 0 20px rgba(212,175,55,0.8)" />
      </div>
      ${isDarkColor(c.color) ? `<div class="te-prop-warn">⚠ 어두운 텍스트 컬러 — 그림자 자동 비활성. 밝은 색을 권장합니다.</div>` : ''}
    `;
  } else if (c.type === 'image') {
    typeFields = `
      <div class="te-prop" style="grid-column: 1 / -1;">
        <label>이미지 URL</label>
        <input type="text" data-prop="src" value="${escapeHtml(c.src || '')}" />
      </div>
      <div class="te-prop">
        <label>Fit</label>
        <select data-prop="fit">
          <option value="contain" ${c.fit === 'contain' ? 'selected' : ''}>Contain</option>
          <option value="cover" ${c.fit === 'cover' ? 'selected' : ''}>Cover</option>
          <option value="fill" ${c.fit === 'fill' ? 'selected' : ''}>Fill</option>
        </select>
      </div>
      <div class="te-prop">
        <label>&nbsp;</label>
        <button class="te-btn" id="teReuploadImg" type="button">📂 재업로드</button>
      </div>
    `;
  } else if (c.type === 'visualizer') {
    typeFields = `
      <div class="te-prop"><label>Style</label>
        <select data-prop="style">
          <option value="bars" selected>Bars</option>
        </select>
      </div>
      <div class="te-prop"><label>Color</label><input type="color" data-prop="color" value="${c.color || '#D4AF37'}" /></div>
      <div class="te-prop"><label>Bar Count</label><input type="number" data-prop="barCount" value="${c.barCount || 64}" min="4" max="120" /></div>
      <div class="te-prop"><label>Bar Gap</label><input type="number" data-prop="barGap" value="${c.barGap || 4}" min="0" max="40" /></div>
      <div class="te-prop"><label>Glow Intensity (0-1)</label><input type="number" step="0.1" data-prop="glowIntensity" value="${c.glowIntensity ?? 0.6}" min="0" max="2" /></div>
    `;
  } else if (c.type === 'progress') {
    typeFields = `
      <div class="te-prop"><label>Style</label>
        <select data-prop="style">
          <option value="melody" selected>Melody</option>
        </select>
      </div>
      <div class="te-prop"><label>BG Color</label><input type="text" data-prop="bgColor" value="${escapeHtml(c.bgColor || 'rgba(255,255,255,0.1)')}" /></div>
      <div class="te-prop"><label>Fill Color</label><input type="color" data-prop="fillColor" value="${c.fillColor || '#D4AF37'}" /></div>
    `;
  }

  wrap.innerHTML = `
    <h3>${c.type.toUpperCase()} ${c.id.slice(-6)}</h3>
    <div class="te-prop-grid">
      <div class="te-prop"><label>X</label><input type="number" data-prop="x" value="${Math.round(c.x)}" /></div>
      <div class="te-prop"><label>Y</label><input type="number" data-prop="y" value="${Math.round(c.y)}" /></div>
      <div class="te-prop"><label>Width</label><input type="number" data-prop="width" value="${Math.round(c.width)}" /></div>
      <div class="te-prop"><label>Height</label><input type="number" data-prop="height" value="${Math.round(c.height)}" /></div>
      <div class="te-prop"><label>Opacity</label><input type="number" step="0.05" data-prop="opacity" value="${(c.opacity ?? 1).toFixed(2)}" min="0" max="1" /></div>
      ${typeFields}
    </div>
  `;
  // 핸들러
  wrap.querySelectorAll('[data-prop]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const prop = inp.dataset.prop;
      let val = inp.value;
      if (inp.type === 'number') val = parseFloat(val);
      if (Number.isNaN(val) && inp.type === 'number') return;
      updateComponent(c.id, { [prop]: val });
    });
  });
  // 이미지 재업로드 버튼
  const reup = wrap.querySelector('#teReuploadImg');
  if (reup) {
    reup.addEventListener('click', () => {
      promptImageUpload((url) => {
        updateComponent(c.id, { src: url });
        renderProps();
      });
    });
  }
}

// ─── Background upload ────────────────────────────────────────
$('#teBgUploadBtn')?.addEventListener('click', () => $('#teBgFile').click());
$('#teBgFile')?.addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  ev.target.value = '';
  if (!f) return;
  $('#teBgStatus').textContent = `업로드 중: ${f.name}…`;
  try {
    const fd = new FormData();
    fd.append('file', f, f.name);
    const res = await fetch('/api/templates/upload-background', { method: 'POST', body: fd });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    te.bgUrl = j.url;
    $('#teBgStatus').textContent = `${f.name} (${(j.bytes / 1024).toFixed(0)} KB)`;
    renderBg();
    toast('배경 업로드 완료', 'success');
  } catch (e) {
    $('#teBgStatus').textContent = `(실패: ${e.message})`;
    toast(`배경 업로드 실패: ${e.message}`, 'error');
  }
});
$('#teBgClearBtn')?.addEventListener('click', () => {
  te.bgUrl = null;
  $('#teBgStatus').textContent = '(배경 없음)';
  renderBg();
});

// ─── Image upload (컴포넌트 src) ─────────────────────────────
function promptImageUpload(onUrl) {
  // 임시 input file 띄우기 → 같은 endpoint 재사용 (이미지면 원본 그대로 저장됨)
  const f = document.createElement('input');
  f.type = 'file';
  f.accept = 'image/*';
  f.style.display = 'none';
  document.body.appendChild(f);
  f.addEventListener('change', async () => {
    const file = f.files?.[0];
    if (!file) { f.remove(); return; }
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/templates/upload-background', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onUrl(j.url);
      toast('이미지 업로드 완료', 'success');
    } catch (e) {
      toast(`이미지 업로드 실패: ${e.message}`, 'error');
    } finally {
      f.remove();
    }
  });
  f.click();
}

// ─── Component add buttons ────────────────────────────────────
$$('[data-add]').forEach((btn) => {
  btn.addEventListener('click', () => addComponent(btn.dataset.add));
});

// ─── Save flow ────────────────────────────────────────────────
$('#teSaveBtn')?.addEventListener('click', async () => {
  const name = $('#teSaveName').value.trim();
  if (!name) {
    toast('템플릿 이름을 입력하세요', 'error');
    $('#teSaveName').focus();
    return;
  }
  if (!te.components.length && !te.bgUrl) {
    if (!confirm('컴포넌트도 배경도 없습니다. 그래도 빈 템플릿을 저장할까요?')) return;
  }
  const isFav = $('#teSaveFav').checked;
  const config_json = {
    canvas: { width: CANVAS_W, height: CANVAS_H },
    components: te.components.map((c) => ({ ...c })), // 깊은 복사 X (단순 객체)
  };
  try {
    const j = await apiPost('/api/templates', {
      name,
      description: te.editingTemplate ? `Based on ${te.editingTemplate.name}` : null,
      is_default: false,
      is_favorite: isFav,
      background_image_url: te.bgUrl,
      config_json,
    });
    toast(`저장 완료: ${j.template.name}`, 'success');
    $('#teSaveName').value = '';
    $('#teSaveFav').checked = false;
    await refreshTemplateList();
  } catch (e) {
    toast(`저장 실패: ${e.message}`, 'error');
  }
});

// ─── Template list (좌측) ─────────────────────────────────────
async function refreshTemplateList() {
  try {
    const j = await apiGet('/api/templates');
    te.templates = j.templates || [];
    renderTemplateList();
  } catch (e) {
    toast(`템플릿 로드 실패: ${e.message}`, 'error');
  }
}

function renderTemplateList() {
  const ul = $('#teList');
  if (!ul) return;
  ul.innerHTML = '';
  if (!te.templates.length) {
    ul.innerHTML = `<div style="color:var(--text-muted);font-size:11px;padding:8px;">(저장된 템플릿 없음)</div>`;
    return;
  }
  for (const t of te.templates) {
    const isCur = te.editingTemplate?.id === t.id;
    const star = t.is_favorite ? '★' : '☆';
    const row = document.createElement('div');
    row.className = `te-list-item${isCur ? ' active' : ''}`;
    row.innerHTML = `
      <span class="star ${t.is_favorite ? 'fav' : ''}" data-id="${t.id}" title="즐겨찾기 토글">${star}</span>
      <span class="name" data-load="${t.id}" title="${escapeHtml(t.description || t.name)}">${escapeHtml(t.name)}${t.is_default ? ' <span style="color:var(--jazz-gold);font-size:10px;">★default</span>' : ''}</span>
      <span class="actions">
        <button data-load="${t.id}" type="button" title="편집">편집</button>
        <button data-dup="${t.id}" type="button" title="복제">복제</button>
        <button class="danger" data-del="${t.id}" type="button" title="삭제">✕</button>
      </span>
    `;
    ul.appendChild(row);
  }
  ul.querySelectorAll('.star').forEach((s) =>
    s.addEventListener('click', () => toggleFavorite(parseInt(s.dataset.id, 10)))
  );
  ul.querySelectorAll('[data-load]').forEach((b) =>
    b.addEventListener('click', () => loadTemplate(parseInt(b.dataset.load, 10)))
  );
  ul.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', () => duplicateTemplate(parseInt(b.dataset.dup, 10)))
  );
  ul.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteTemplate(parseInt(b.dataset.del, 10)))
  );
}

async function toggleFavorite(id) {
  const t = te.templates.find((x) => x.id === id);
  if (!t) return;
  try {
    await apiPost(`/api/templates/${id}/favorite`, { is_favorite: !t.is_favorite });
    await refreshTemplateList();
  } catch (e) {
    toast(`즐겨찾기 실패: ${e.message}`, 'error');
  }
}

async function loadTemplate(id) {
  try {
    const j = await apiGet(`/api/templates/${id}`);
    te.editingTemplate = j.template;
    te.components = loadConfigToCanvas(j.template.config_json || {});
    te.bgUrl = j.template.background_image_url || null;
    te.selectedId = null;
    $('#teEditingName').textContent = j.template.name;
    $('#teBgStatus').textContent = te.bgUrl ? '(편집 중인 템플릿의 배경)' : '(배경 없음)';
    renderCanvas();
    renderTemplateList();
    toast(`로드: ${j.template.name}`, 'info', 1500);
  } catch (e) {
    toast(`템플릿 로드 실패: ${e.message}`, 'error');
  }
}

async function duplicateTemplate(id) {
  try {
    const j = await apiPost(`/api/templates/${id}/duplicate`, {});
    toast(`복제: ${j.template.name}`, 'success');
    await refreshTemplateList();
  } catch (e) {
    toast(`복제 실패: ${e.message}`, 'error');
  }
}

async function deleteTemplate(id) {
  const t = te.templates.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`템플릿 "${t.name}" 을(를) 삭제합니다. 되돌릴 수 없습니다.\n계속?`)) return;
  try {
    await apiDelete(`/api/templates/${id}`);
    toast(`삭제됨: ${t.name}`, 'success');
    if (te.editingTemplate?.id === id) {
      te.editingTemplate = null;
      $('#teEditingName').textContent = '(새 템플릿)';
    }
    await refreshTemplateList();
  } catch (e) {
    toast(`삭제 실패: ${e.message}`, 'error');
  }
}

// ─── Tab onEnter ─────────────────────────────────────────────
async function templatesOnEnter() {
  if (!te.initialized) {
    te.initialized = true;
    await refreshTemplateList();
    renderCanvas();
  } else {
    // 재진입 시 리스트 만 갱신 (다른 탭에서 변경 가능성)
    refreshTemplateList();
  }
}

// app.js 의 switchTab 이 hook 하는 전역
window.templatesOnEnter = templatesOnEnter;
