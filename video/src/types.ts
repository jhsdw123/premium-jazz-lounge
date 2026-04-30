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

// Phase 4-A: 느슨한 정의. Phase 4-C 에서 본격 z.object({...}) 로 좁힘.
export const TemplateConfig = z.any();
export type TTemplateConfig = z.infer<typeof TemplateConfig>;

export const Playlist = z.object({
  videoTitle: z.string(),
  tracks: z.array(TrackInput),
  template: TemplateConfig,
  totalDurationSec: z.number(),
});
export type TPlaylist = z.infer<typeof Playlist>;
