// 제목(17개 언어) + 태그 + 설명 제목줄 교체 적용. 게시예약/공개범위 미변경.
import { google } from 'googleapis';
import fs from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { TITLES, TAGS } from './new-meta.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env.local') });

const VIDEO_ID = 'qqIIJOkR64A';
const STAMP = process.argv[2] || 'manual'; // 백업 파일명용 타임스탬프 (외부 주입)

const oauth = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI
);
oauth.setCredentials(JSON.parse(fs.readFileSync(resolve(__dirname, '..', 'secrets', 'youtube-token.json'), 'utf8')));
const yt = google.youtube({ version: 'v3', auth: oauth });

// 1) 현재 상태 조회
const cur = await yt.videos.list({ part: ['snippet', 'localizations', 'status'], id: [VIDEO_ID] });
const v = cur.data.items?.[0];
if (!v) throw new Error('영상 없음: ' + VIDEO_ID);
const oldTitle = v.snippet.title;

// 2) 백업
const backupDir = resolve(__dirname, '..', 'secrets', 'yt-backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = resolve(backupDir, `${VIDEO_ID}_${STAMP}.json`);
fs.writeFileSync(backupPath, JSON.stringify({ id: VIDEO_ID, snippet: v.snippet, localizations: v.localizations, status: v.status }, null, 2));
console.log('백업 저장:', backupPath);

// 3) 설명 — 제목 반복 줄(옛 제목과 동일한 줄)만 새 영어 제목으로 교체
let desc = v.snippet.description || '';
if (desc.includes(oldTitle)) {
  desc = desc.replace(oldTitle, TITLES.en);
  console.log('설명 제목줄 교체 완료');
} else {
  console.log('⚠ 설명에서 옛 제목 줄 못 찾음 — 설명 description 변경 없이 진행');
}

// 4) localizations 갱신 (기존 description 현지화는 유지, title만 교체)
const newLoc = { ...(v.localizations || {}) };
for (const [lang, title] of Object.entries(TITLES)) {
  newLoc[lang] = { title, description: (v.localizations?.[lang]?.description) || '' };
}

// 5) update — snippet 은 categoryId 필수
await yt.videos.update({
  part: ['snippet', 'localizations'],
  requestBody: {
    id: VIDEO_ID,
    snippet: {
      title: TITLES.en,
      description: desc,
      tags: TAGS,
      categoryId: v.snippet.categoryId || '10',
      defaultLanguage: v.snippet.defaultLanguage || 'en',
    },
    localizations: newLoc,
  },
});

console.log('\n✅ 적용 완료');
console.log('  옛 제목:', oldTitle);
console.log('  새 제목:', TITLES.en);
console.log('  태그   :', TAGS.length + '개');
console.log('  현지화 :', Object.keys(newLoc).length + '개 언어');
