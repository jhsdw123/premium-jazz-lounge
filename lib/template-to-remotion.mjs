/**
 * Phase 4-A: 스텁만. Phase 4-C 에서 본격 구현.
 *
 * pjl_templates.config_json (DB) → video/public/jazz-playlist.json (Remotion 입력)
 * 으로 변환하는 어댑터.
 *
 * 입력:
 *   template  · pjl_templates row (config_json 포함)
 *   tracks    · pjl_tracks rows (제목 join 된 상태 가정)
 *   videoTitle · 영상 전체 제목
 *
 * 출력: Remotion video/public/jazz-playlist.json 형식
 */

const FALLBACK_DURATION = 180;

function pickTitle(t, i) {
  if (t?.title?.title_en) return t.title.title_en;
  if (t?.title_en) return t.title_en;
  if (t?.original_filename) return t.original_filename;
  return `Track ${i + 1}`;
}

function pickDuration(t) {
  return Number(t?.duration_actual_sec) || Number(t?.duration_raw_sec) || FALLBACK_DURATION;
}

export function buildPlaylistJson({ template, tracks = [], videoTitle = 'Untitled' }) {
  // TODO Phase 4-C: 누적 startSec / endSec 계산, 실제 audioPath 매핑,
  // template config 를 Remotion 컴포넌트 props 로 normalize.
  let cursor = 0;
  const remotionTracks = tracks.map((t, i) => {
    const dur = pickDuration(t);
    const startSec = cursor;
    const endSec = startSec + dur;
    cursor = endSec;
    return {
      id: t.id,
      title: pickTitle(t, i),
      audioPath: `/tracks/${t.id}.mp3`, // Phase 4-C: 실제 확장자/경로 매핑
      durationSec: dur,
      startSec,
      endSec,
    };
  });

  return {
    videoTitle,
    tracks: remotionTracks,
    template: template?.config_json || {},
    totalDurationSec: cursor || 1,
  };
}
