// Phase 6: Thumbnail Studio (Option B — standalone, no video dependencies).
// Ported from legacy Youtube_webapp/index.html.
//
// Kept as-is from legacy:
//   - THUMB_FILTERS (Cinematic / YouTube / Retro / Art)
//   - Atmosphere FX (Blur, Dim, Saturation, Gradient: none/bottom/vignette/spotlight)
//   - Border modes (Simple stroke, Premium side label with rotated text)
//   - Custom text layers (font/size/color/B/I/U/Hollow/spacing/alpha/X/Y/stroke/glow/shadow)
//   - 50+ Google Fonts (preserved optgroup structure)
//   - Preset save/load JSON (legacy-compatible: ignores video-only keys on import)
//   - PNG/JPG export with KB-limit binary search
//   - Filter hover preview
//
// Removed (영상 의존성, PJL 은 Remotion 으로 영상 만듦):
//   - Visualizer bars (analyser snapshot), Vinyl LP, Progress bar, Clock
//   - Main text/image layers (legacy preset keys ignored on import)
//
// LocalStorage keys: pjl.thumbnail.lastPreset

(function () {
  'use strict';

  // ─── Filter dictionary (legacy 그대로) ────────────────────────────
  const THUMB_FILTERS = {
    'cine_teal_orange': {
      name: '🎬 Cinema: Teal & Orange',
      filter: 'contrast(1.1) saturate(1.1)',
      layers: [
        { type: 'solid', col: 'rgba(0, 255, 255, 0.2)', mode: 'overlay' },
        { type: 'solid', col: 'rgba(255, 140, 0, 0.3)', mode: 'soft-light' },
        { type: 'grad', col1: 'transparent', col2: 'rgba(0,0,10,0.6)', mode: 'multiply' },
      ],
    },
    'cine_noir': {
      name: '🎬 Cinema: Noir (B&W)',
      filter: 'grayscale(1) contrast(1.4) brightness(0.9)',
      layers: [
        { type: 'solid', col: 'rgba(0, 0, 0, 0.4)', mode: 'soft-light' },
        { type: 'grad', col1: 'transparent', col2: '#000', mode: 'multiply' },
      ],
    },
    'cine_drama': {
      name: '🎬 Cinema: Drama',
      filter: 'saturate(0.8) contrast(1.3)',
      layers: [
        { type: 'solid', col: 'rgba(20, 30, 50, 0.4)', mode: 'overlay' },
        { type: 'grad', col1: 'transparent', col2: 'rgba(0,0,0,0.8)', mode: 'multiply' },
      ],
    },
    'yt_punchy': {
      name: '▶️ YouTube: Punchy',
      filter: 'contrast(1.15) saturate(1.3) brightness(1.05)',
      layers: [
        { type: 'solid', col: 'rgba(255, 255, 255, 0.1)', mode: 'soft-light' },
        { type: 'solid', col: 'rgba(0, 0, 0, 0.1)', mode: 'multiply' },
      ],
    },
    'yt_gaming': {
      name: '🎮 Gaming: RGB',
      filter: 'contrast(1.2) saturate(1.5)',
      layers: [
        { type: 'solid', col: 'rgba(255, 0, 255, 0.15)', mode: 'screen' },
        { type: 'solid', col: 'rgba(0, 0, 255, 0.2)', mode: 'overlay' },
      ],
    },
    'yt_bright': {
      name: '✨ Clean & Bright',
      filter: 'brightness(1.1) saturate(1.1)',
      layers: [{ type: 'solid', col: 'rgba(255, 255, 230, 0.2)', mode: 'soft-light' }],
    },
    'retro_film': {
      name: '🎞️ Retro: Film Stock',
      filter: 'sepia(0.3) contrast(1.1) saturate(1.2)',
      layers: [
        { type: 'solid', col: 'rgba(255, 200, 0, 0.1)', mode: 'multiply' },
        { type: 'solid', col: 'rgba(255, 0, 100, 0.05)', mode: 'screen' },
      ],
    },
    'retro_90s': {
      name: '📼 Retro: VHS 90s',
      filter: 'contrast(0.9) brightness(1.1) saturate(0.8)',
      layers: [
        { type: 'solid', col: 'rgba(0, 0, 50, 0.2)', mode: 'exclusion' },
        { type: 'solid', col: 'rgba(255, 0, 255, 0.1)', mode: 'overlay' },
      ],
    },
    'retro_bw': {
      name: '📰 Retro: Classic B&W',
      filter: 'grayscale(1) contrast(1.2)',
      layers: [{ type: 'solid', col: 'rgba(200, 200, 180, 0.2)', mode: 'multiply' }],
    },
    'art_cyberpunk': {
      name: '🌃 Art: Cyberpunk',
      filter: 'contrast(1.3) saturate(1.6) hue-rotate(-10deg)',
      layers: [
        { type: 'grad', col1: 'rgba(0, 255, 255, 0.3)', col2: 'rgba(255, 0, 255, 0.3)', mode: 'overlay' },
      ],
    },
    'art_dreamy': {
      name: '☁️ Art: Dreamy',
      filter: 'blur(0.5px) brightness(1.1) saturate(1.2)',
      layers: [{ type: 'solid', col: 'rgba(255, 220, 220, 0.3)', mode: 'screen' }],
    },
    'normal': { name: '🚫 Original (Reset)', filter: 'none', layers: [] },
  };

  // ─── Font list (legacy 그대로) ────────────────────────────────────
  const FONT_OPTGROUPS_HTML = `
    <optgroup label="✨ Top Pick">
      <option value="'Playfair Display', serif" selected>Playfair Display</option>
    </optgroup>
    <optgroup label="✍️ Handwriting & Vibe">
      <option value="'Dancing Script', cursive">Dancing Script</option>
      <option value="'Pacifico', cursive">Pacifico</option>
      <option value="'Great Vibes', cursive">Great Vibes</option>
      <option value="'Caveat', cursive">Caveat</option>
      <option value="'Indie Flower', cursive">Indie Flower</option>
      <option value="'Shadows Into Light', cursive">Shadows Into Light</option>
      <option value="'Sacramento', cursive">Sacramento</option>
      <option value="'Parisienne', cursive">Parisienne</option>
      <option value="'Amatic SC', cursive">Amatic SC</option>
      <option value="'Permanent Marker', cursive">Permanent Marker</option>
      <option value="'Nanum Pen Script', cursive">Nanum Pen Script (KR)</option>
      <option value="'Yeonsung', cursive">Yeonsung (KR)</option>
    </optgroup>
    <optgroup label="👔 Modern Sans-Serif">
      <option value="'Montserrat', sans-serif">Montserrat</option>
      <option value="'Roboto', sans-serif">Roboto</option>
      <option value="'Open Sans', sans-serif">Open Sans</option>
      <option value="'Lato', sans-serif">Lato</option>
      <option value="'Poppins', sans-serif">Poppins</option>
      <option value="'Raleway', sans-serif">Raleway</option>
      <option value="'Oswald', sans-serif">Oswald</option>
      <option value="'Bebas Neue', sans-serif">Bebas Neue</option>
      <option value="'Anton', sans-serif">Anton</option>
      <option value="'Quicksand', sans-serif">Quicksand</option>
      <option value="'Ubuntu', sans-serif">Ubuntu</option>
      <option value="'Nunito', sans-serif">Nunito</option>
      <option value="'Work Sans', sans-serif">Work Sans</option>
      <option value="'Fira Sans', sans-serif">Fira Sans</option>
      <option value="'Josefin Sans', sans-serif">Josefin Sans</option>
      <option value="'Noto Sans KR', sans-serif">Noto Sans (KR)</option>
      <option value="'Nanum Gothic', sans-serif">Nanum Gothic (KR)</option>
      <option value="'Black Han Sans', sans-serif">Black Han Sans (KR)</option>
      <option value="'Do Hyeon', sans-serif">Do Hyeon (KR)</option>
      <option value="'Jua', sans-serif">Jua (KR)</option>
      <option value="'Sunflower', sans-serif">Sunflower (KR)</option>
    </optgroup>
    <optgroup label="🎻 Classic Serif">
      <option value="'Merriweather', serif">Merriweather</option>
      <option value="'Lora', serif">Lora</option>
      <option value="'Cormorant Garamond', serif">Cormorant Garamond</option>
      <option value="'Cinzel', serif">Cinzel</option>
      <option value="'Abril Fatface', cursive">Abril Fatface</option>
      <option value="'Crimson Text', serif">Crimson Text</option>
      <option value="'Libre Baskerville', serif">Libre Baskerville</option>
      <option value="'Arvo', serif">Arvo</option>
      <option value="'DM Serif Display', serif">DM Serif Display</option>
      <option value="'PT Serif', serif">PT Serif</option>
      <option value="'Alfa Slab One', cursive">Alfa Slab One</option>
      <option value="'Noto Serif KR', serif">Noto Serif (KR)</option>
      <option value="'Nanum Myeongjo', serif">Nanum Myeongjo (KR)</option>
    </optgroup>
    <optgroup label="🚀 Futurism & Unique">
      <option value="'Orbitron', sans-serif">Orbitron</option>
      <option value="'Righteous', cursive">Righteous</option>
      <option value="'Comfortaa', cursive">Comfortaa</option>
      <option value="'Titillium Web', sans-serif">Titillium Web</option>
    </optgroup>
  `;

  // ─── State ───────────────────────────────────────────────────────
  const thumbState = {
    initialized: false,
    bgImage: null,                  // HTMLImageElement (uploaded background)
    extraTextLayers: [],            // [{ id, text, font, size, color, alpha, x, y, align, bold, italic, underline, hollow, spacing, strokeW, strokeCol, glow, shadowX, shadowY }]
    selectedExtraId: null,
    selectedFilterKey: 'normal',
    canvas: null,
    ctx: null,
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── Markup builder ──────────────────────────────────────────────
  function buildMarkup() {
    return `
      <div id="thStudioWrap" style="display:flex;gap:14px;height:calc(100vh - 110px);min-height:600px;">
        <!-- LEFT: preview -->
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:14px;background:#0a0a0a;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
          <div style="width:100%;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h3 style="margin:0;color:var(--jazz-gold);font-size:14px;font-weight:700;letter-spacing:1px;">PREVIEW (1920×1080)</h3>
            <div id="thBgUploadHint" style="font-size:11px;color:var(--text-muted);">배경 이미지 없음 — 우측 패널 또는 여기로 drop</div>
          </div>
          <div id="thDropZone" style="flex:1;width:100%;display:flex;align-items:center;justify-content:center;border:2px dashed transparent;border-radius:6px;transition:border-color 0.15s, background 0.15s;">
            <canvas id="thumbPreviewCanvas" style="max-width:100%;max-height:100%;border:1px solid #444;box-shadow:0 0 30px rgba(0,0,0,0.6);background:#000;"></canvas>
          </div>
          <div style="margin-top:8px;font-size:10px;color:var(--text-muted);">* 화면에 보이는 그대로 저장됨 (선택 박스는 export 시 제외).</div>
        </div>

        <!-- RIGHT: sidebar -->
        <div style="width:380px;flex-shrink:0;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:14px 16px;border-bottom:1px solid var(--border);background:#151515;display:flex;justify-content:space-between;align-items:center;">
            <h2 style="margin:0;font-size:14px;color:var(--text);font-weight:800;letter-spacing:0.5px;">🖼️ THUMBNAIL STUDIO</h2>
          </div>
          <div style="flex:1;overflow-y:auto;padding:14px 16px;">

            <!-- Background image upload -->
            <div class="th-section">
              <label class="th-label">📷 BACKGROUND IMAGE</label>
              <label class="th-file-btn">
                이미지 업로드 / 변경
                <input type="file" id="thBgImageInput" accept="image/*" style="display:none">
              </label>
              <div id="thBgFilename" class="th-help">(없음)</div>
            </div>

            <!-- Magic Filters -->
            <div class="th-section">
              <label class="th-label">✨ MAGIC FILTERS (호버=미리보기)</label>
              <div id="thFilterBtnContainer" style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:5px;"></div>
              <div id="thCurrentFilterName" class="th-help" style="text-align:right;font-style:italic;">Selected: Original (Reset)</div>
            </div>

            <!-- Atmosphere -->
            <div class="th-section">
              <label class="th-label">🌫 ATMOSPHERE FX</label>
              <div class="th-row"><label>Blur</label><span id="valThBlur" class="th-val">0px</span></div>
              <input type="range" id="rngThBlur" min="0" max="20" step="0.5" value="0">
              <div class="th-row"><label>Dim</label><span id="valThDim" class="th-val">0.0</span></div>
              <input type="range" id="rngThDim" min="0" max="1.0" step="0.05" value="0">
              <div class="th-row"><label>Saturation</label><span id="valThSat" class="th-val">100%</span></div>
              <input type="range" id="rngThSat" min="0" max="200" step="10" value="100">

              <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);">
                <div class="th-row"><label>Gradient Mode</label></div>
                <select id="selThGradMode">
                  <option value="none">None</option>
                  <option value="bottom">Bottom Fade (Subtitle)</option>
                  <option value="vignette" selected>Vignette (Corners)</option>
                  <option value="spotlight">Reverse Spotlight (Focus)</option>
                </select>
                <div class="th-row" style="margin-top:6px;"><label>Intensity / Size</label></div>
                <input type="range" id="rngThGradInt" min="0" max="100" value="70">
                <div id="thSpotControls" style="display:none;margin-top:6px;">
                  <div class="th-row"><label>Spot X / Y</label></div>
                  <div style="display:flex;gap:5px;">
                    <input type="range" id="rngThSpotX" min="0" max="100" value="50">
                    <input type="range" id="rngThSpotY" min="0" max="100" value="50">
                  </div>
                </div>
                <div class="th-row" style="margin-top:6px;"><label>Shadow Color</label><input type="color" id="colThGrad" value="#000000"></div>
              </div>
            </div>

            <!-- Frame & Sidebar -->
            <div class="th-section">
              <label class="th-label">🖼 FRAME & SIDEBAR</label>
              <div class="th-row"><label>Border Mode</label></div>
              <select id="selThBorderMode">
                <option value="simple">Simple Stroke</option>
                <option value="premium">Premium Side Label</option>
              </select>
              <div class="th-row"><label>Color</label><input type="color" id="colThBorder" value="#d4af37"></div>
              <div class="th-row"><label>Thickness / Size</label><span id="valThThick" class="th-val">20px</span></div>
              <input type="range" id="rngThThick" min="0" max="100" value="20">
              <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);">
                <div class="th-help" style="margin-bottom:5px;">Side Label (Premium 모드)</div>
                <input type="text" id="txtThSide" value="JAZZ COLLECTION" placeholder="Side Label Text" style="margin-bottom:5px;">
                <select id="selThSideFont" style="margin-bottom:5px;"></select>
                <div class="th-row" style="margin-bottom:5px;"><label>Text Color</label><input type="color" id="colThSideTxt" value="#ffffff"></div>
                <div class="th-row"><label>Offset X / Y</label></div>
                <div style="display:flex;gap:5px;">
                  <input type="range" id="rngThSideX" min="-1000" max="1000" value="0">
                  <input type="range" id="rngThSideY" min="-1000" max="1000" value="0">
                </div>
              </div>
            </div>

            <!-- Custom Text -->
            <div class="th-section">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <label class="th-label" style="margin:0;">📝 CUSTOM TEXT</label>
                <button id="btnAddThumbText" class="th-mini-btn">+ ADD TEXT</button>
              </div>
              <div id="thumbCustomTextList" style="display:flex;flex-direction:column;gap:4px;margin-top:8px;"></div>
              <div id="thumbTextEditPanel" style="display:none;background:#1e1e1e;padding:12px;border-radius:6px;border:1px solid var(--border);margin-top:10px;">
                <div style="font-size:9px;color:var(--jazz-gold);margin-bottom:8px;font-weight:bold;">TEXT EDITOR</div>
                <input type="text" id="thEditContent" style="margin-bottom:8px;width:100%;">
                <div style="display:flex;gap:5px;margin-bottom:5px;">
                  <select id="thEditFont" style="flex:2;"></select>
                  <input type="number" id="thEditSize" placeholder="Size" style="width:60px;">
                </div>
                <div style="display:flex;gap:2px;margin-bottom:8px;">
                  <button id="thBtnBold" class="th-style-btn">B</button>
                  <button id="thBtnItalic" class="th-style-btn">I</button>
                  <button id="thBtnUnderline" class="th-style-btn">U</button>
                  <button id="thBtnHollow" class="th-style-btn" style="font-size:9px;width:auto;padding:3px 8px;">Hollow</button>
                </div>
                <div class="th-row"><label>Spacing / Alpha</label></div>
                <div style="display:flex;gap:5px;margin-bottom:5px;">
                  <input type="range" id="thEditSpace" min="-10" max="50" value="0" title="Letter Spacing" style="flex:1;">
                  <input type="range" id="thEditAlpha" min="0" max="1" step="0.1" value="1" title="Opacity" style="flex:1;">
                </div>
                <div class="th-row"><label>Position X / Y</label></div>
                <div style="display:flex;gap:5px;margin-bottom:8px;">
                  <input type="range" id="thEditX" min="0" max="100" step="0.5" style="flex:1;">
                  <input type="range" id="thEditY" min="0" max="100" step="0.5" style="flex:1;">
                </div>
                <div class="th-row"><label>Stroke (Border)</label></div>
                <div style="display:flex;gap:5px;margin-bottom:5px;align-items:center;">
                  <input type="color" id="thEditStrokeCol" value="#000000" style="width:30px;height:24px;border:none;padding:0;">
                  <input type="range" id="thEditStrokeW" min="0" max="20" value="0" style="flex:1;">
                </div>
                <div class="th-row"><label>Neon Glow</label></div>
                <input type="range" id="thEditGlow" min="0" max="50" value="0" style="width:100%;margin-bottom:5px;">
                <div class="th-row"><label>Shadow X / Y</label></div>
                <div style="display:flex;gap:5px;margin-bottom:8px;">
                  <input type="range" id="thEditShadowX" min="-50" max="50" value="0" style="flex:1;">
                  <input type="range" id="thEditShadowY" min="-50" max="50" value="0" style="flex:1;">
                </div>
                <div class="th-row"><label>Text Color</label><input type="color" id="thEditColor" value="#ffffff"></div>
                <div style="display:flex;gap:5px;margin-top:10px;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;">
                  <button id="thBtnDelText" class="th-mini-btn" style="background:#522;color:#fff;">DELETE LAYER</button>
                  <button id="thBtnCloseEdit" class="th-mini-btn">CLOSE</button>
                </div>
              </div>
            </div>

            <!-- Preset -->
            <div class="th-section" style="border:1px solid var(--jazz-gold);">
              <label class="th-label" style="color:var(--jazz-gold);">💾 PRESET</label>
              <div style="display:flex;gap:6px;">
                <button id="btnThPresetExport" class="th-mini-btn" style="flex:1;color:var(--jazz-gold);border-color:var(--jazz-gold);">EXPORT JSON</button>
                <button id="btnThPresetImport" class="th-mini-btn" style="flex:1;color:#ffaa00;border-color:#ffaa00;">IMPORT JSON</button>
              </div>
              <input type="file" id="thPresetFileInput" accept=".json" style="display:none;">
              <div id="thPresetStatus" class="th-help" style="text-align:center;"></div>
            </div>

            <!-- Export -->
            <div class="th-section">
              <label class="th-label">⬇️ EXPORT</label>
              <select id="selThFormat" style="margin-bottom:6px;">
                <option value="image/png">PNG (High Quality)</option>
                <option value="image/jpeg">JPG (Web Optimized)</option>
              </select>
              <div class="th-row"><label>Max Size (KB)</label><span id="valThSize" class="th-val">2000 KB</span></div>
              <input type="range" id="rngThSize" min="100" max="5000" step="100" value="2000">
              <div class="th-row" style="margin-top:8px;"><label>Filename</label></div>
              <input type="text" id="txtThFilename" value="Thumbnail_Capture">
              <button id="btnThDownload" class="th-cta" style="margin-top:10px;">⬇️ SAVE THUMBNAIL</button>
            </div>

          </div>
        </div>
      </div>
    `;
  }

  function injectStyles() {
    if (document.getElementById('thumbnailStudioStyles')) return;
    const style = document.createElement('style');
    style.id = 'thumbnailStudioStyles';
    style.textContent = `
      #tab-thumbnail .th-section { background:#0e0e0e; border:1px solid var(--border); border-radius:6px; padding:12px; margin-bottom:12px; }
      #tab-thumbnail .th-label { display:block; color:var(--jazz-gold); font-size:11px; font-weight:700; letter-spacing:0.5px; margin-bottom:8px; text-transform:uppercase; }
      #tab-thumbnail .th-row { display:flex; justify-content:space-between; align-items:center; margin:6px 0 4px; }
      #tab-thumbnail .th-row label { font-size:10px; color:var(--text-dim); font-weight:700; }
      #tab-thumbnail .th-val { font-size:10px; color:var(--jazz-gold); font-family:ui-monospace,Menlo,monospace; }
      #tab-thumbnail .th-help { font-size:10px; color:var(--text-muted); margin-top:4px; }
      #tab-thumbnail input[type="text"], #tab-thumbnail input[type="number"], #tab-thumbnail select { width:100%; background:var(--bg-input); border:1px solid var(--border); color:var(--text); padding:6px 8px; border-radius:4px; font-size:11px; box-sizing:border-box; outline:none; font-family:inherit; }
      #tab-thumbnail input[type="range"] { width:100%; -webkit-appearance:none; appearance:none; background:var(--bg-input); height:4px; border-radius:2px; outline:none; cursor:pointer; }
      #tab-thumbnail input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; background:var(--jazz-gold); border-radius:50%; cursor:pointer; }
      #tab-thumbnail input[type="color"] { width:36px; height:24px; padding:0; border:1px solid var(--border); background:transparent; cursor:pointer; border-radius:3px; }
      #tab-thumbnail .th-file-btn { display:block; width:100%; background:var(--bg-input); color:var(--text-dim); padding:10px 0; text-align:center; border-radius:4px; font-size:10px; font-weight:bold; cursor:pointer; border:1px dashed var(--border); transition:0.15s; box-sizing:border-box; }
      #tab-thumbnail .th-file-btn:hover { background:var(--bg-hover); color:var(--text); border-color:var(--jazz-gold); }
      #tab-thumbnail .th-mini-btn { background:var(--bg-input); border:1px solid var(--border); color:var(--text-dim); font-size:10px; padding:5px 10px; cursor:pointer; border-radius:3px; font-weight:bold; }
      #tab-thumbnail .th-mini-btn:hover { color:var(--text); border-color:var(--jazz-gold); }
      #tab-thumbnail .th-style-btn { flex:1; background:var(--bg-input); border:1px solid var(--border); color:var(--text-dim); padding:5px 0; font-size:10px; cursor:pointer; font-weight:700; border-radius:3px; }
      #tab-thumbnail .th-style-btn.active { background:var(--jazz-gold); color:#000; border-color:var(--jazz-gold); }
      #tab-thumbnail .th-cta { display:block; width:100%; background:var(--jazz-gold); color:#000; border:none; border-radius:4px; padding:12px 0; font-weight:900; font-size:12px; cursor:pointer; box-shadow:0 0 12px rgba(212,175,55,0.3); transition:0.15s; }
      #tab-thumbnail .th-cta:hover { box-shadow:0 0 18px rgba(212,175,55,0.5); }
      #tab-thumbnail .th-cta:disabled { background:#222 !important; color:#555 !important; cursor:not-allowed; box-shadow:none; }
      #tab-thumbnail #thDropZone.drag-over { border-color:var(--jazz-gold); background:rgba(212,175,55,0.05); }
      #tab-thumbnail optgroup { color:var(--jazz-gold); background:#111; font-weight:bold; }
      #tab-thumbnail option { color:var(--text); background:var(--bg-input); }
    `;
    document.head.appendChild(style);
  }

  // ─── Drawing ─────────────────────────────────────────────────────
  function drawThumbnail(isExport = false, tempFilterKey = null) {
    const canvas = thumbState.canvas;
    if (!canvas) return;
    const ctx = thumbState.ctx;
    const w = 1920, h = 1080;
    const effectiveKey = tempFilterKey !== null ? tempFilterKey : thumbState.selectedFilterKey;

    const borderMode = document.getElementById('selThBorderMode').value;
    const borderColor = document.getElementById('colThBorder').value;
    const thickness = parseInt(document.getElementById('rngThThick').value, 10);
    const sideText = document.getElementById('txtThSide').value;
    const sideFont = document.getElementById('selThSideFont').value;
    const sideX = parseInt(document.getElementById('rngThSideX').value, 10);
    const sideY = parseInt(document.getElementById('rngThSideY').value, 10);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    let cx = 0, cy = 0, cw = w, ch = h, sidebarW = 0;
    if (borderMode === 'simple') {
      cx = thickness; cy = thickness; cw = w - thickness * 2; ch = h - thickness * 2;
    } else if (borderMode === 'premium') {
      sidebarW = thickness * 3; cx = sidebarW; cy = 0; cw = w - sidebarW; ch = h;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();

    // Background image + filter stack
    if (thumbState.bgImage) {
      const img = thumbState.bgImage;
      const blurVal = document.getElementById('rngThBlur').value;
      const dimVal = parseFloat(document.getElementById('rngThDim').value);
      const satVal = document.getElementById('rngThSat').value;
      const gradMode = document.getElementById('selThGradMode').value;
      const gradInt = parseInt(document.getElementById('rngThGradInt').value, 10) / 100;
      const gradColor = document.getElementById('colThGrad').value;

      const r = img.width / img.height, cr = cw / ch;
      let dw, dh, dx, dy;
      if (r > cr) { dh = ch; dw = ch * r; dx = cx + (cw - dw) / 2; dy = cy; }
      else { dw = cw; dh = cw / r; dx = cx; dy = cy + (ch - dh) / 2; }

      ctx.save();
      const magicFilter = THUMB_FILTERS[effectiveKey] || THUMB_FILTERS['normal'];
      let finalFilter = `blur(${blurVal}px) saturate(${satVal}%)`;
      if (magicFilter.filter && magicFilter.filter !== 'none') {
        finalFilter += ` ${magicFilter.filter}`;
      }
      ctx.filter = finalFilter;
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.filter = 'none';

      if (magicFilter.layers) {
        magicFilter.layers.forEach((layer) => {
          ctx.save();
          ctx.globalCompositeOperation = layer.mode || 'source-over';
          if (layer.type === 'solid') {
            ctx.fillStyle = layer.col;
            ctx.fillRect(dx, dy, dw, dh);
          } else if (layer.type === 'grad') {
            const grd = ctx.createLinearGradient(0, 0, 0, h);
            grd.addColorStop(0, layer.col1);
            grd.addColorStop(1, layer.col2);
            ctx.fillStyle = grd;
            ctx.fillRect(0, 0, w, h);
          }
          ctx.restore();
        });
      }
      ctx.restore();

      if (dimVal > 0) {
        ctx.fillStyle = `rgba(0,0,0,${dimVal})`;
        ctx.fillRect(cx, cy, cw, ch);
      }

      if (gradMode !== 'none') {
        ctx.save();
        let gradient;
        if (gradMode === 'bottom') {
          const fadeStart = ch * (1.0 - gradInt);
          gradient = ctx.createLinearGradient(0, fadeStart, 0, ch);
          gradient.addColorStop(0, 'transparent');
          gradient.addColorStop(1, gradColor);
          ctx.fillStyle = gradient;
          ctx.fillRect(cx, fadeStart, cw, ch - fadeStart);
        } else if (gradMode === 'vignette') {
          const radius = Math.max(cw, ch) * 0.8;
          gradient = ctx.createRadialGradient(cx + cw / 2, cy + ch / 2, radius * (1 - gradInt), cx + cw / 2, cy + ch / 2, radius);
          gradient.addColorStop(0, 'transparent');
          gradient.addColorStop(1, gradColor);
          ctx.fillStyle = gradient;
          ctx.fillRect(cx, cy, cw, ch);
        } else if (gradMode === 'spotlight') {
          const spotX = parseInt(document.getElementById('rngThSpotX').value, 10) / 100 * cw + cx;
          const spotY = parseInt(document.getElementById('rngThSpotY').value, 10) / 100 * ch + cy;
          const spotSize = Math.max(cw, ch) * (0.1 + (1.0 - gradInt) * 0.5);
          gradient = ctx.createRadialGradient(spotX, spotY, spotSize * 0.2, spotX, spotY, spotSize);
          gradient.addColorStop(0, 'transparent');
          gradient.addColorStop(1, gradColor);
          ctx.fillStyle = gradient;
          ctx.fillRect(cx, cy, cw, ch);
        }
        ctx.restore();
      }
    }

    // Custom text layers
    thumbState.extraTextLayers.forEach((l) => {
      ctx.save();
      ctx.globalAlpha = l.alpha;
      let fs = '';
      if (l.bold) fs += 'bold ';
      if (l.italic) fs += 'italic ';
      ctx.font = `${fs}${l.size}px ${l.font}`;
      ctx.textAlign = l.align;
      ctx.textBaseline = 'middle';
      if (ctx.letterSpacing !== undefined) ctx.letterSpacing = l.spacing + 'px';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowOffsetX = l.shadowX;
      ctx.shadowOffsetY = l.shadowY;
      ctx.shadowBlur = l.glow > 0 ? l.glow : 5;
      if (l.glow > 0) ctx.shadowColor = l.color;

      const x = w * l.x, y = h * l.y;
      if (l.strokeW > 0) {
        ctx.lineWidth = l.strokeW;
        ctx.strokeStyle = l.strokeCol;
        ctx.strokeText(l.text, x, y);
      }
      if (!l.hollow) {
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, x, y);
      }
      if (l.underline) {
        const m = ctx.measureText(l.text);
        const lw = m.width;
        const lx = l.align === 'center' ? x - lw / 2 : l.align === 'right' ? x - lw : x;
        ctx.fillStyle = l.color;
        ctx.fillRect(lx, y + l.size / 2, lw, l.size / 10);
      }
      if (!isExport && l.id === thumbState.selectedExtraId) {
        const m = ctx.measureText(l.text);
        const lw = m.width;
        const lx = l.align === 'center' ? x - lw / 2 : l.align === 'right' ? x - lw : x;
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ctx.strokeRect(lx - 10, y - l.size / 2 - 5, lw + 20, l.size + 10);
      }
      ctx.restore();
    });

    ctx.restore(); // End clip

    // Borders
    if (borderMode === 'simple') {
      ctx.lineWidth = thickness;
      ctx.strokeStyle = borderColor;
      ctx.strokeRect(thickness / 2, thickness / 2, w - thickness, h - thickness);
    } else if (borderMode === 'premium') {
      ctx.fillStyle = borderColor;
      ctx.fillRect(0, 0, sidebarW, h);
      const sideTxtCol = document.getElementById('colThSideTxt').value;
      const safeFont = sideFont || 'sans-serif';
      ctx.save();
      ctx.translate(sidebarW / 2 + sideX, h / 2 + sideY);
      ctx.rotate(-Math.PI / 2);
      ctx.font = `bold ${Math.min(80, thickness * 2)}px ${safeFont}`;
      ctx.fillStyle = sideTxtCol;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
      ctx.fillText(sideText, 0, 0);
      ctx.restore();
      const strip = 20;
      ctx.fillStyle = borderColor;
      ctx.fillRect(sidebarW, 0, w - sidebarW, strip);
      ctx.fillRect(sidebarW, h - strip, w - sidebarW, strip);
      ctx.fillRect(w - strip, 0, strip, h);
    }
  }

  // ─── Filter button grid ──────────────────────────────────────────
  function buildFilterGrid() {
    const container = document.getElementById('thFilterBtnContainer');
    if (!container) return;
    container.innerHTML = '';
    const groups = { 'Cinematic': [], 'YouTube': [], 'Retro': [], 'Art': [], 'Standard': [] };
    for (const [key, val] of Object.entries(THUMB_FILTERS)) {
      if (key.startsWith('cine_')) groups['Cinematic'].push({ k: key, v: val });
      else if (key.startsWith('yt_')) groups['YouTube'].push({ k: key, v: val });
      else if (key.startsWith('retro_')) groups['Retro'].push({ k: key, v: val });
      else if (key.startsWith('art_')) groups['Art'].push({ k: key, v: val });
      else groups['Standard'].push({ k: key, v: val });
    }
    for (const [gName, items] of Object.entries(groups)) {
      if (!items.length) continue;
      const label = document.createElement('div');
      label.textContent = gName.toUpperCase();
      label.style.cssText = 'font-size:9px;color:var(--text-muted);font-weight:bold;margin:4px 0 2px;';
      container.appendChild(label);
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:4px;';
      items.forEach((item) => {
        const btn = document.createElement('button');
        btn.textContent = item.v.name.split('(')[0].trim();
        btn.dataset.key = item.k;
        btn.style.cssText = 'background:var(--bg-input);color:var(--text-dim);border:1px solid var(--border);font-size:9px;padding:6px 4px;cursor:pointer;border-radius:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:bold;';
        btn.onmouseenter = () => {
          drawThumbnail(false, item.k);
          document.getElementById('thCurrentFilterName').textContent = 'Preview: ' + item.v.name;
          btn.style.borderColor = 'var(--jazz-gold)';
          btn.style.color = 'var(--text)';
        };
        btn.onmouseleave = () => {
          drawThumbnail(false, null);
          const cur = THUMB_FILTERS[thumbState.selectedFilterKey] || THUMB_FILTERS['normal'];
          document.getElementById('thCurrentFilterName').textContent = 'Selected: ' + cur.name;
          if (thumbState.selectedFilterKey !== item.k) {
            btn.style.borderColor = 'var(--border)';
            btn.style.color = 'var(--text-dim)';
          }
        };
        btn.onclick = () => {
          thumbState.selectedFilterKey = item.k;
          highlightSelectedFilter();
          drawThumbnail();
        };
        grid.appendChild(btn);
      });
      container.appendChild(grid);
    }
    highlightSelectedFilter();
  }

  function highlightSelectedFilter() {
    document.querySelectorAll('#thFilterBtnContainer button').forEach((b) => {
      const isSel = b.dataset.key === thumbState.selectedFilterKey;
      b.style.background = isSel ? 'var(--jazz-gold)' : 'var(--bg-input)';
      b.style.color = isSel ? '#000' : 'var(--text-dim)';
      b.style.borderColor = isSel ? 'var(--jazz-gold)' : 'var(--border)';
    });
    const cur = THUMB_FILTERS[thumbState.selectedFilterKey] || THUMB_FILTERS['normal'];
    const nameEl = document.getElementById('thCurrentFilterName');
    if (nameEl) nameEl.textContent = 'Selected: ' + cur.name;
  }

  // ─── Custom text layers ──────────────────────────────────────────
  function renderCustomTextList() {
    const c = document.getElementById('thumbCustomTextList');
    if (!c) return;
    c.innerHTML = '';
    thumbState.extraTextLayers.forEach((l, i) => {
      const btn = document.createElement('button');
      btn.textContent = `${i + 1}. ${l.text}`;
      const isSel = l.id === thumbState.selectedExtraId;
      btn.style.cssText = `width:100%; background:${isSel ? 'var(--jazz-gold)' : 'var(--bg-input)'}; color:${isSel ? '#000' : 'var(--text-dim)'}; border:1px solid var(--border); padding:6px 8px; text-align:left; font-size:10px; cursor:pointer; font-weight:bold; border-radius:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
      btn.onclick = () => editCustomText(l.id);
      c.appendChild(btn);
    });
  }

  function editCustomText(id) {
    thumbState.selectedExtraId = id;
    renderCustomTextList();
    const l = thumbState.extraTextLayers.find((x) => x.id === id);
    const panel = document.getElementById('thumbTextEditPanel');
    if (!l) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    document.getElementById('thEditContent').value = l.text;
    document.getElementById('thEditFont').value = l.font;
    document.getElementById('thEditSize').value = l.size;
    document.getElementById('thEditColor').value = l.color;
    document.getElementById('thEditAlpha').value = l.alpha;
    document.getElementById('thEditX').value = l.x * 100;
    document.getElementById('thEditY').value = l.y * 100;
    document.getElementById('thEditSpace').value = l.spacing;
    document.getElementById('thEditStrokeCol').value = l.strokeCol;
    document.getElementById('thEditStrokeW').value = l.strokeW;
    document.getElementById('thEditGlow').value = l.glow;
    document.getElementById('thEditShadowX').value = l.shadowX;
    document.getElementById('thEditShadowY').value = l.shadowY;
    const setToggle = (btnId, prop) => {
      document.getElementById(btnId).className = `th-style-btn${l[prop] ? ' active' : ''}`;
    };
    setToggle('thBtnBold', 'bold');
    setToggle('thBtnItalic', 'italic');
    setToggle('thBtnUnderline', 'underline');
    setToggle('thBtnHollow', 'hollow');
  }

  // ─── Preset save/load ────────────────────────────────────────────
  function collectPresetData() {
    return {
      version: 1,
      timestamp: new Date().toISOString(),
      filter: thumbState.selectedFilterKey,
      bgFx: {
        blur: parseFloat(document.getElementById('rngThBlur').value),
        dim: parseFloat(document.getElementById('rngThDim').value),
        sat: parseInt(document.getElementById('rngThSat').value, 10),
        gradMode: document.getElementById('selThGradMode').value,
        gradInt: parseInt(document.getElementById('rngThGradInt').value, 10),
        gradColor: document.getElementById('colThGrad').value,
        spotX: parseInt(document.getElementById('rngThSpotX').value, 10),
        spotY: parseInt(document.getElementById('rngThSpotY').value, 10),
      },
      frame: {
        borderMode: document.getElementById('selThBorderMode').value,
        borderColor: document.getElementById('colThBorder').value,
        thickness: parseInt(document.getElementById('rngThThick').value, 10),
        sideText: document.getElementById('txtThSide').value,
        sideFont: document.getElementById('selThSideFont').value,
        sideTxtColor: document.getElementById('colThSideTxt').value,
        sideX: parseInt(document.getElementById('rngThSideX').value, 10),
        sideY: parseInt(document.getElementById('rngThSideY').value, 10),
      },
      customTexts: thumbState.extraTextLayers.map((l) => ({
        text: l.text, font: l.font, size: l.size, color: l.color,
        alpha: l.alpha, x: l.x, y: l.y, align: l.align,
        bold: l.bold, italic: l.italic, underline: l.underline, hollow: l.hollow,
        spacing: l.spacing, strokeW: l.strokeW, strokeCol: l.strokeCol,
        glow: l.glow, shadowX: l.shadowX, shadowY: l.shadowY,
      })),
      exportSettings: {
        format: document.getElementById('selThFormat').value,
        maxSizeKB: parseInt(document.getElementById('rngThSize').value, 10),
        filename: document.getElementById('txtThFilename').value,
      },
    };
  }

  function applyPresetData(preset) {
    if (preset.filter && THUMB_FILTERS[preset.filter]) thumbState.selectedFilterKey = preset.filter;
    if (preset.bgFx) {
      const fx = preset.bgFx;
      const set = (id, val) => { const el = document.getElementById(id); if (el != null && val != null) el.value = val; };
      set('rngThBlur', fx.blur); document.getElementById('valThBlur').textContent = (fx.blur ?? 0) + 'px';
      set('rngThDim', fx.dim); document.getElementById('valThDim').textContent = String(fx.dim ?? 0);
      set('rngThSat', fx.sat); document.getElementById('valThSat').textContent = (fx.sat ?? 100) + '%';
      set('selThGradMode', fx.gradMode);
      set('rngThGradInt', fx.gradInt);
      set('colThGrad', fx.gradColor);
      set('rngThSpotX', fx.spotX);
      set('rngThSpotY', fx.spotY);
      document.getElementById('thSpotControls').style.display = fx.gradMode === 'spotlight' ? 'block' : 'none';
    }
    if (preset.frame) {
      const f = preset.frame;
      const set = (id, val) => { const el = document.getElementById(id); if (el != null && val != null) el.value = val; };
      set('selThBorderMode', f.borderMode);
      set('colThBorder', f.borderColor);
      set('rngThThick', f.thickness); if (f.thickness != null) document.getElementById('valThThick').textContent = f.thickness + 'px';
      set('txtThSide', f.sideText);
      set('selThSideFont', f.sideFont);
      set('colThSideTxt', f.sideTxtColor);
      set('rngThSideX', f.sideX);
      set('rngThSideY', f.sideY);
    }
    if (preset.customTexts && Array.isArray(preset.customTexts)) {
      thumbState.extraTextLayers = preset.customTexts.map((l) => ({
        id: Date.now() + Math.random() * 10000,
        text: l.text || 'Text', font: l.font || "'Montserrat', sans-serif",
        size: l.size || 80, color: l.color || '#ffffff',
        alpha: l.alpha != null ? l.alpha : 1.0,
        x: l.x != null ? l.x : 0.5, y: l.y != null ? l.y : 0.5,
        align: l.align || 'center',
        bold: !!l.bold, italic: !!l.italic, underline: !!l.underline, hollow: !!l.hollow,
        spacing: l.spacing || 0, strokeW: l.strokeW || 0, strokeCol: l.strokeCol || '#000000',
        glow: l.glow || 0, shadowX: l.shadowX || 0, shadowY: l.shadowY || 0,
      }));
      thumbState.selectedExtraId = null;
      document.getElementById('thumbTextEditPanel').style.display = 'none';
      renderCustomTextList();
    }
    if (preset.exportSettings) {
      const ex = preset.exportSettings;
      const set = (id, val) => { const el = document.getElementById(id); if (el != null && val != null) el.value = val; };
      set('selThFormat', ex.format);
      set('rngThSize', ex.maxSizeKB);
      if (ex.maxSizeKB != null) document.getElementById('valThSize').textContent = ex.maxSizeKB + ' KB';
      set('txtThFilename', ex.filename);
    }
    highlightSelectedFilter();
    drawThumbnail();
  }

  // ─── Image upload (file or drop) ─────────────────────────────────
  function loadImageFromFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      alert('이미지 파일만 가능합니다.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        thumbState.bgImage = img;
        document.getElementById('thBgFilename').textContent = `${file.name} (${img.width}×${img.height})`;
        document.getElementById('thBgUploadHint').textContent = `배경: ${file.name}`;
        drawThumbnail();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    if (thumbState.initialized) return;
    const root = document.getElementById('thumbnailRoot');
    if (!root) {
      console.warn('[Thumbnail] root not found');
      return;
    }
    injectStyles();
    root.innerHTML = buildMarkup();

    // Canvas
    const canvas = document.getElementById('thumbPreviewCanvas');
    canvas.width = 1920;
    canvas.height = 1080;
    thumbState.canvas = canvas;
    thumbState.ctx = canvas.getContext('2d');

    // Font selects
    document.getElementById('selThSideFont').innerHTML = FONT_OPTGROUPS_HTML;
    document.getElementById('thEditFont').innerHTML = FONT_OPTGROUPS_HTML;

    // Filter grid
    buildFilterGrid();

    // Background image input
    document.getElementById('thBgImageInput').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      loadImageFromFile(file);
      e.target.value = '';
    });

    // Drag and drop on canvas zone
    const dropZone = document.getElementById('thDropZone');
    ['dragenter', 'dragover'].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    });
    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files?.[0];
      loadImageFromFile(file);
    });

    // FX inputs
    const fxInputs = [
      'selThBorderMode', 'colThBorder', 'rngThThick', 'txtThSide', 'selThSideFont', 'colThSideTxt',
      'rngThBlur', 'rngThDim', 'rngThSat', 'rngThGradInt', 'colThGrad', 'rngThSpotX', 'rngThSpotY',
    ];
    fxInputs.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (e) => {
        if (id === 'rngThBlur') document.getElementById('valThBlur').textContent = e.target.value + 'px';
        if (id === 'rngThDim') document.getElementById('valThDim').textContent = e.target.value;
        if (id === 'rngThSat') document.getElementById('valThSat').textContent = e.target.value + '%';
        if (id === 'rngThThick') document.getElementById('valThThick').textContent = e.target.value + 'px';
        drawThumbnail();
      });
    });

    document.getElementById('selThGradMode').addEventListener('change', (e) => {
      document.getElementById('thSpotControls').style.display = (e.target.value === 'spotlight') ? 'block' : 'none';
      drawThumbnail();
    });
    document.getElementById('rngThSideX').addEventListener('input', () => drawThumbnail());
    document.getElementById('rngThSideY').addEventListener('input', () => drawThumbnail());

    document.getElementById('rngThSize').addEventListener('input', (e) => {
      document.getElementById('valThSize').textContent = e.target.value + ' KB';
    });

    // Custom text — add
    document.getElementById('btnAddThumbText').addEventListener('click', () => {
      const newId = Date.now() + Math.random();
      thumbState.extraTextLayers.push({
        id: newId, text: 'New Text', font: "'Montserrat', sans-serif", size: 80,
        color: '#ffffff', alpha: 1.0, x: 0.5, y: 0.5, align: 'center',
        bold: false, italic: false, underline: false, hollow: false,
        spacing: 0, strokeW: 0, strokeCol: '#000000',
        glow: 0, shadowX: 0, shadowY: 0,
      });
      renderCustomTextList();
      editCustomText(newId);
      drawThumbnail();
    });

    // Bind text edit fields
    const bindEdit = (id, prop, type = 'str') => {
      document.getElementById(id).addEventListener('input', (e) => {
        const l = thumbState.extraTextLayers.find((x) => x.id === thumbState.selectedExtraId);
        if (!l) return;
        if (type === 'int') l[prop] = parseInt(e.target.value, 10);
        else if (type === 'float') l[prop] = parseFloat(e.target.value);
        else if (type === 'pct') l[prop] = parseFloat(e.target.value) / 100;
        else l[prop] = e.target.value;
        if (id === 'thEditContent') renderCustomTextList();
        drawThumbnail();
      });
    };
    bindEdit('thEditContent', 'text');
    bindEdit('thEditFont', 'font');
    bindEdit('thEditSize', 'size', 'int');
    bindEdit('thEditColor', 'color');
    bindEdit('thEditAlpha', 'alpha', 'float');
    bindEdit('thEditX', 'x', 'pct');
    bindEdit('thEditY', 'y', 'pct');
    bindEdit('thEditSpace', 'spacing', 'int');
    bindEdit('thEditStrokeCol', 'strokeCol');
    bindEdit('thEditStrokeW', 'strokeW', 'int');
    bindEdit('thEditGlow', 'glow', 'int');
    bindEdit('thEditShadowX', 'shadowX', 'int');
    bindEdit('thEditShadowY', 'shadowY', 'int');

    const toggleProp = (id, prop) => {
      document.getElementById(id).onclick = () => {
        const l = thumbState.extraTextLayers.find((x) => x.id === thumbState.selectedExtraId);
        if (!l) return;
        l[prop] = !l[prop];
        editCustomText(l.id);
        drawThumbnail();
      };
    };
    toggleProp('thBtnBold', 'bold');
    toggleProp('thBtnItalic', 'italic');
    toggleProp('thBtnUnderline', 'underline');
    toggleProp('thBtnHollow', 'hollow');

    document.getElementById('thBtnDelText').onclick = () => {
      thumbState.extraTextLayers = thumbState.extraTextLayers.filter((x) => x.id !== thumbState.selectedExtraId);
      thumbState.selectedExtraId = null;
      document.getElementById('thumbTextEditPanel').style.display = 'none';
      renderCustomTextList();
      drawThumbnail();
    };
    document.getElementById('thBtnCloseEdit').onclick = () => {
      thumbState.selectedExtraId = null;
      document.getElementById('thumbTextEditPanel').style.display = 'none';
      renderCustomTextList();
      drawThumbnail();
    };

    // Preset
    document.getElementById('btnThPresetExport').onclick = () => {
      const data = collectPresetData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pjl_thumb_preset_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      try { localStorage.setItem('pjl.thumbnail.lastPreset', JSON.stringify(data)); } catch (_) {}
      const status = document.getElementById('thPresetStatus');
      status.textContent = 'Preset exported + saved to localStorage.';
      setTimeout(() => { status.textContent = ''; }, 3000);
    };
    document.getElementById('btnThPresetImport').onclick = () => {
      document.getElementById('thPresetFileInput').click();
    };
    document.getElementById('thPresetFileInput').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const preset = JSON.parse(ev.target.result);
          applyPresetData(preset);
          const status = document.getElementById('thPresetStatus');
          status.textContent = `Loaded: ${file.name}`;
          setTimeout(() => { status.textContent = ''; }, 3000);
        } catch (err) {
          alert('Invalid preset file: ' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    };

    // Try to restore last preset from localStorage
    try {
      const last = localStorage.getItem('pjl.thumbnail.lastPreset');
      if (last) applyPresetData(JSON.parse(last));
    } catch (_) {}

    // Download
    document.getElementById('btnThDownload').onclick = async () => {
      const format = document.getElementById('selThFormat').value;
      const maxSizeKB = parseInt(document.getElementById('rngThSize').value, 10);
      const filename = document.getElementById('txtThFilename').value || 'Thumbnail';
      const btn = document.getElementById('btnThDownload');
      const originalText = btn.textContent;
      btn.textContent = 'Processing...';
      btn.disabled = true;
      drawThumbnail(true);
      try {
        let blob = null;
        if (format === 'image/jpeg') {
          let minQ = 0.01, maxQ = 1.0, quality = 0.9, attempts = 0;
          while (attempts < 10) {
            blob = await new Promise((r) => thumbState.canvas.toBlob(r, format, quality));
            const sizeKB = blob.size / 1024;
            if (sizeKB <= maxSizeKB) {
              if (sizeKB > maxSizeKB * 0.85 || quality < 0.05) break;
              minQ = quality;
            } else {
              maxQ = quality;
            }
            quality = (minQ + maxQ) / 2;
            attempts++;
          }
          if (blob.size / 1024 > maxSizeKB) {
            blob = await new Promise((r) => thumbState.canvas.toBlob(r, format, 0.1));
          }
        } else {
          blob = await new Promise((r) => thumbState.canvas.toBlob(r, format));
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.${format === 'image/jpeg' ? 'jpg' : 'png'}`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('[Thumbnail] export 실패:', err);
        alert('Error saving thumbnail: ' + err.message);
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
        drawThumbnail(false);
      }
    };

    // Initial draw
    drawThumbnail();
    thumbState.initialized = true;
  }

  // Tab entry hook (called by app.js on 'thumbnail' switchTab)
  window.thumbnailOnEnter = function () {
    init();
    // Recompute layout if canvas was offscreen
    if (thumbState.canvas) drawThumbnail();
  };
})();
