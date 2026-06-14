// 새 제목/태그 초안 + 글자수 검증 (적용 X, 출력만)
export const TITLES = {
  en: 'Smooth 1940s Swing Jazz 🎶 Vintage Instrumental Music to Relax, Unwind & Study (Ad-Free) [Vol.1]',
  ko: '부드러운 1940년대 스윙 재즈 🎶 휴식·집중·공부를 위한 빈티지 연주곡 (광고 없음) [Vol.1]',
  ja: '心地よい1940年代スウィングジャズ 🎶 リラックス・集中・作業のためのヴィンテージ器楽曲 (広告なし) [Vol.1]',
  zh: '舒缓的1940年代摇摆爵士乐 🎶 适合放松、专注与学习的复古器乐 (无广告) [Vol.1]',
  'zh-Hant': '舒緩的1940年代搖擺爵士樂 🎶 適合放鬆、專注與學習的復古器樂 (無廣告) [Vol.1]',
  es: 'Suave Jazz Swing de los Años 40 🎶 Música Instrumental para Relajarse y Estudiar (Sin Ads) [Vol.1]',
  fr: 'Doux Jazz Swing des Années 40 🎶 Musique Instrumentale pour Détente & Travail (Sans Pub) [Vol.1]',
  de: 'Sanfter 1940er Swing Jazz 🎶 Vintage-Instrumentalmusik zum Entspannen & Lernen (Werbefrei) [Vol.1]',
  it: "Dolce Swing Jazz Anni '40 🎶 Musica Strumentale per Relax e Studio (Senza Pubblicità) [Vol.1]",
  pt: 'Suave Swing Jazz dos Anos 40 🎶 Música Instrumental para Relaxar e Estudar (Sem Anúncios) [Vol.1]',
  nl: 'Zachte 1940s Swing Jazz 🎶 Vintage Muziek om te Ontspannen & Studeren (Reclamevrij) [Vol.1]',
  ru: 'Мягкий свинг-джаз 1940-х 🎶 Винтажная музыка для отдыха и работы (Без рекламы) [Vol.1]',
  th: 'แจ๊สสวิงยุค 1940 ฟังสบาย 🎶 ดนตรีบรรเลงวินเทจเพื่อการผ่อนคลายและโฟกัส (ไม่มีโฆษณา) [Vol.1]',
  vi: 'Nhạc Swing Jazz 1940 Nhẹ Nhàng 🎶 Hòa Tấu Cổ Điển Để Thư Giãn & Học Tập (Không Quảng Cáo) [Vol.1]',
  id: 'Jazz Swing 1940-an Lembut 🎶 Musik Instrumental untuk Relaksasi & Belajar (Tanpa Iklan) [Vol.1]',
  ms: 'Jazz Swing 1940-an Lembut 🎶 Muzik Instrumental untuk Santai & Belajar (Tanpa Iklan) [Vol.1]',
  tl: 'Smooth 1940s Swing Jazz 🎶 Vintage Instrumental Music para Mag-relax at Mag-aral (Walang Ad) [Vol.1]',
};

export const TAGS = [
  '1940s jazz', 'swing jazz', 'vintage jazz', 'smooth jazz', 'relaxing jazz music',
  'instrumental jazz', 'jazz music', 'study music', 'work music', 'background music',
  'jazz cafe', 'coffee shop jazz', 'old jazz', 'nostalgic jazz', 'big band',
  'jazz instrumental', 'relaxing music', 'morning jazz', 'jazz lounge', 'ad free music',
];

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('new-meta.mjs')) {
  console.log('=== 제목 글자수 (max 100) ===');
  for (const [lang, t] of Object.entries(TITLES)) {
    const over = t.length > 100 ? '  ❌ 초과!' : '';
    console.log(String(lang).padEnd(8), String(t.length).padStart(3), t.slice(0, 60) + (t.length > 60 ? '…' : ''), over);
  }
  console.log('\n=== 태그 ' + TAGS.length + '개, 총 ' + TAGS.join(',').length + '자 (max 500) ===');
  console.log(TAGS.join(', '));
}
