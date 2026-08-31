import { prisma } from "@/lib/prisma";
import type { TaxInvoiceDirection, TaxInvoiceRow } from "@/lib/barobill";

// 매출은 I(ncome), 매입은 O(utcome) 접두어 + 5자리 순번.
const PREFIX: Record<TaxInvoiceDirection, string> = { sales: "I", purchase: "O" };

export function formatTaxInvoiceNumber(direction: TaxInvoiceDirection, seq: number): string {
  return `${PREFIX[direction]}${String(seq).padStart(5, "0")}`;
}

// 조회된 세금계산서들에 내부 관리번호를 붙인다(매출 I00001…, 매입 O00001…).
//
// 규칙:
//  - 이미 번호가 있는 건은 **절대 다시 매기지 않는다** — 관리번호가 도중에 바뀌면 그 번호로
//    남겨둔 다른 기록과 어긋난다.
//  - 아직 없는 건만 새로 부여하고, 한 번에 여러 건이면 **작성일자(같으면 승인번호) 순**으로
//    매겨서 같은 조회 결과 안에서는 오래된 것이 작은 번호를 받는다.
//  - 순번은 방향별로 독립이다(매출과 매입이 각자 1부터).
//
// 반환값은 승인번호 → 번호 맵이다. TaxInvoiceRow(바로빌 응답 타입)에 필드를 끼워넣지 않고
// 따로 돌려주는 이유는, 이 번호가 국세청/바로빌 데이터가 아니라 순전히 이 앱의 내부 번호라서다.
export async function assignTaxInvoiceNumbers(
  direction: TaxInvoiceDirection,
  rows: TaxInvoiceRow[]
): Promise<Record<string, string>> {
  if (rows.length === 0) return {};

  const ntsSendKeys = [...new Set(rows.map((r) => r.ntsSendKey).filter(Boolean))];
  if (ntsSendKeys.length === 0) return {};

  const existing = await prisma.taxInvoiceSeq.findMany({
    where: { ntsSendKey: { in: ntsSendKeys } },
    select: { ntsSendKey: true, number: true },
  });
  const result: Record<string, string> = {};
  for (const e of existing) result[e.ntsSendKey] = e.number;

  // 아직 번호가 없는 건들만, 작성일자 → 승인번호 순으로 정렬해서 순차 부여.
  const seen = new Set(existing.map((e) => e.ntsSendKey));
  const missing = rows
    .filter((r) => r.ntsSendKey && !seen.has(r.ntsSendKey))
    // 같은 승인번호가 rows에 두 번 들어오는 경우(병합 결과 등) 대비해 중복 제거
    .filter((r, i, arr) => arr.findIndex((x) => x.ntsSendKey === r.ntsSendKey) === i)
    .sort((a, b) => a.writeDate.localeCompare(b.writeDate) || a.ntsSendKey.localeCompare(b.ntsSendKey));
  if (missing.length === 0) return result;

  const last = await prisma.taxInvoiceSeq.findFirst({
    where: { direction },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  let nextSeq = (last?.seq ?? 0) + 1;

  for (const row of missing) {
    // 순번은 (direction, seq)가 unique라 경쟁 시 충돌할 수 있다 — 충돌하면 다음 번호로
    // 넘어가며 재시도한다(한 사용자 SQLite 환경에선 사실상 안 나지만 방어).
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const created = await prisma.taxInvoiceSeq.create({
          data: {
            ntsSendKey: row.ntsSendKey,
            direction,
            seq: nextSeq,
            number: formatTaxInvoiceNumber(direction, nextSeq),
          },
          select: { number: true },
        });
        result[row.ntsSendKey] = created.number;
        nextSeq++;
        break;
      } catch {
        // 이 승인번호가 이미 번호를 받았으면(동시 조회 등) 그 번호를 그대로 쓴다.
        const already = await prisma.taxInvoiceSeq.findUnique({
          where: { ntsSendKey: row.ntsSendKey },
          select: { number: true },
        });
        if (already) {
          result[row.ntsSendKey] = already.number;
          break;
        }
        nextSeq++; // seq가 겹친 경우 — 다음 번호로 재시도
      }
    }
  }

  return result;
}

// 이미 부여된 번호만 조회한다(새로 부여하지 않음). 조회 화면 외의 곳에서 번호를 보여줄 때 쓴다.
export async function getTaxInvoiceNumbers(ntsSendKeys: string[]): Promise<Record<string, string>> {
  if (ntsSendKeys.length === 0) return {};
  const rows = await prisma.taxInvoiceSeq.findMany({
    where: { ntsSendKey: { in: ntsSendKeys } },
    select: { ntsSendKey: true, number: true },
  });
  return Object.fromEntries(rows.map((r) => [r.ntsSendKey, r.number]));
}

// 이미 부여된 관리번호만 읽어온다(없는 건에는 새로 매기지 않는다) — 세금계산서 화면 밖에서
// (예: 일반전표 목록) "이 전표가 어느 세금계산서에서 왔는지"를 보여주는 용도다. 번호 부여는
// 세금계산서를 조회하는 시점에만 일어나야 하므로(assignTaxInvoiceNumbers 주석 참고) 여기서는
// 절대 쓰지 않는다.
export async function getTaxInvoiceNumbersByKeys(
  ntsSendKeys: (string | null | undefined)[]
): Promise<Record<string, string>> {
  const keys = [...new Set(ntsSendKeys.filter((k): k is string => Boolean(k)))];
  if (keys.length === 0) return {};
  const rows = await prisma.taxInvoiceSeq.findMany({
    where: { ntsSendKey: { in: keys } },
    select: { ntsSendKey: true, number: true },
  });
  const result: Record<string, string> = {};
  for (const r of rows) result[r.ntsSendKey] = r.number;
  return result;
}
