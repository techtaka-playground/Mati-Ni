import { PDFParse } from "pdf-parse";

export type ParsedStatementLine = {
  refNo: string;
  // House No와 별개로 Master No가 인쇄돼 있으면 그 값. 없으면 null. 매출(B/L) 매칭 시
  // refNo(House)로 못 찾으면 이 값으로도 시도한다 — 매출을 Master No로 등록한 경우가 있다.
  masterNo: string | null;
  // 명세서에 인쇄된 그 B/L의 합계(원화, **부가세 포함**).
  amount: number;
  // 그 B/L에 붙은 부가세. 명세서의 "W/F / VAT" 열 중 원화 줄에 실린 값이다.
  vat: number;
  // amount - vat. 세금계산서 공급가액과 맞춰야 하는 값이라 여기서 미리 계산해 내려준다.
  supplyAmount: number;
};
export type ParsedStatement = {
  partyName: string | null;
  groupNo: string | null;
  period: string | null;
  lines: ParsedStatementLine[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseAmount(raw: string): number {
  const n = Number(raw.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

// House No/Master No별로 화물이 나열된 정형 명세서(예: 포워더 지출결의서 리스트) 전용 파서.
// API 호출 없이 pdf-parse로 텍스트만 뽑아 규칙 기반으로 읽는다 — 이 양식은 화물 한 건당
// 3줄이 고정 순서로 반복된다(①합계+MasterNo ②원화환산 비용줄 ③ETD/House No/거래처/날짜줄).
// ③번째 줄의 마지막 필드가 "YYYY-MM-DD" 날짜라는 게 화물 줄의 신호이고, 그 줄의 뒤에서
// 두 번째 필드가 House No(없으면 그 자리에 Master No가 대신 들어있음) — 두 값 다 여기서는
// 구분 없이 "refNo"로 취급한다. 합계 금액은 그 2줄 위(①번 줄)의 첫 필드에 있다.
//
// **pdf-parse가 뽑는 필드 순서는 화면에 보이는 것의 역순**이다. 그래서 각 줄의 앞쪽 필드가
// 화면의 오른쪽 끝 열이다. 원화 비용줄(②번)은 이렇게 대응된다:
//   field[0] = 그 줄의 Total(부가세 포함), field[1] = **VAT**, field[2] = OTH, field[3] = D/F, ...
//   ... field[10] = Weight, field[11] = POL/POD, (있으면) field[12] = **Master No**
// Master No는 그 줄의 맨 앞(화면 왼쪽 끝) 열이라 역순 배열에서는 맨 뒤에 붙는다 — 그래서
// Master No가 없는 줄은 필드가 12개, 있는 줄은 13개다. VAT(field[1])는 그 여부와 무관하게
// 위치가 고정이니 필드 개수는 "12개 이상"으로만 확인하면 된다(예전엔 정확히 12개만 허용해서
// Master No가 있는 줄은 VAT를 0으로 놓치는 버그가 있었다).
//
// VAT를 읽는 것이 중요하다: 명세서의 B/L별 합계는 **부가세를 포함한 금액**이라, 그대로 쓰면
// 세금계산서 공급가액과 딱 그 부가세만큼 어긋난다(실측: 합계 6,137,492 vs 공급가액 6,129,097,
// 차이 8,395 = VAT 합). 예전에는 이 차이를 비율로 눌러 담아 맞췄는데(임의 안분) B/L마다 금액이
// 왜곡됐다. 지금은 VAT를 빼서 supplyAmount를 만들므로 **안분 없이 공급가액과 정확히 일치한다.**
// 이 3줄 패턴과 안 맞는 PDF(다른 포워더/다른 양식)는 그냥 빈 배열을 반환한다 — 실패로 보고
// AI 추출 등 다른 방법으로 넘어가면 된다.
export async function parsePurchaseStatement(buffer: Buffer): Promise<ParsedStatement> {
  const parser = new PDFParse({ data: buffer });
  let text: string;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  const lines = text.split("\n");

  const partyMatch = text.match(/Customer\s*[:：]\s*(.+)/);
  const partyName = partyMatch ? partyMatch[1].trim() : null;

  const groupNoMatch = text.match(/Group No\s*[:：]\s*(\S+)/);
  const groupNo = groupNoMatch ? groupNoMatch[1].trim() : null;

  const periodMatch = text.match(/Period\s*[:：]\s*([^\n\t]+)/);
  const period = periodMatch ? periodMatch[1].trim() : null;

  const seen = new Set<string>();
  const results: ParsedStatementLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fields = lines[i].split("\t");
    const last = fields[fields.length - 1]?.trim();
    if (!last || !DATE_RE.test(last)) continue;

    const refNo = fields[fields.length - 2]?.trim();
    if (!refNo) continue;

    const totalLineIdx = i - 2;
    if (totalLineIdx < 0) continue;
    const amount = parseAmount(lines[totalLineIdx].split("\t")[0] ?? "");
    if (amount <= 0) continue;

    // 바로 위(②번) 원화 별원줄에서 VAT와(있으면) Master No를 읽는다. 이 양식의 원화줄은
    // 필드가 최소 12개이고 두 번째가 VAT다 — Master No가 있으면 맨 뒤에 한 필드가 더 붙는다
    // (위 주석 참고). 12개 미만이면 다른 양식이거나 줄이 밀린 것이므로 VAT를 0으로 두고
    // 넘어간다(틀린 값을 넣어서 금액을 망치는 것보다 안전하다).
    const krwFields = (lines[i - 1] ?? "").split("\t");
    const vat = krwFields.length >= 12 ? parseAmount(krwFields[1] ?? "") : 0;
    const masterNo = krwFields.length > 12 ? krwFields[krwFields.length - 1]?.trim() || null : null;

    const key = `${refNo}|${i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ refNo, masterNo, amount, vat, supplyAmount: amount - vat });
  }

  return { partyName, groupNo, period, lines: results };
}
