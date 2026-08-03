import { randomUUID } from 'node:crypto';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3 } from '@aws-sdk/s3-request-presigner';
import { s3, S3_BUCKET } from './s3.mjs';
import { sanitizeFilename } from './track-utils.mjs';

// S3 호환 스토리지(R2/MinIO 등)가 application/octet-stream 을 거부하거나
// 잘못된 타입으로 저장하는 경우가 흔하므로 확장자 기반으로 audio MIME 추론.
const EXT_TO_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
};

function resolveContentType(mimeType, filename) {
  const mt = (mimeType || '').toLowerCase();
  // 신뢰할 수 있는 audio/* 또는 video/mp4 면 그대로 사용
  if (mt.startsWith('audio/') || mt === 'video/mp4') return mimeType;
  // 그 외 (octet-stream, x-empty, 빈 값) 는 확장자로 추론
  const ext = (filename || '').toLowerCase().match(/\.([^.\\\/]+)$/)?.[1];
  return EXT_TO_MIME[ext] || 'audio/mpeg';
}

/**
 * 곡 파일을 R2(S3 호환) 스토리지에 업로드.
 * 경로(Key): tracks/{uuid}_{sanitizedName}
 *
 * 반환값 형태는 기존 Supabase 버전과 동일하게 유지 (server.mjs 호환).
 * R2 버킷은 private 이므로 publicUrl 은 항상 null — 서빙은 getSignedUrl 로.
 *
 * @returns {{ path: string, publicUrl: string|null, contentType: string }}
 */
export async function uploadTrack(buffer, filename, mimeType = null) {
  const safe = sanitizeFilename(filename);
  const path = `tracks/${randomUUID()}_${safe}`;
  const contentType = resolveContentType(mimeType, filename);

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: path,
      Body: buffer,
      ContentType: contentType,
      CacheControl: '3600',
    })
  );

  return { path, publicUrl: null, contentType };
}

/**
 * 임의 객체 업로드 (트랙 외 — 예: 템플릿 배경 이미지).
 * @returns {{ path: string }}
 */
export async function uploadObject(key, buffer, { contentType, cacheControl = '3600' } = {}) {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );
  return { path: key };
}

/**
 * 객체 다운로드 → Buffer (예: ffprobe 분석용).
 */
export async function downloadTrack(storagePath) {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: storagePath })
  );
  if (!res.Body) throw new Error('빈 응답');
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * 객체 단일 삭제.
 */
export async function deleteTrack(storagePath) {
  if (!storagePath) return;
  await s3.send(
    new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: storagePath })
  );
}

/**
 * 객체 다중 삭제 (best-effort).
 */
export async function deleteTracks(storagePaths) {
  const paths = (storagePaths || []).filter(Boolean);
  if (!paths.length) return { removed: 0 };
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: { Objects: paths.map((Key) => ({ Key })), Quiet: true },
    })
  );
  return { removed: paths.length };
}

// S3 SigV4 presigned URL 최대 유효기간 = 7일. 초과 요청은 R2 가 거부하므로 클램프.
const MAX_PRESIGN_SEC = 7 * 24 * 60 * 60;

/**
 * 서명된 임시 URL 발급 (private 버킷용). 최대 7일로 제한됨(R2/SigV4 제약).
 */
export async function getSignedUrl(storagePath, expiresInSec = 3600) {
  const expiresIn = Math.min(expiresInSec, MAX_PRESIGN_SEC);
  return presignS3(
    s3,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: storagePath }),
    { expiresIn }
  );
}

/**
 * 스토리지 헬스체크 (버킷 접근 가능 여부). /api/health 용.
 * @returns {Promise<{ok: boolean, bucket: string, error?: string}>}
 */
export async function storageHealth() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    return { ok: true, bucket: S3_BUCKET };
  } catch (e) {
    return { ok: false, bucket: S3_BUCKET, error: e.message };
  }
}
