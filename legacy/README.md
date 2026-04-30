# Legacy — 옛날 jazz 비주얼라이저 백업

이 폴더는 옛날 HTML/Canvas 기반 jazz 비주얼라이저 백업.
**Phase 4-C 에서 Remotion 컴포넌트로 변환할 때 디자인/색상/위치 참고용.**

## 파일

- `old-visualizer.html` — 원본 단일 파일 비주얼라이저
  - 출처: `C:/Users/User/Desktop/Youtube_webapp/index.html` (2026-04-30 백업)
  - Canvas 기반 bars / wave / circular 비주얼라이저
  - 다크 + gold + 네온 글로우 디자인 기조
  - Progress bar (melody / horizon / needle / minimal 스타일)
  - 시계, 플레이리스트, 트랙 타이틀

## 사용 시점

| Phase | 어떻게 참조 |
|---|---|
| 4-A | 디자인 기조만 추출 → 첫 default 템플릿 JSON (`tools/seed-default-template.mjs`) |
| 4-C | 비주얼라이저 / progress bar / clock 컴포넌트 Remotion 으로 포팅 |

## 주의

- **`.gitignore` 에서 제외하지 말 것.** Phase 4 작업 동안 변환 참고 필요.
- **수정하지 말 것.** 원본 보존. 수정은 Remotion 컴포넌트에서.
- Phase 4-C 끝나면 archive 로 이동 가능.
