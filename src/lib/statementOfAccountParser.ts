import { PDFParse } from "pdf-parse";
import type { ParsedStatement, ParsedStatementLine } from "./purchaseStatementParser";

// 해외 파트너가 발행하는 "STATEMENT OF ACCOUNT" 양식(예: 미국/호주 파트너 정산 명세서) 전용
// 파서. purchaseStatementParser.ts의 국내 지출결의서 양식과 달리 화물 한 건이 한 줄로
// 끝나고(3줄 패턴 아님), 금액이 원화가 아니라 그 파트너의 통화(USD/AUD 등)로 찍혀 있다
// (2026-09-09, "해외명세서를 첨부하면 인식하게 해달라"는 요청).
//
// pdf-parse가 뽑는 필드 순서는 화면 표의 역순(오른쪽 열이 먼저 나온다) — 화면 기준 순서는
// ETD/ETA, D/C Note No, Master No, House No, Partner Inv No, Curr., Debit, Credit, Balance다.
// 실제 문서에서는 Partner Inv No가 항상 비어 있어(빈 칸은 필드 자체가 안 생긴다) 뒤에서부터
// [ETD/ETA, D/C Note No]를 떼고, 앞에서부터 [Balance, Credit, Debit, Curr.]를 뗀 다음, 남는
// 가운데 부분이 House No 1개(Master No 없음) 또는 House No + Master No 2개다.
export type ParsedForeignStatementLine = ParsedStatementLine;
export type ParsedForeignStatement = ParsedStatement & {
  // 명세서 전체에 찍힌 통화(예: "USD") — 화물 줄마다 다르게 섞이는 문서는 지원하지 않는다.
  // 못 찾았으면 null(이 양식이 아니거나 인식 실패).
  currency: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function parseAmount(raw: string): number {
  const n = Number(raw.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

export async function parseStatementOfAccount(buffer: Buffer): Promise<ParsedForeignStatement> {
  const empty: ParsedForeignStatement = { partyName: null, groupNo: null, period: null, currency: null, lines: [] };

  const parser = new PDFParse({ data: buffer });
  let text: string;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  // 이 양식 특유의 표지가 없으면 아예 다른 문서다.
  if (!/STATEMENT OF ACCOUNT/i.test(text) || !/House No/.test(text) || !/Credit/.test(text)) return empty;

  // "P0001 / CNR INTERNATIONAL NY\tPartner :" — 값(코드/이름)이 라벨보다 먼저 나온다.
  const partyMatch = text.match(/(\S+)\s*\/\s*([^\t\n]+?)\s*\t*Partner\s*:/);
  const partyName = partyMatch ? partyMatch[2].trim() : null;

  const groupNoMatch = text.match(/D\/C Group No\s*:\s*(\S+)/);
  const groupNo = groupNoMatch ? groupNoMatch[1].trim() : null;

  // 조회기간의 끝 날짜를 등록일자 기본값으로 제안한다(사용자가 팝업에서 바로 고칠 수 있다).
  const periodMatch = text.match(/Period\s*:\s*\d{4}-\d{2}-\d{2}\s*~\s*(\d{4}-\d{2}-\d{2})/);
  const period = periodMatch ? periodMatch[1] : null;

  const lines: ParsedStatementLine[] = [];
  let currency: string | null = null;
  const textLines = text.split("\n");
  for (const raw of textLines) {
    const fields = raw.split("\t").map((f) => f.trim());
    if (fields.length < 6) continue;

    const last = fields[fields.length - 1];
    if (!DATE_RE.test(last)) continue; // ETD/ETA가 있는 줄만 실제 화물 줄이다(합계·소계 줄 제외).

    const curr = fields[3];
    if (!CURRENCY_RE.test(curr)) continue; // "8"(H.B/L 건수) 같은 소계 줄 걸러내기.

    const credit = parseAmount(fields[1]);
    if (credit <= 0) continue;

    // 앞 4개(Balance/Credit/Debit/Curr.)와 뒤 2개(D/C Note No/ETD·ETA)를 뗀 나머지가
    // House No 하나 또는 House No+Master No 둘이다.
    const middle = fields.slice(4, fields.length - 2);
    if (middle.length < 1 || middle.length > 2) continue;
    const houseNo = middle[0];
    const masterNo = middle.length === 2 ? middle[1] : null;
    if (!houseNo) continue;

    if (!currency) currency = curr;
    lines.push({ refNo: houseNo, masterNo, amount: credit, vat: 0, supplyAmount: credit });
  }

  if (lines.length === 0) return empty;
  return { partyName, groupNo, period, currency, lines };
}
