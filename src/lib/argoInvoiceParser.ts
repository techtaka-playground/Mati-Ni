import { PDFParse } from "pdf-parse";
import type { ParsedStatement, ParsedStatementLine } from "./purchaseStatementParser";

// ARGO/테크타카 로지스틱스가 발행하는 "INVOICE" 양식(예: 관세(DUTY) 대납 등 항목 1건짜리
// 단건 인보이스) 전용 파서. `purchaseStatementParser.ts`의 지출결의서 양식과 달리, 이 양식은
// HTML 표를 PDF로 찍어내는 방식이라 라벨(H B/L No, Voyage, ...)이 전부 한 덩어리로 먼저
// 나오고, 값(YLEX2607LGB1716, 627E, ...)은 그 뒤에 완전히 다른 순서로 나온다 — 그래서
// "N번째 줄=필드" 방식이 아니라, 라벨 뒤에 이어지는 라벨 전용 줄들(전부 "... :"로 끝남)을
// 건너뛰고 그다음 처음 나오는 순수 영숫자 코드 줄을 그 라벨의 값으로 본다. 이 인보이스는
// 통째로 항목 1건이므로 lines는 0건(인식 실패) 또는 1건만 반환한다.

const LABEL_ONLY_LINE_RE = /:\s*$/;
const CODE_RE = /^[A-Z0-9]{6,20}$/;
const BL_LIKE_RE = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{6,20}$/;

function findValueAfterLabel(textLines: string[], label: string): string | null {
  const labelIdx = textLines.findIndex((l) => l.trim().replace(/\s+/g, " ").startsWith(label));
  if (labelIdx === -1) return null;

  let i = labelIdx + 1;
  while (i < textLines.length && LABEL_ONLY_LINE_RE.test(textLines[i].trim())) i++;

  for (let j = i; j < Math.min(i + 10, textLines.length); j++) {
    const t = textLines[j].trim();
    if (CODE_RE.test(t)) return t;
  }
  return null;
}

// "238,969\tKRW\tTotal Amount" — 표 컬럼이 화면과 반대 순서로 뽑혀서 라벨이 맨 뒤에 온다.
function findTotalAmountKrw(textLines: string[]): number | null {
  for (const line of textLines) {
    const fields = line.split("\t").map((f) => f.trim());
    const last = fields[fields.length - 1];
    const prev = fields[fields.length - 2];
    if (last === "Total Amount" && prev === "KRW") {
      const n = Number(fields[0].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

export async function parseArgoInvoice(buffer: Buffer): Promise<ParsedStatement> {
  const empty: ParsedStatement = { partyName: null, groupNo: null, period: null, lines: [] };

  const parser = new PDFParse({ data: buffer });
  let text: string;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  // 이 양식 특유의 표지("B/L No", "Total Amount")가 둘 다 없으면 아예 다른 문서다.
  if (!/Total Amount/.test(text) || !/B\/L No/.test(text)) return empty;

  const textLines = text.split("\n");

  // "[C004] 주식회사올리브인터내셔널\t:\tCustomer" — 값·콜론·라벨 순서.
  const partyMatch = text.match(/\[[A-Za-z0-9]+\]\s*(\S+)\s*[:：]\s*Customer/);
  const partyName = partyMatch ? partyMatch[1].trim() : null;

  const dateMatch = text.match(/Inv\.?\s*Date\s+(\d{4}-\d{2}-\d{2})/);
  const period = dateMatch ? dateMatch[1] : null;

  const houseNo = findValueAfterLabel(textLines, "H B/L No");
  const masterNo = findValueAfterLabel(textLines, "M B/L No");
  const refNo = [houseNo, masterNo].find((v): v is string => !!v && BL_LIKE_RE.test(v)) ?? null;

  const amount = findTotalAmountKrw(textLines);

  if (!refNo || amount == null) return { partyName, groupNo: null, period, lines: [] };

  // masterNo는 refNo로 못 고른(즉 House와 별개인) 값일 때만 보조 식별자로 남긴다 — House가
  // 없어서 refNo 자체가 Master가 된 경우엔 중복이라 null.
  const altMasterNo = masterNo && masterNo !== refNo && BL_LIKE_RE.test(masterNo) ? masterNo : null;

  // 이 단건 INVOICE 양식에는 VAT 열이 따로 없다 — 읽은 Total을 그대로 공급가액으로 둔다.
  const lines: ParsedStatementLine[] = [
    { refNo, masterNo: altMasterNo, amount, vat: 0, supplyAmount: amount },
  ];
  return { partyName, groupNo: null, period, lines };
}
