// 세금계산서 "비고"란에는 종종 "B/L:MJNGB26070308" 또는 "BL/NO:PRKS26060051외 3건" 같은
// 형태로 B/L 번호가 들어있다. AI 없이 정규식으로 1차 추출하고, 사용자가 화면에서 확인/수정한다.
// 의존성이 전혀 없는 순수 함수라 서버(actions.ts)와 클라이언트 컴포넌트 양쪽에서 그대로
// 임포트해도 안전하다(@/lib/prisma 같은 서버 전용 모듈이 섞여 들어가지 않는다).
export function extractBlNoFromRemark(remark: string): string {
  const match = remark.match(/B\s*\/?\s*L\s*\/?\s*(?:NO\.?)?\s*:?\s*([A-Z0-9-]{5,})/i);
  return match ? match[1].toUpperCase() : "";
}

// "PRKS26060051외 3건"처럼, 비고에 적힌 B/L 하나 말고 추가로 몇 건이 더 있는지("외 N건")
// 알려주는 표기를 읽는다 — 없으면 0.
export function extractAdditionalBlCount(remark: string): number {
  const match = remark.match(/외\s*(\d+)\s*건/);
  return match ? Number(match[1]) : 0;
}
