import { prisma } from "@/lib/prisma";
import { parseDateInput } from "@/lib/format";

export type SaleRow = {
  id: string;
  blNo: string;
  date: Date;
  partyId: string;
  partyName: string;
  partyCode: string | null;
  amount: number;
  currency: string;
  fxAmount: number | null;
  fxRate: number | null;
  note: string;
  ntsSendKey: string | null;
  purchaseAmount: number;
  profit: number;
  settlementConfirmedAt: Date | null;
  settlementConfirmedByEmail: string | null;
};

export type SaleDateFilter = {
  start?: string; // "YYYY-MM-DD" — 작성일자(date) 기준, 포함
  end?: string; // "YYYY-MM-DD" — 포함(그날 끝까지)
};

// 매출 목록 + 각 B/L에 배분된 매입액을 합산해 손익을 함께 보여준다(요구사항 5: 매출별 손익).
export async function getSalesWithPnl(filter: SaleDateFilter = {}): Promise<SaleRow[]> {
  // 손익조회와 같은 방식: end는 그 날 끝까지 포함해야 하므로 다음날 자정 미만으로 비교한다.
  const dateFilter: { gte?: Date; lt?: Date } = {};
  if (filter.start) dateFilter.gte = parseDateInput(filter.start);
  if (filter.end) dateFilter.lt = new Date(parseDateInput(filter.end).getTime() + 24 * 60 * 60 * 1000);

  const sales = await prisma.sale.findMany({
    where: Object.keys(dateFilter).length > 0 ? { date: dateFilter } : undefined,
    include: { party: true, allocations: true },
    orderBy: { date: "desc" },
  });

  return sales.map((s) => {
    const purchaseAmount = s.allocations.reduce((sum, a) => sum + a.amount, 0);
    return {
      id: s.id,
      blNo: s.blNo,
      date: s.date,
      partyId: s.partyId,
      partyName: s.party.name,
      partyCode: s.party.code,
      amount: s.amount,
      currency: s.currency,
      fxAmount: s.fxAmount,
      fxRate: s.fxRate,
      note: s.note,
      ntsSendKey: s.ntsSendKey,
      purchaseAmount,
      profit: s.amount - purchaseAmount,
      settlementConfirmedAt: s.settlementConfirmedAt,
      settlementConfirmedByEmail: s.settlementConfirmedByEmail,
    };
  });
}

// 매입 배분 화면·관세대납 화면에서 "어느 B/L에 연결할지" 고를 때 쓰는 목록.
export function getSaleOptions() {
  return prisma.sale.findMany({
    select: {
      id: true,
      blNo: true,
      date: true,
      amount: true,
      party: { select: { name: true } },
    },
    orderBy: { date: "desc" },
  });
}
