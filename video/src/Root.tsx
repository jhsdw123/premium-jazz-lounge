import React from 'react';
import { Composition } from 'remotion';
import { JazzVideo } from './JazzVideo';
import { Playlist, type TPlaylist } from './types';
import { FPS, WIDTH, HEIGHT } from './constants';
import playlistJson from '../public/jazz-playlist.json';

const playlist: TPlaylist = Playlist.parse(playlistJson);
const totalFrames = Math.max(1, Math.round(playlist.totalDurationSec * FPS));

export const Root: React.FC = () => (
  <Composition
    id="JazzVideo"
    component={JazzVideo}
    durationInFrames={totalFrames}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={{ playlist }}
  />
);
