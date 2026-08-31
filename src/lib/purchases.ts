import { prisma } from "@/lib/prisma";
import { parseDateInput } from "@/lib/format";

export type PurchaseRow = {
  id: string;
  date: Date;
  partyId: string;
  partyName: string;
  partyCode: string | null;
  amount: number;
  note: string;
  ntsSendKey: string | null;
  allocations: {
    id: string;
    saleId: string | null;
    blNo: string;
    amount: number;
    matched: boolean;
    label: string; // 세금계산서에 없는 금액 줄의 명칭(부가세·영세율 등). 세금계산서 대상 줄은 빈 값.
    // 일반전표의 "출금 완료(1단계) → 확정(2단계)" — B/L 배분 단위로 각각 확정한다(2026-08-31,
    // 매입 한 건이 여러 B/L로 나뉘면 일부만 먼저 출금되는 경우를 표현하려고 Purchase가 아니라
    // 여기로 내렸다).
    settlementConfirmedAt: Date | null;
    settlementConfirmedByEmail: string | null;
  }[];
  allocatedTotal: number;
};

export type PurchaseDateFilter = {
  start?: string; // "YYYY-MM-DD" — 매입일자(date) 기준, 포함
  end?: string; // "YYYY-MM-DD" — 포함(그날 끝까지)
};

// 매입 목록 + 각 매입이 어느 B/L에 얼마씩 배분되었는지(수기 배분 결과)를 함께 보여준다.
// 배분은 blNo로 저장되고, 그 번호의 매출이 아직 없으면 saleId=null(미매칭)인 채로 남는다 —
// 매입을 매출보다 먼저 등록했을 때의 정상적인 중간 상태다.
export async function getPurchasesWithAllocations(filter: PurchaseDateFilter = {}): Promise<PurchaseRow[]> {
  // 손익조회와 같은 방식: end는 그 날 끝까지 포함해야 하므로 다음날 자정 미만으로 비교한다.
  const dateFilter: { gte?: Date; lt?: Date } = {};
  if (filter.start) dateFilter.gte = parseDateInput(filter.start);
  if (filter.end) dateFilter.lt = new Date(parseDateInput(filter.end).getTime() + 24 * 60 * 60 * 1000);

  const purchases = await prisma.purchase.findMany({
    where: Object.keys(dateFilter).length > 0 ? { date: dateFilter } : undefined,
    include: {
      party: true,
      allocations: true,
    },
    orderBy: { date: "desc" },
  });

  return purchases.map((p) => {
    const allocations = p.allocations.map((a) => ({
      id: a.id,
      saleId: a.saleId,
      blNo: a.blNo,
      amount: a.amount,
      matched: a.saleId !== null,
      label: a.label,
      settlementConfirmedAt: a.settlementConfirmedAt,
      settlementConfirmedByEmail: a.settlementConfirmedByEmail,
    }));
    return {
      id: p.id,
      date: p.date,
      partyId: p.partyId,
      partyName: p.party.name,
      partyCode: p.party.code,
      amount: p.amount,
      note: p.note,
      ntsSendKey: p.ntsSendKey,
      allocations,
      allocatedTotal: allocations.reduce((sum, a) => sum + a.amount, 0),
    };
  });
}
