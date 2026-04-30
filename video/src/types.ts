import { z } from 'zod';

export const TrackInput = z.object({
  id: z.number(),
  title: z.string(),
  audioPath: z.string(),         // /tracks/xxx.mp3 (video/public/ 기준)
  durationSec: z.number(),
  startSec: z.number(),          // 영상 내 시작 시각
  endSec: z.number(),
});
export type TTrackInput = z.infer<typeof TrackInput>;

// Template config — 옛/새 schema 모두 지원해야 하므로 loose. adaptTemplate 가
// 양쪽 모두 새 schema (canvas + components[]) 로 정규화.
export const TemplateConfig = z.any();
export type TTemplateConfig = z.infer<typeof TemplateConfig>;

export const Playlist = z.object({
  videoTitle: z.string(),
  tracks: z.array(TrackInput),
  template: TemplateConfig,
  totalDurationSec: z.number(),
});
export type TPlaylist = z.infer<typeof Playlist>;
