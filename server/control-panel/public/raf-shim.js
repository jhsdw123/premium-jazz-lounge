// rAF shim — 창 가림(occlusion) / 백그라운드에서도 애니메이션 유지
//
// 문제: Chrome 은 창이 다른 창에 완전히 가려지거나 탭이 백그라운드로 가면
//   requestAnimationFrame 을 통째로 정지시킨다. 메인 렌더 루프(studio.js)는
//   setInterval 이라 살아있지만, AudioMotion(비주얼라이저)과 NowPlaying 애니메이션은
//   내부적으로 rAF 를 쓰기 때문에 얼어붙는다 → 멈춘 캔버스가 그대로 녹화됨.
//
// 해법: 네이티브 rAF 와 setTimeout 폴백을 경주시킨다.
//   - 창이 보일 때: rAF 가 먼저 발화 (vsync ~16ms) → 기존과 동일
//   - 가려졌을 때: rAF 가 영영 안 오므로 16ms 타이머가 대신 발화 → 계속 진행
//   먼저 발화한 쪽이 콜백을 실행하고 반대쪽을 취소한다 (중복 실행 없음).
//
// 전제: 오디오가 "소리 나는 상태"로 재생 중인 탭은 Chrome 이 백그라운드에서도
//   타이머를 throttle 하지 않는다 (녹화 중엔 항상 재생 중이므로 충족).
//   단, 탭 음소거(탭 우클릭 → 사이트 음소거)는 이 면제를 깨뜨림 — 절대 금지.
//   소리를 줄이고 싶으면 Windows 볼륨 믹서에서 브라우저 볼륨만 낮출 것.
//
// 이 파일은 classic script 로 module 스크립트들보다 먼저 로드되어야 함 (index.html).
(() => {
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);
  const FALLBACK_MS = 16; // 가려졌을 때도 ~60fps 유지

  let nextId = 1;
  const pending = new Map(); // shimId → { rafId, timerId }

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    const fire = () => {
      const p = pending.get(id);
      if (!p) return; // 이미 실행됐거나 취소됨
      pending.delete(id);
      nativeCAF(p.rafId);
      clearTimeout(p.timerId);
      cb(performance.now());
    };
    const rafId = nativeRAF(fire);
    const timerId = setTimeout(fire, FALLBACK_MS);
    pending.set(id, { rafId, timerId });
    return id;
  };

  window.cancelAnimationFrame = (id) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    nativeCAF(p.rafId);
    clearTimeout(p.timerId);
  };
})();
