// 배경 루프 영상 — Template Editor 와 Studio(=mp4) 가 같이 쓰는 재생기 (CLAUDE.md 규칙 9).
//
// <video loop> 를 안 쓰는 이유: 끝 → 처음으로 되돌아갈 때 멈칫하고, 몇 번째 프레임이 그려졌는지 알 수 없다.
// 서버가 만든 재생용 사본은 프레임마다 키프레임인 H.264(Annex-B)라서, WebCodecs 로 순서대로 풀면
// 마지막 프레임 다음이 그냥 0번 프레임이다 — 이음새가 없고, 시각 t 에 그릴 프레임이 정확히 정해진다.

const AHEAD = 6;            // 미리 풀어 둘 프레임 수 (VideoFrame 은 GPU 메모리라 적게 든다)
const ENSURE_TIMEOUT_MS = 1000;

export class LoopVideo {
  constructor(meta, bytes) {
    this.meta = meta;
    this.key = meta.key;
    this.frames = meta.frames;
    this.fps = meta.fpsNum / meta.fpsDen;
    this.duration = this.frames / this.fps;
    this._bytes = bytes;
    this._offsets = new Array(this.frames + 1);
    this._offsets[0] = 0;
    for (let i = 0; i < this.frames; i++) this._offsets[i + 1] = this._offsets[i] + meta.sizes[i];
    this._queue = [];       // 풀린 프레임 { idx, frame } — 순서대로
    this._pending = [];     // 디코더에 넣었고 아직 안 나온 프레임 번호
    this._cur = null;       // 지금 화면에 그리는 프레임
    this._feedIdx = 0;
    this._ts = 0;
    this._gen = 0;
    this._waiters = [];
    this._dead = false;
    this._errorCount = 0;
  }

  // onStatus(text) 로 진행 상황을 알린다. 처음 고른 영상은 서버가 재생용 사본을 굽느라 수십 초 걸린다.
  static async load(key, onStatus = () => {}) {
    if (typeof window.VideoDecoder !== 'function') throw new Error('이 브라우저는 영상 배경을 지원하지 않습니다 (Chrome/Edge 필요)');
    onStatus('🎞 배경 영상 준비 중… (처음 고른 영상은 수십 초)');
    const r = await fetch('/api/loops/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    onStatus('🎞 배경 영상 불러오는 중…');
    const buf = await (await fetch(j.loop.url)).arrayBuffer();
    const lv = new LoopVideo(j.loop, new Uint8Array(buf));
    lv._restart(0);
    await lv.ensure(0);
    return lv;
  }

  frameIndexAt(t) {
    const i = Math.floor((t || 0) * this.fps + 1e-6) % this.frames;
    return i < 0 ? i + this.frames : i;
  }

  _restart(idx) {
    const gen = ++this._gen;
    try { this._dec?.close(); } catch {}
    for (const q of this._queue) q.frame.close();
    this._queue = [];
    this._pending = [];
    this._feedIdx = idx;
    this._dec = new VideoDecoder({
      // 갈아끼운 뒤 뒤늦게 나오는 옛 디코더의 프레임은 버린다.
      output: (frame) => (gen === this._gen && !this._dead ? this._onFrame(frame) : frame.close()),
      error: (e) => { if (gen === this._gen) this._onError(e); },
    });
    this._dec.configure({ codec: this.meta.codec, codedWidth: this.meta.width, codedHeight: this.meta.height, optimizeForLatency: true });
    this._pump();
  }

  _onFrame(frame) {
    this._queue.push({ idx: this._pending.shift(), frame });
    const waiters = this._waiters;
    this._waiters = [];
    for (const fn of waiters) fn();
  }

  _onError(e) {
    console.warn('[loop-video] 디코더 오류:', e?.message || e);
    // 한두 번은 다시 세워 본다. 계속 죽으면 마지막 프레임을 든 채 멈춘다(녹화는 계속).
    if (++this._errorCount > 3) { this._dead = true; return; }
    this._restart(this._cur ? (this._cur.idx + 1) % this.frames : 0);
  }

  _pump() {
    while (!this._dead && this._queue.length + this._pending.length < AHEAD) {
      const i = this._feedIdx;
      this._pending.push(i);
      this._dec.decode(new EncodedVideoChunk({
        type: 'key',
        timestamp: Math.round((this._ts++ * 1e6) / this.fps),
        data: this._bytes.subarray(this._offsets[i], this._offsets[i + 1]),
      }));
      this._feedIdx = (i + 1) % this.frames;
    }
  }

  // target 프레임 쪽으로 한 걸음 — 이미 풀려 있으면 바꿔 들고, 멀리 뛰었으면 그 자리에서 다시 푼다.
  _advance(target, exact = false) {
    if (this._dead) return;
    const N = this.frames;
    if (this._cur) {
      if (this._cur.idx === target) return this._pump();
      // 시계가 한두 프레임 뒤로 흔들린 것은 그냥 지금 프레임을 든다 (되감아 풀면 화면이 튄다).
      if (!exact && (this._cur.idx - target + N) % N <= 2) return;
    }
    const next = this._queue[0]?.idx ?? this._pending[0] ?? this._feedIdx;
    let lead = (target - next + N) % N;
    if (lead >= Math.min(AHEAD * 4, N - 1)) return this._restart(target);
    while (this._queue.length && lead >= 0) {
      this._cur?.frame.close();
      this._cur = this._queue.shift();
      lead--;
    }
    this._pump();
  }

  // 미리보기용 — 기다리지 않고, 지금 풀려 있는 것 중 가장 맞는 프레임으로 넘긴다.
  tick(t) {
    this._advance(this.frameIndexAt(t));
  }

  // 녹화용 — 시각 t 의 프레임이 정확히 준비될 때까지 기다린다. 못 맞추면 false (가진 프레임으로 진행).
  async ensure(t) {
    const target = this.frameIndexAt(t);
    const start = performance.now();
    for (;;) {
      this._advance(target, true);
      if (this._cur?.idx === target) return true;
      if (this._dead || performance.now() - start > ENSURE_TIMEOUT_MS) return false;
      await new Promise((resolve) => {
        this._waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  get currentIndex() {
    return this._cur ? this._cur.idx : -1;
  }

  // 지금 든 프레임을 w×h 에 채워 그린다. 그릴 프레임이 없으면 false.
  draw(ctx, w, h) {
    if (!this._cur) return false;
    ctx.drawImage(this._cur.frame, 0, 0, w, h);
    return true;
  }

  destroy() {
    this._dead = true;
    this._gen++;
    try { this._dec?.close(); } catch {}
    for (const q of this._queue) q.frame.close();
    this._cur?.frame.close();
    this._queue = [];
    this._pending = [];
    this._cur = null;
    this._bytes = null;
    for (const fn of this._waiters) fn();
    this._waiters = [];
  }
}

// 미리보기용 시계. 오디오의 currentTime 은 10ms 남짓씩 계단으로 올라서 그대로 쓰면 60fps 에서
// 같은 프레임이 두 번 그려졌다 한 프레임을 건너뛴다. 벽시계로 매끄럽게 가되, 오디오 위치와
// 벌어지면(탐색·곡 넘김·일시정지) 다시 맞춘다.
export function createSmoothClock() {
  let anchorWall = 0;
  let anchorMedia = 0;
  let last = 0;
  let running = false;
  return {
    now(mediaTime, isRunning) {
      if (!isRunning) {
        running = false;
        last = mediaTime;
        return last;
      }
      const wall = performance.now();
      let est = anchorMedia + (wall - anchorWall) / 1000;
      if (!running || Math.abs(est - mediaTime) > 0.08) {
        anchorWall = wall;
        anchorMedia = mediaTime;
        est = mediaTime;
        running = true;
      }
      last = est;
      return est;
    },
  };
}

// ─── 고르기 창 — 썸네일만 보고 고른다 ─────────────────────────────
function specText(f) {
  if (!f || !f.width) return '';
  return `${f.width}×${f.height} · ${Math.round(f.fps)}fps`;
}

// 고른 묶음의 key 를 돌려준다. 닫으면 null.
export async function openLoopPicker(currentKey = null) {
  const r = await fetch('/api/loops');
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(1100px,92vw);max-height:86vh;overflow:auto;background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#333);border-radius:10px;padding:18px;color:var(--text,#eee);';
    const close = (key) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(key);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:12px;margin-bottom:12px;';
    head.innerHTML = `<b style="font-size:15px;">🎞 배경 루프 영상 고르기</b><span style="font-size:11px;color:var(--text-dim,#999);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>`;
    head.querySelector('span').textContent = j.dir;
    box.appendChild(head);

    if (!j.loops.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:40px;text-align:center;color:var(--text-dim,#999);';
      empty.textContent = '폴더에 루프 영상이 없습니다. ClipLoop Studio 에서 내보내면 여기에 나타납니다.';
      box.appendChild(empty);
    }

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;';
    for (const loop of j.loops) {
      const usable = !!loop.use;
      const card = document.createElement('div');
      const picked = loop.key === currentKey;
      card.style.cssText = `border:2px solid ${picked ? 'var(--jazz-gold,#D4AF37)' : 'var(--border,#333)'};border-radius:8px;overflow:hidden;background:var(--bg-input,#111);cursor:${usable ? 'pointer' : 'default'};opacity:${usable ? 1 : 0.5};`;
      const img = document.createElement('img');
      img.src = `/api/loops/thumb?key=${encodeURIComponent(loop.key)}`;
      img.loading = 'lazy';
      img.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#000;';
      const info = document.createElement('div');
      info.style.cssText = 'padding:8px 10px;font-size:12px;line-height:1.5;';
      const name = document.createElement('div');
      name.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      name.textContent = loop.key;
      const spec = document.createElement('div');
      spec.style.cssText = 'color:var(--text-dim,#999);';
      if (!usable) spec.textContent = '저장하는 중…';
      else if (loop.upscaled) spec.innerHTML = `<span style="color:var(--jazz-gold,#D4AF37);">업스케일본</span> ${specText(loop.upscaled)}`;
      else spec.textContent = `원본만 ${specText(loop.original)} — 업스케일본 없음`;
      if (usable && loop.writing) spec.innerHTML += ' <span style="color:#e0a040;">(다른 파일 저장 중)</span>';
      info.append(name, spec);
      card.append(img, info);
      if (usable) card.addEventListener('click', () => close(loop.key));
      grid.appendChild(card);
    }
    box.appendChild(grid);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
