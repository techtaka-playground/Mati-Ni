import { prisma } from "@/lib/prisma";
import { monthOf, parseDateInput } from "@/lib/format";

export type SalePnlRow = {
  saleId: string;
  blNo: string;
  date: Date;
  partyId: string;
  partyName: string;
  partyCode: string | null;
  saleAmount: number;
  purchaseAmount: number;
  profit: number;
};

export type PnlSummary = {
  key: string;
  label: string;
  // 거래처별 묶음일 때만 채워지는 거래처 코드. label에 "[0001] "을 끼워넣지 않고 따로 두는 이유:
  // 코드와 이름을 항목으로 나눠 보여줘야 코드로 훑기 좋기 때문이다(월별 묶음은 null). 표는 별도
  // 열로, 막대차트(열이 없는 곳)는 코드를 muted로 앞에 세워서 구분한다.
  code: string | null;
  saleAmount: number;
  purchaseAmount: number;
  profit: number;
  count: number;
};

export type SalePnlFilter = {
  start?: string; // "YYYY-MM-DD" — 매출 작성일자(Sale.date) 기준, 포함
  end?: string; // "YYYY-MM-DD" — 포함(그날 끝까지)
  partyId?: string;
};

// 손익 = 매출액 - 그 B/L에 배분된 매입액. 관세대납은 별도 자금흐름이라 여기서 제외한다.
// 요구사항 5: 이 값을 매출 작성일자(Sale.date) 기준으로 월별/B/L별/거래처별로 묶어서 본다.
// 기간·거래처 필터는 집계 전 원본 매출 단계에서 걸러야 한다 — 그래야 월별/B/L별/거래처별
// 세 탭이 항상 같은 모집단을 보고 결과가 서로 어긋나지 않는다.
export async function getSalePnlRows(filter: SalePnlFilter = {}): Promise<SalePnlRow[]> {
  const dateFilter: { gte?: Date; lt?: Date } = {};
  if (filter.start) dateFilter.gte = parseDateInput(filter.start);
  if (filter.end) {
    // end는 그 날 끝까지 포함해야 하므로 다음날 자정 미만으로 비교한다.
    dateFilter.lt = new Date(parseDateInput(filter.end).getTime() + 24 * 60 * 60 * 1000);
  }

  const sales = await prisma.sale.findMany({
    where: {
      ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
      ...(filter.partyId ? { partyId: filter.partyId } : {}),
    },
    include: { party: true, allocations: true },
    orderBy: { date: "desc" },
  });

  return sales.map((s) => {
    const purchaseAmount = s.allocations.reduce((sum, a) => sum + a.amount, 0);
    return {
      saleId: s.id,
      blNo: s.blNo,
      date: s.date,
      partyId: s.partyId,
      partyName: s.party.name,
      partyCode: s.party.code,
      saleAmount: s.amount,
      purchaseAmount,
      profit: s.amount - purchaseAmount,
    };
  });
}

function summarize(
  rows: SalePnlRow[],
  keyOf: (r: SalePnlRow) => { key: string; label: string; code: string | null }
) {
  const map = new Map<string, PnlSummary>();
  for (const r of rows) {
    const { key, label, code } = keyOf(r);
    const existing =
      map.get(key) ?? { key, label, code, saleAmount: 0, purchaseAmount: 0, profit: 0, count: 0 };
    existing.saleAmount += r.saleAmount;
    existing.purchaseAmount += r.purchaseAmount;
    existing.profit += r.profit;
    existing.count += 1;
    map.set(key, existing);
  }
  return Array.from(map.values());
}

export function groupByMonth(rows: SalePnlRow[]): PnlSummary[] {
  return summarize(rows, (r) => {
    const key = monthOf(r.date);
    return { key, label: key, code: null };
  }).sort((a, b) => b.key.localeCompare(a.key));
}

export function groupByParty(rows: SalePnlRow[]): PnlSummary[] {
  // 코드와 이름을 합치지 않고 따로 돌려준다 — 표는 별도 열로(손익조회 거래처별), 막대차트는
  // 코드를 muted로 앞에 세워서(대시보드 Top5) 각자 알맞게 구분해 보여준다.
  return summarize(rows, (r) => ({
    key: r.partyId,
    label: r.partyName,
    code: r.partyCode,
  })).sort((a, b) => b.profit - a.profit);
}

// 대시보드 추이차트용 — 최근 monthsBack개월을 이번달까지 빈 달 없이 고정폭으로 채운다
// (데이터 없는 달은 0으로). groupByMonth는 데이터가 있는 달만 돌려주므로 그걸로는 안 됨.
export function monthlyTrendBuckets(rows: SalePnlRow[], monthsBack: number, now: Date): PnlSummary[] {
  const byMonth = new Map(groupByMonth(rows).map((r) => [r.key, r]));
  const months: PnlSummary[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = monthOf(d);
    months.push(
      byMonth.get(key) ?? { key, label: key, code: null, saleAmount: 0, purchaseAmount: 0, profit: 0, count: 0 }
    );
  }
  return months;
}
