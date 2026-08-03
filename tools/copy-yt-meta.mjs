// YouTube 영상 메타데이터 복사: SRC → DST
//   snippet(제목/설명/defaultLanguage/태그/categoryId) + localizations(언어별 번역) + status(예약시간 publishAt)
//   DST 현재 상태는 secrets/yt-backups/ 에 백업 후 덮어씀. SRC 는 손대지 않음.
//
// 사용: node tools/copy-yt-meta.mjs <SRC_ID> <DST_ID> [--apply]
//   --apply 없으면 dry-run (계획만 출력, 실제 변경 X)

import { google } from 'googleapis';
import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
config({ path: resolve(ROOT, '.env.local') });

const [SRC_ID, DST_ID] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
if (!SRC_ID || !DST_ID) {
  console.error('사용: node tools/copy-yt-meta.mjs <SRC_ID> <DST_ID> [--apply]');
  process.exit(1);
}

const TOKEN_PATH = resolve(ROOT, 'secrets/youtube-token.json');
const BACKUP_DIR = resolve(ROOT, 'secrets/yt-backups');

const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
);
oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')));
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

function fetchFull(id) {
  return youtube.videos
    .list({ part: ['snippet', 'localizations', 'status'], id: [id] })
    .then((r) => r.data.items?.[0]);
}

const src = await fetchFull(SRC_ID);
if (!src) { console.error('SRC 영상 없음:', SRC_ID); process.exit(1); }
const dst = await fetchFull(DST_ID);
if (!dst) { console.error('DST 영상 없음:', DST_ID); process.exit(1); }

const srcLangs = Object.keys(src.localizations || {});
console.log('── 복사 원본 (SRC) ──');
console.log('  id:', SRC_ID);
console.log('  title:', src.snippet?.title);
console.log('  desc:', (src.snippet?.description || '').length, '자');
console.log('  defaultLanguage:', src.snippet?.defaultLanguage);
console.log('  categoryId:', src.snippet?.categoryId);
console.log('  tags:', (src.snippet?.tags || []).length, '개');
console.log('  localizations:', srcLangs.length, '개 →', srcLangs.join(', '));
console.log('  status.privacyStatus:', src.status?.privacyStatus);
console.log('  status.publishAt:', src.status?.publishAt || '(없음)');
console.log('── 대상 (DST, 덮어쓰기 전) ──');
console.log('  id:', DST_ID);
console.log('  title:', dst.snippet?.title);
console.log('  desc:', (dst.snippet?.description || '').length, '자');
console.log('  localizations:', Object.keys(dst.localizations || {}).length, '개');
console.log('  status.publishAt:', dst.status?.publishAt || '(없음)');

// DST 에 쓸 update body — SRC 값 그대로 복사
const updateBody = {
  id: DST_ID,
  snippet: {
    title: src.snippet?.title || '',
    description: src.snippet?.description || '',
    defaultLanguage: src.snippet?.defaultLanguage || 'en',
    tags: src.snippet?.tags || [],
    categoryId: src.snippet?.categoryId || dst.snippet?.categoryId || '10', // 10 = Music
  },
  localizations: src.localizations || {},
};
const parts = ['snippet', 'localizations'];
if (src.status?.publishAt) {
  updateBody.status = { privacyStatus: 'private', publishAt: src.status.publishAt };
  parts.push('status');
}

if (!APPLY) {
  console.log('\n[DRY-RUN] --apply 없음. 실제 변경 안 함. 위 계획대로 복사됩니다.');
  console.log('  업데이트 파트:', parts.join(', '));
  console.log('  예약시간 복사:', src.status?.publishAt || '(없음 — status 변경 안 함)');
  process.exit(0);
}

// DST 현재 상태 백업
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(BACKUP_DIR, `${DST_ID}-before-copy-${stamp}.json`);
fs.writeFileSync(backupFile, JSON.stringify(dst, null, 2));
console.log('\n백업 저장:', backupFile);

await youtube.videos.update({ part: parts, requestBody: updateBody });
console.log('✅ DST 업데이트 완료');
console.log('  https://studio.youtube.com/video/' + DST_ID + '/edit');

// 검증
const after = await fetchFull(DST_ID);
console.log('── 검증 (DST, 덮어쓴 후) ──');
console.log('  title:', after.snippet?.title);
console.log('  desc:', (after.snippet?.description || '').length, '자');
console.log('  localizations:', Object.keys(after.localizations || {}).length, '개');
console.log('  status.privacyStatus:', after.status?.privacyStatus);
console.log('  status.publishAt:', after.status?.publishAt || '(없음)');
