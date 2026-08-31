import { prisma } from "@/lib/prisma";
import { monthOf } from "@/lib/format";
import { getSalePnlRows, groupByParty, monthlyTrendBuckets, type SalePnlRow, type PnlSummary } from "@/lib/pnl";

export type DashboardSummary = {
  thisMonth: { saleAmount: number; purchaseAmount: number; profit: number };
  allTime: { saleAmount: number; purchaseAmount: number; profit: number; count: number };
  customsOutstanding: number;
  trend: PnlSummary[];
  topParties: PnlSummary[];
  recentSales: SalePnlRow[];
};

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

// 대시보드 = 기존 화면들의 요약. 새 집계 규칙은 없고 손익(lib/pnl)·관세대납(lib/customs)
// 계산을 그대로 재사용해 한눈에 모아 보여주기만 한다.
export async function getDashboardSummary(monthsBack = 6): Promise<DashboardSummary> {
  const now = new Date();
  const rows = await getSalePnlRows();

  const thisMonthKey = monthOf(now);
  const thisMonthRows = rows.filter((r) => monthOf(r.date) === thisMonthKey);

  const advances = await prisma.customsAdvance.findMany({ include: { recoveries: true } });
  const customsOutstanding = sumBy(
    advances,
    (a) => a.amount - sumBy(a.recoveries, (r) => r.amount)
  );

  return {
    thisMonth: {
      saleAmount: sumBy(thisMonthRows, (r) => r.saleAmount),
      purchaseAmount: sumBy(thisMonthRows, (r) => r.purchaseAmount),
      profit: sumBy(thisMonthRows, (r) => r.profit),
    },
    allTime: {
      saleAmount: sumBy(rows, (r) => r.saleAmount),
      purchaseAmount: sumBy(rows, (r) => r.purchaseAmount),
      profit: sumBy(rows, (r) => r.profit),
      count: rows.length,
    },
    customsOutstanding,
    trend: monthlyTrendBuckets(rows, monthsBack, now),
    topParties: groupByParty(rows).slice(0, 5),
    recentSales: rows.slice(0, 5),
  };
}
