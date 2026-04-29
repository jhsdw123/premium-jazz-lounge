/**
 * 곡 분석 — Phase 3-B 에서 ffprobe + silence detection 으로 본격 구현 예정.
 *
 * Phase 3-A: stub. 모든 값 null 반환.
 *   - bpm                : ffmpeg 의 ebur128 + 자동 추정 또는 essentia
 *   - durationRawSec     : ffprobe 의 format.duration
 *   - durationActualSec  : silenceremove + ffprobe 로 양끝 무음 제거 후 길이
 *
 * @param {Buffer | string} _input  파일 buffer 또는 디스크 경로
 * @returns {Promise<{ bpm: number|null, durationRawSec: number|null, durationActualSec: number|null }>}
 */
export async function analyzeTrack(_input) {
  // TODO Phase 3-B:
  //   1) buffer 면 임시 파일로 spool
  //   2) ffprobe -show_format -of json → duration_raw_sec
  //   3) ffmpeg -af silencedetect 로 양끝 silence 구간 → duration_actual_sec
  //   4) BPM 추정 (간단: ffmpeg + aubio CLI 또는 자체 onset detection)
  return {
    bpm: null,
    durationRawSec: null,
    durationActualSec: null,
  };
}
