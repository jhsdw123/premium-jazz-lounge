// 영상 메타 전체 덤프 (제목/설명/태그 + 16개 언어 현지화)
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
oauth.setCredentials(JSON.parse(fs.readFileSync(resolve(__dirname, '..', 'secrets', 'youtube-token.json'), 'utf8')));
const yt = google.youtube({ version: 'v3', auth: oauth });

const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node dump-meta.mjs <videoId> [videoId2...]'); process.exit(1); }

const r = await yt.videos.list({ part: ['snippet', 'localizations', 'status', 'statistics'], id: ids });
for (const v of r.data.items) {
  console.log('\n================ ' + v.id + ' ================');
  console.log('제목(default):', v.snippet.title);
  console.log('defaultLanguage:', v.snippet.defaultLanguage);
  console.log('게시예정/일시:', v.status.publishAt || v.snippet.publishedAt, '| privacy:', v.status.privacyStatus);
  console.log('조회수:', v.statistics?.viewCount, '| 좋아요:', v.statistics?.likeCount);
  console.log('\n--- 태그(' + (v.snippet.tags?.length || 0) + ') ---');
  console.log((v.snippet.tags || []).join(', '));
  console.log('\n--- 설명 ---');
  console.log(v.snippet.description);
  console.log('\n--- 현지화 제목 (' + Object.keys(v.localizations || {}).length + '개 언어) ---');
  for (const [lang, loc] of Object.entries(v.localizations || {})) {
    console.log('[' + lang + '] ' + loc.title);
  }
}
