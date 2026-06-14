// 예약(scheduled) 업로드 영상 조회 — publishAt 이 미래인 것
import { google } from 'googleapis';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env.local') });

const oauth = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI
);
const tokenPath = resolve(__dirname, '..', 'secrets', 'youtube-token.json');
oauth.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
const yt = google.youtube({ version: 'v3', auth: oauth });

// 내 업로드 재생목록 id
const ch = await yt.channels.list({ part: ['contentDetails', 'snippet'], mine: true });
const uploads = ch.data.items[0].contentDetails.relatedPlaylists.uploads;
console.log('채널:', ch.data.items[0].snippet.title);

// 최근 업로드 50개 가져와서 video id 수집
const pl = await yt.playlistItems.list({ part: ['contentDetails'], playlistId: uploads, maxResults: 50 });
const ids = pl.data.items.map((i) => i.contentDetails.videoId);

// 상태 조회
const vids = await yt.videos.list({ part: ['snippet', 'status'], id: ids });
const now = Date.now();
const scheduled = vids.data.items.filter(
  (v) => v.status?.publishAt && new Date(v.status.publishAt).getTime() > now
);

console.log('\n===== 예약된 영상 (' + scheduled.length + '개) =====');
for (const v of scheduled) {
  console.log('\n[videoId] ' + v.id);
  console.log('  제목   :', v.snippet.title);
  console.log('  게시예정:', v.status.publishAt, '(KST ' + new Date(v.status.publishAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ')');
  console.log('  공개상태:', v.status.privacyStatus);
  console.log('  URL    : https://studio.youtube.com/video/' + v.id + '/edit');
}
