/**
 * Premium Jazz Lounge — 기본 템플릿 시드 (Phase 4-A)
 *
 * legacy/old-visualizer.html 의 디자인 기조 (다크 + gold + 네온 글로우) 를
 * pjl_templates 의 첫 default 행으로 INSERT.
 *
 * 멱등: 같은 name 의 템플릿이 이미 있으면 skip (UPDATE 하지 않음 — 사용자가
 * 수정한 값 보존). 새로 시드하려면 먼저 DB 에서 삭제하거나 name 변경.
 *
 * 사전조건: tools/migrations/0002_templates.sql 적용 완료.
 *
 * 사용:
 *   node tools/seed-default-template.mjs
 */

import { supabase } from '../lib/supabase.mjs';

const DEFAULT_TEMPLATE = {
  name: 'Jazz Classic Default',
  description: '기존 jazz 비주얼라이저 디자인 기반 — 다크 + gold + 네온 글로우',
  is_default: true,
  config_json: {
    canvas: {
      width: 1920,
      height: 1080,
      bgColor: '#0A0A0A',
      bgGradient: { type: 'radial', from: '#1A1A1A', to: '#050505' },
    },
    visualizer: {
      style: 'bars', // bars | wave | circular (Phase 4-C 에서 컴포넌트 추가)
      position: { x: 960, y: 800, anchor: 'center' },
      width: 1200,
      height: 200,
      color: '#D4AF37',
      glowIntensity: 0.6,
      barCount: 64,
      barGap: 4,
    },
    title: {
      text: '{{trackTitle}}', // 템플릿 변수
      position: { x: 960, y: 540, anchor: 'center' },
      fontSize: 72,
      fontFamily: 'Playfair Display, serif',
      color: '#FFFFFF', // ⚠️ 밝은 색만 안전 (어두운 색은 글로우 충돌로 흐려짐)
      textShadow: '0 0 20px rgba(212, 175, 55, 0.8)',
      maxWidth: 1600,
    },
    playlist: {
      enabled: true,
      position: { x: 60, y: 60, anchor: 'top-left' },
      fontSize: 18,
      fontFamily: 'Inter, sans-serif',
      color: '#D4AF37',
      itemSpacing: 6,
      maxItems: 15,
      currentHighlight: { color: '#FFFFFF', weight: 700 },
    },
    progressBar: {
      style: 'melody', // melody | horizon | needle | minimal
      position: { x: 960, y: 1020, anchor: 'center' },
      width: 1600,
      height: 6,
      bgColor: 'rgba(255,255,255,0.1)',
      fillColor: '#D4AF37',
    },
    clock: {
      enabled: true,
      position: { x: 1860, y: 60, anchor: 'top-right' },
      format: 'elapsed', // elapsed | remaining | wallclock
      fontSize: 16,
      color: '#888888',
    },
    // Loop 영상 자리 (Filmora 수동 마스킹용 가이드)
    loopVideoPlaceholder: {
      enabled: true,
      position: { x: 960, y: 540, anchor: 'center' },
      width: 1920,
      height: 1080,
      hint: '이 영역은 Filmora 에서 라인드로잉 Loop 영상으로 마스킹 됩니다',
    },
    // 안전 메모 (UI 에서 보여주기 위함)
    notes: {
      textColorWarning:
        '텍스트 색상은 #FFFFFF 등 밝은 색만 사용 권장. 어두운 색은 네온 글로우 효과와 충돌해 흐리게 보임.',
    },
  },
};

async function main() {
  console.log('🎷 기본 템플릿 시드 시작...');
  console.log(`   name: ${DEFAULT_TEMPLATE.name}`);

  // 멱등: 같은 name 존재 여부 확인
  const { data: existing, error: ferr } = await supabase
    .from('pjl_templates')
    .select('id, name, is_default, updated_at')
    .eq('name', DEFAULT_TEMPLATE.name)
    .maybeSingle();
  if (ferr) {
    console.error('❌ 조회 실패:', ferr.message);
    if (/relation .* does not exist/i.test(ferr.message)) {
      console.error('   → tools/migrations/0002_templates.sql 을 먼저 적용하세요.');
    }
    process.exit(1);
  }

  if (existing) {
    console.log(`✓ 이미 존재 (id=${existing.id}, is_default=${existing.is_default}). skip.`);
    console.log('  새로 시드하려면 DB 에서 먼저 삭제하거나 DEFAULT_TEMPLATE.name 을 바꾸세요.');
    process.exit(0);
  }

  // is_default=true 로 INSERT 한다면 기존 default 들 모두 false 로
  if (DEFAULT_TEMPLATE.is_default) {
    const { error: uerr } = await supabase
      .from('pjl_templates')
      .update({ is_default: false })
      .eq('is_default', true);
    if (uerr) {
      console.error('⚠ 기존 default 해제 실패:', uerr.message);
    }
  }

  const { data, error } = await supabase
    .from('pjl_templates')
    .insert(DEFAULT_TEMPLATE)
    .select('id, name, is_default')
    .single();
  if (error) {
    console.error('❌ INSERT 실패:', error.message);
    process.exit(1);
  }

  console.log(`✅ 시드 완료. id=${data.id}, name="${data.name}", is_default=${data.is_default}`);
  console.log('');
  console.log('   확인: curl http://localhost:4001/api/templates');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ 예외:', e);
  process.exit(1);
});
