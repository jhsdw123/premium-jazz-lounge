/**
 * 보컬 검출 2차 검증 — Gemini 오디오 판정.
 *
 * check-vocals.mjs(Demucs) 는 recall 은 높지만 재즈 관악기(색소폰/트럼펫) 가
 * 보컬 스템으로 새서 오탐이 많음. 이 스크립트는 플래그된 구간을 원곡에서 잘라
 * Gemini 2.5 flash 에게 들려주고 "사람 목소리인가?" 를 판정시킨다.
 *
 *  - AI 가 오탐 판정 → pjl_tracks.has_vocals=false 자동 정정
 *  - AI 가 보컬 확인 → has_vocals=true 유지 (리뷰 페이지에서 사람이 최종 확정)
 *  - 사람이 이미 라벨링한 곡(labels.json)은 건드리지 않음
 *  - 판정은 data/vocal-check/ai-verdicts.json 에 기록 (results.json 은 스캐너 소유)
 *
 * 사용법:
 *   node tools/verify-vocals.mjs            # 미검증 flagged 전부 1회 처리
 *   node tools/verify-vocals.mjs --watch    # 3분마다 폴링 — 스캐너가 밤새 추가하는
 *                                           #   flagged 를 계속 검증. 30분간 새 작업
 *                                           #   없으면 자동 종료.
 *   node tools/verify-vocals.mjs --track-id 31    # 특정 트랙만 (재검증 포함)
 *
 * Gemini 무료 tier 15 RPM — 호출 사이 4500ms sleep (CLAUDE.md 규칙 4).
 */

import { promises as fs } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import supabase from '../lib/supabase.mjs';
import { downloadTrack } from '../lib/storage.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK_DIR = join(PROJECT_ROOT, 'data', 'vocal-check');
const TMP_DIR = join(WORK_DIR, 'tmp');
const RESULTS_FILE = join(WORK_DIR, 'results.json');
const LABELS_FILE = join(WORK_DIR, 'labels.json');
const VERDICTS_FILE = join(WORK_DIR, 'ai-verdicts.json');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_SLEEP_MS = 4500;
const MAX_SEGMENTS = 6;        // 곡당 Gemini 에 보낼 최대 구간 수
const SEG_PAD_SEC = 1.0;       // 구간 앞뒤 여유
const MAX_ERRORS = 3;          // 곡당 최대 재시도 횟수 (watch 루프 누적)
const METHOD = 'stem+mix-v2';  // 판정 방식 버전 (ai-verdicts.json 에 기록)
const FLAGGED_DIR = join(WORK_DIR, 'flagged');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCommand(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timeout`)); }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

/** 구간이 MAX_SEGMENTS 보다 많으면 앞쪽만 자르지 않고 전체에서 고르게 샘플링. */
function sampleSegments(segments) {
  if (segments.length <= MAX_SEGMENTS) return segments;
  const picked = [];
  for (let i = 0; i < MAX_SEGMENTS; i++) {
    picked.push(segments[Math.floor((i * (segments.length - 1)) / (MAX_SEGMENTS - 1))]);
  }
  return picked;
}

/**
 * 소스 파일에서 플래그 구간들만 잘라 하나의 mono mp3 클립으로 concat.
 */
async function extractSegmentsClip(srcFile, segments, outFile) {
  const segs = sampleSegments(segments);
  const inputs = [];
  const filters = [];
  segs.forEach((s, i) => {
    inputs.push('-ss', String(Math.max(0, s.start - SEG_PAD_SEC)), '-to', String(s.end + SEG_PAD_SEC), '-i', srcFile);
    filters.push(`[${i}:a]`);
  });
  const filterComplex = `${filters.join('')}concat=n=${segs.length}:v=0:a=1[out]`;
  await runCommand('ffmpeg', [
    '-y', '-hide_banner', '-nostats',
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-ac', '1', '-ar', '22050', '-b:a', '64k',
    outFile,
  ]);
}

/**
 * Gemini 에 오디오 클립 + 판정 프롬프트 전송. (lib/llm.mjs 는 텍스트 전용이라 직접 호출)
 *
 * stemClipFile 이 있으면 [보컬 스템 클립 + 원곡 클립] 2개를 함께 보냄.
 * 스템에서는 화음 코러스("ooh/aah" 패드)와 색소폰 bleed 가 확연히 구분되어
 * 원곡만 들려줄 때보다 판별력이 훨씬 높음. (원곡만 보내면 믹스에 묻힌
 * 백그라운드 코러스를 색소폰으로 오판하는 위음성 다수 발생 — v1 의 실패 원인)
 */
async function askGemini(mixClipFile, stemClipFile = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 가 .env.local 에 없음');

  const mixB64 = (await fs.readFile(mixClipFile)).toString('base64');
  const stemB64 = stemClipFile ? (await fs.readFile(stemClipFile)).toString('base64') : null;

  const prompt = [
    'You are auditing a jazz track that is SUPPOSED to be purely instrumental.',
    stemB64
      ? 'You will hear TWO clips. Clip 1 is the isolated "vocals" stem produced by source separation at the flagged moments (instruments sometimes bleed into it). Clip 2 is the original mix at the same moments.'
      : 'You will hear excerpts from the original mix at the flagged moments.',
    '',
    'Question: does this track contain any real HUMAN VOICE? This includes lead vocals, scat singing, humming, spoken word, vocal chops, AND quiet background choir pads — sustained "ooh"/"aah" harmony textures layered behind the band.',
    '',
    'How to judge:',
    stemB64
      ? '- Focus on Clip 1 (the stem). Sustained harmonic "ooh/aah" textures, layered harmony voices, breath+vibrato singing → HUMAN VOICE, even if barely audible in Clip 2.'
      : '- Listen for background choir pads behind the band, not just lead vocals.',
    stemB64
      ? '- If Clip 1 contains only a single melodic line that is clearly the saxophone/trumpet lead you also hear carrying the melody in Clip 2 (separation bleed), that is NOT a voice.'
      : '- A single expressive saxophone/trumpet melody line is NOT a voice.',
    '- Do not dismiss something as "voice-like instrument" if it sounds like multiple voices in harmony — jazz horns play distinct notes, choirs sing sustained blended chords.',
    '',
    'Answer JSON only: {"has_human_voice": true/false, "confidence": 0.0-1.0, "heard": "<one short sentence: what you actually heard>"}',
  ].join('\n');

  const parts = [{ text: prompt }];
  if (stemB64) parts.push({ inlineData: { mimeType: 'audio/mp3', data: stemB64 } });
  parts.push({ inlineData: { mimeType: 'audio/mp3', data: mixB64 } });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      // thinking 토큰이 maxOutputTokens 를 잠식해 JSON 이 잘리는 문제 방지
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          has_human_voice: { type: 'BOOLEAN' },
          confidence: { type: 'NUMBER' },
          heard: { type: 'STRING' },
        },
        required: ['has_human_voice', 'confidence', 'heard'],
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 300)}`);
  }
  const j = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return JSON.parse(text);
}

/**
 * 검증 대상: flagged && 사람 라벨 없음 && (AI 판정 없음 || 에러 재시도 여지 있음)
 */
async function collectTargets(trackIds, { recheckClean = false } = {}) {
  const [results, labels, verdicts] = await Promise.all([
    readJson(RESULTS_FILE), readJson(LABELS_FILE), readJson(VERDICTS_FILE),
  ]);
  const targets = [];
  for (const [idStr, r] of Object.entries(results)) {
    const id = Number(idStr);
    if (trackIds.length) {
      if (trackIds.includes(id)) targets.push({ id, segments: r.segments || [] });
      continue;
    }
    if (r.verdict !== 'flagged') continue;
    if (labels[id]) continue;
    const v = verdicts[id];
    if (v) {
      const retryError = v.verdict === 'error' && (v.error_count || 0) < MAX_ERRORS;
      // --recheck-clean: 구버전 방식(method 상이)으로 clean 판정된 곡을 새 방식으로 재검증
      const recheck = recheckClean && v.verdict === 'clean' && v.method !== METHOD;
      if (!retryError && !recheck) continue;
    }
    targets.push({ id, segments: r.segments || [] });
  }
  return { targets, verdicts, labels };
}

async function processOne(target, verdicts, labels = {}) {
  const { id, segments } = target;

  const { data: track, error } = await supabase
    .from('pjl_tracks')
    .select('id, storage_path, original_filename')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!track?.storage_path) throw new Error('트랙/storage_path 없음');

  const ext = extname(track.storage_path) || '.mp3';
  const srcFile = join(TMP_DIR, `verify-${id}${ext}`);
  const clipFile = join(TMP_DIR, `verify-${id}-clip.mp3`);
  const stemClipFile = join(TMP_DIR, `verify-${id}-stem.mp3`);

  try {
    const buf = await downloadTrack(track.storage_path);
    await fs.writeFile(srcFile, buf);
    await extractSegmentsClip(srcFile, segments, clipFile);

    // 스캐너가 남긴 보컬 스템 mp3 (flagged/<id>_vocals.mp3) 가 있으면 같은 구간을 잘라 함께 전송
    const stemFile = join(FLAGGED_DIR, `${id}_vocals.mp3`);
    let hasStem = false;
    try {
      await fs.access(stemFile);
      await extractSegmentsClip(stemFile, segments, stemClipFile);
      hasStem = true;
    } catch { /* 스템 없으면 원곡만으로 판정 */ }

    const ans = await askGemini(clipFile, hasStem ? stemClipFile : null);
    const conf = typeof ans.confidence === 'number' ? ans.confidence : 0;
    // "보컬 없음" 은 확신도 0.7 이상일 때만 자동 정정(clean) — 낮으면 unsure 로
    // 사람 리뷰에 남김. (진짜 보컬을 잘못 지우는 게 최악의 실패 모드라 보수적으로.)
    const verdict = ans.has_human_voice === true ? 'vocal' : (conf >= 0.7 ? 'clean' : 'unsure');

    verdicts[id] = {
      verdict,
      confidence: Number(conf.toFixed(2)),
      heard: ans.heard || null,
      checked_at: new Date().toISOString(),
      model: GEMINI_MODEL,
      method: METHOD,
    };
    await fs.writeFile(VERDICTS_FILE, JSON.stringify(verdicts, null, 2));

    // 사람 라벨이 있으면 DB 는 건드리지 않음 (사람 판정이 항상 우선 — --track-id 재검증 포함).
    // unsure 도 DB 미변경 (스캐너가 세팅한 has_vocals=true 유지 → 리뷰 대기).
    if (!labels[id] && verdict !== 'unsure') {
      const { error: upErr } = await supabase
        .from('pjl_tracks')
        .update({ has_vocals: verdict === 'vocal', updated_at: new Date().toISOString() })
        .eq('id', id);
      if (upErr) console.warn(`  ⚠ DB 업데이트 실패 #${id}: ${upErr.message}`);
    }

    const confStr = ` (conf ${verdicts[id].confidence})`;
    const dbNote = labels[id] ? ' (사람 라벨 있음 — DB 미변경)' : '';
    const icon = verdict === 'vocal' ? '🎤' : verdict === 'clean' ? '✅' : '❓';
    const desc = verdict === 'vocal' ? 'AI: 보컬 맞음' : verdict === 'clean' ? 'AI: 오탐 판정' : 'AI: 불확실 — 사람 리뷰 필요';
    console.log(`  ${icon} #${id} ${track.original_filename} — ${desc}${confStr}${dbNote} · "${ans.heard}"`);
  } catch (e) {
    const prev = verdicts[id];
    verdicts[id] = {
      verdict: 'error',
      error: e.message,
      error_count: (prev?.error_count || 0) + 1,
      checked_at: new Date().toISOString(),
    };
    await fs.writeFile(VERDICTS_FILE, JSON.stringify(verdicts, null, 2));
    console.error(`  ❌ #${id} 실패: ${e.message}`);
  } finally {
    await fs.unlink(srcFile).catch(() => {});
    await fs.unlink(clipFile).catch(() => {});
    await fs.unlink(stemClipFile).catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const watch = argv.includes('--watch');
  const recheckClean = argv.includes('--recheck-clean');
  const trackIds = [];
  const tIdx = argv.indexOf('--track-id');
  if (tIdx >= 0) trackIds.push(...String(argv[tIdx + 1]).split(',').map((s) => parseInt(s.trim(), 10)));

  await fs.mkdir(TMP_DIR, { recursive: true });

  let lastWorkAt = Date.now();
  const IDLE_EXIT_MS = 30 * 60 * 1000;
  const POLL_MS = 3 * 60 * 1000;

  for (;;) {
    const { targets, verdicts, labels } = await collectTargets(trackIds, { recheckClean });
    if (targets.length) {
      console.log(`검증 대상 ${targets.length}곡 (model=${GEMINI_MODEL})`);
      for (const t of targets) {
        await processOne(t, verdicts, labels);
        await sleep(GEMINI_SLEEP_MS);
      }
      lastWorkAt = Date.now();
    }
    if (!watch || trackIds.length) break;
    if (Date.now() - lastWorkAt > IDLE_EXIT_MS) {
      console.log('30분간 새 flagged 없음 — watch 종료.');
      break;
    }
    await sleep(POLL_MS);
  }

  // 요약
  const verdicts = await readJson(VERDICTS_FILE);
  const all = Object.values(verdicts);
  const vocal = all.filter((v) => v.verdict === 'vocal').length;
  const clean = all.filter((v) => v.verdict === 'clean').length;
  const unsure = all.filter((v) => v.verdict === 'unsure').length;
  const errs = all.filter((v) => v.verdict === 'error').length;
  console.log(`\nAI 검증 누적: 보컬 확인 ${vocal} / 오탐 정정 ${clean} / 불확실 ${unsure} / 에러 ${errs}`);
}

main().catch((e) => {
  console.error('치명적 오류:', e.message);
  process.exit(1);
});
