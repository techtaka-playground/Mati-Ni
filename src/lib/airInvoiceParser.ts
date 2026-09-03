import { PDFParse } from "pdf-parse";
import type { ParsedStatement, ParsedStatementLine } from "./purchaseStatementParser";

// ARGO/테크타카 로지스틱스가 발행하는 **항공(AWB) "INVOICE"** 양식 전용 파서.
//
// `argoInvoiceParser.ts`(해상 B/L 인보이스)와 같은 회사의 같은 제목("INVOICE") 문서인데,
// 항공 건은 표기와 배치가 달라서 그 파서로는 한 줄도 못 읽는다:
//
//   해상: 라벨 줄 "H B/L No"  →  값이 몇 줄 뒤에 따로 나온다
//   항공: 라벨과 값이 **한 필드**에 붙어 있다 — "HAWB No DSC084969"
//
// 게다가 해상 파서의 가드가 `B/L No` 문구를 요구해서, `HAWB No`/`MAWB No`만 있는 항공 문서는
// 즉시 거부됐다(실제로 O00010이 이 때문에 "미인식"으로 남았다).
//
// 이 양식의 필드 순서도 **화면의 역순**이다. 금액 표는 이렇게 대응된다:
//   헤더: [VAT, Amount(KRW), Amount, Unit Price, QTY, Unit, Ex-Rate, Curr., Freight]
//   합계행: "0 | 3,063,059 | 2,009.09 | T o t a l"  →  field[0]=VAT, field[1]=원화 합계
// 그래서 합계행에서 원화 합계와 VAT를 함께 읽어 공급가액(합계−VAT)을 만든다.
//
// 인보이스 1장 = 화물 1건이므로 lines는 0건(인식 실패) 또는 1건만 반환한다.

// 라벨과 값이 붙어 있는 형태에서 값만 뽑는다. 값이 없으면(예: "MAWB No :") null.
function findInlineLabelValue(textLines: string[], label: string): string | null {
  for (const line of textLines) {
    for (const field of line.split("\t")) {
      const t = field.trim().replace(/\s+/g, " ");
      if (!t.startsWith(label)) continue;
      const rest = t.slice(label.length).replace(/^[:\s]+/, "").trim();
      if (rest) return rest;
    }
  }
  return null;
}

// 글자 사이에 공백을 넣어 찍는 합계행("T o t a l")을 알아보기 위해 공백을 지운 뒤 비교한다.
function squashed(v: string): string {
  return v.replace(/\s+/g, "").toLowerCase();
}

function parseNum(raw: string): number | null {
  const n = Number(raw.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// 합계행에서 [원화 합계, VAT]를 읽는다. SubTotal이 아니라 **Total** 행을 쓴다.
function findTotalRow(textLines: string[]): { amount: number; vat: number } | null {
  for (const line of textLines) {
    const fields = line.split("\t").map((f) => f.trim());
    const last = squashed(fields[fields.length - 1] ?? "");
    if (last !== "total") continue; // "subtotal"은 제외된다
    const vat = parseNum(fields[0] ?? "");
    const amount = parseNum(fields[1] ?? "");
    if (amount != null && amount > 0 && vat != null) return { amount, vat };
  }
  return null;
}

// "Total Amount KRW 3,063,059" 한 필드에서 금액만 뽑는다(합계행을 못 읽었을 때의 예비 경로).
function findTotalAmountInline(textLines: string[]): number | null {
  for (const line of textLines) {
    for (const field of line.split("\t")) {
      const m = field.trim().replace(/\s+/g, " ").match(/^Total Amount\s+[A-Z]{3}\s+([\d,]+)$/);
      if (m) {
        const n = parseNum(m[1]);
        if (n != null && n > 0) return n;
      }
    }
  }
  return null;
}

// 거래처: "[C005] 주식회사 이너시아 | : | Customer" — 역순이라 라벨이 맨 뒤, 값이 맨 앞이다.
// 앞에 붙은 내부 코드 "[C005]"는 거래처 마스터의 이름과 맞춰야 하므로 떼어낸다.
function findCustomer(textLines: string[]): string | null {
  for (const line of textLines) {
    const fields = line.split("\t").map((f) => f.trim());
    if (fields[fields.length - 1] !== "Customer") continue;
    const v = fields[0]?.replace(/^\[[^\]]*\]\s*/, "").trim();
    if (v) return v;
  }
  return null;
}

export async function parseAirInvoice(buffer: Buffer): Promise<ParsedStatement> {
  const empty: ParsedStatement = { partyName: null, groupNo: null, period: null, lines: [] };

  const parser = new PDFParse({ data: buffer });
  let text: string;
  try {
    text = (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }

  // 이 양식 특유의 표지가 없으면 아예 다른 문서다 — 억지로 읽어 잘못된 금액을 만들지 않는다.
  if (!/Total Amount/.test(text)) return empty;
  if (!/HAWB No|MAWB No/.test(text)) return empty;

  const textLines = text.split("\n");

  // 화물 식별자는 HAWB(House) 우선, 없으면 MAWB(Master). 둘 다 있으면 MAWB는 매출(B/L) 매칭
  // 시 refNo(HAWB)로 못 찾을 때 시도할 보조 식별자로 남긴다.
  const houseNo = findInlineLabelValue(textLines, "HAWB No");
  const mawbNo = findInlineLabelValue(textLines, "MAWB No");
  const refNo = houseNo ?? mawbNo;
  if (!refNo) return empty;
  const masterNo = mawbNo && mawbNo !== refNo ? mawbNo : null;

  const partyName = findCustomer(textLines);

  const total = findTotalRow(textLines);
  const amount = total?.amount ?? findTotalAmountInline(textLines);
  if (amount == null) return empty;
  const vat = total?.vat ?? 0;

  const lines: ParsedStatementLine[] = [
    { refNo, masterNo, amount, vat, supplyAmount: amount - vat },
  ];
  return { partyName, groupNo: null, period: null, lines };
}
