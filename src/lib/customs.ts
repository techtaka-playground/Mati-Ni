import { prisma } from "@/lib/prisma";
import { getTaxInvoiceNumbersByKeys } from "@/lib/taxInvoiceNumbers";
import {
  getAllocationsByTargets,
  sumAllocated,
  isFullyAllocated,
  basisFor,
  runAutoMatch,
  type AllocBasis,
  type AllocationDetail,
} from "@/lib/bankAllocation";
import { parseDateInput } from "@/lib/format";

export type CustomsAdvanceRow = {
  id: string;
  saleId: string | null;
  blNo: string;
  // 입금(회수) 매칭에 실제로 쓰는 거래처 id — partyName/partyCode와 같은 값을 가리키지만
  // (전표에 직접 지정 or 매출에서 빌려옴) id 자체가 화면에 필요해서 따로 내려준다.
  recoveryPartyId: string | null;
  partyName: string | null;
  partyCode: string | null;
  // true면 이 거래처가 전표에 직접 지정된 게 아니라 B/L로 연결된 **매출에서 빌려온** 값이다.
  // 화면에서 "(매출)"로 표시해 직접 지정된 거래처와 구분한다.
  partyFromSale: boolean;
  // 지급처(실제로 돈을 받는 관세사·포워더 등) — 회수 대상 거래처(partyName)와 다를 수 있다.
  // 없으면 출금 매칭에 partyName을 그대로 쓴다(schema.prisma CustomsAdvance.payeePartyId 주석 참고).
  payeePartyId: string | null;
  payeePartyName: string | null;
  payeePartyCode: string | null;
  matched: boolean;
  // 세금계산서에서 등록된 건이면 그 세금계산서의 내부 관리번호(O00001 등). 직접 입력한 건은 null.
  taxInvoiceNo: string | null;
  // 입금(회수)은 2026-09-03부터 출금과 똑같이 BankAllocation 기반이다(예전엔 그 자리에서
  // 계산만 하고 저장하지 않았다) — 여러 은행거래에 나눠 배분될 수 있고, 완전히 배분돼야
  // 확정할 수 있다. 출금 확정과는 완전히 독립된 별도 확정이다(depositConfirmedAt).
  depositAllocations: AllocationDetail[];
  depositAllocatedTotal: number;
  depositFullyAllocated: boolean;
  depositBasis: AllocBasis | null;
  depositDate: string | null;
  depositAmount: number | null;
  depositConfirmedAt: string | null;
  depositConfirmedByEmail: string | null;
  // 출금(대납 지급)은 2026-08-31부터 BankAllocation 기반이다 — 여러 은행거래에 나눠 배분될 수
  // 있고, 완전히 배분돼야 확정할 수 있다(일반전표와 같은 규칙).
  withdrawAllocations: AllocationDetail[];
  withdrawAllocatedTotal: number;
  withdrawFullyAllocated: boolean;
  withdrawBasis: AllocBasis | null;
  withdrawDate: string | null;
  withdrawAmount: number | null;
  settlementConfirmedAt: string | null;
  settlementConfirmedByEmail: string | null;
  paidDate: Date;
  amount: number;
  // 외화로 수기입력된 건에만 채워진다("KRW"면 fxAmount/fxRate는 항상 null) — amount는
  // 이미 원화로 환산된 값이라 기존 로직(은행매칭·손익)은 그대로 amount만 쓰면 된다.
  currency: string;
  fxAmount: number | null;
  fxRate: number | null;
  note: string;
  recoveries: { id: string; date: Date; amount: number; note: string }[];
  recoveredTotal: number;
  outstanding: number;
};

export type CustomsAdvanceFilter = {
  start?: string; // "YYYY-MM-DD" — 청구일(paidDate) 기준, 포함
  end?: string; // "YYYY-MM-DD" — 포함(그날 끝까지)
};


// 관세대납 흐름: 특정 B/L을 대신해 낸 대납액과, 나눠서 회수한 내역을 함께 보여준다.
// 손익(매출-배분매입)과는 무관한 별도 자금흐름이라 여기서만 다룬다. blNo가 진짜 식별자라
// 매출이 아직 없어도(saleId=null) 존재할 수 있다.
export async function getCustomsAdvances(filter: CustomsAdvanceFilter = {}): Promise<CustomsAdvanceRow[]> {
  // 손익조회와 같은 방식: end는 그 날 끝까지 포함해야 하므로 다음날 자정 미만으로 비교한다.
  const dateFilter: { gte?: Date; lt?: Date } = {};
  if (filter.start) dateFilter.gte = parseDateInput(filter.start);
  if (filter.end) dateFilter.lt = new Date(parseDateInput(filter.end).getTime() + 24 * 60 * 60 * 1000);

  const advances = await prisma.customsAdvance.findMany({
    where: Object.keys(dateFilter).length > 0 ? { paidDate: dateFilter } : undefined,
    include: {
      sale: { include: { party: true } },
      party: true,
      payeeParty: true,
      recoveries: { orderBy: { date: "asc" } },
    },
    orderBy: { paidDate: "desc" },
  });

  // 세금계산서에서 등록된 건에는 그 관리번호를 함께 보여준다. 번호는 **읽기만** 한다
  // (부여는 세금계산서를 조회하는 시점에만 — getTaxInvoiceNumbersByKeys 주석 참고).
  const numbers = await getTaxInvoiceNumbersByKeys(advances.map((c) => c.ntsSendKey));

  // 출금(대납 지급)은 지급처(payeePartyId) 기준, 없으면 회수 대상 거래처로라도 찾는다 —
  // 둘이 다른 회사이기 때문이다(CustomsAdvance.payeePartyId 주석 참고).
  const withdrawEntries = advances.map((c) => ({
    kind: "customsAdvance" as const,
    targetId: c.id,
    amount: c.amount,
    partyId: c.payeePartyId ?? c.partyId ?? c.sale?.partyId ?? null,
    ntsSendKey: c.ntsSendKey,
  }));
  // 입금(회수)은 반대로 회수 대상 거래처(고객사) 기준이다 — payeePartyId(지급처)와는 무관하다.
  const depositEntries = advances.map((c) => ({
    kind: "customsAdvanceRecovery" as const,
    targetId: c.id,
    amount: c.amount,
    partyId: c.partyId ?? c.sale?.partyId ?? null,
    ntsSendKey: c.ntsSendKey,
  }));
  await runAutoMatch([...withdrawEntries, ...depositEntries]);
  const [allocByTarget, depositAllocByTarget] = await Promise.all([
    getAllocationsByTargets(
      "customsAdvance",
      advances.map((c) => c.id)
    ),
    getAllocationsByTargets(
      "customsAdvanceRecovery",
      advances.map((c) => c.id)
    ),
  ]);

  return advances.map((c) => {
    const recoveredTotal = c.recoveries.reduce((sum, r) => sum + r.amount, 0);
    const withdrawAllocations = allocByTarget.get(c.id) ?? [];
    const withdrawAllocatedTotal = sumAllocated(withdrawAllocations);
    const earliestAlloc = withdrawAllocations[0] ?? null;
    const depositAllocations = depositAllocByTarget.get(c.id) ?? [];
    const depositAllocatedTotal = sumAllocated(depositAllocations);
    const earliestDepositAlloc = depositAllocations[0] ?? null;
    return {
      id: c.id,
      saleId: c.saleId,
      blNo: c.blNo,
      recoveryPartyId: c.partyId ?? c.sale?.partyId ?? null,
      // 전표에 직접 지정된 거래처가 있으면 그걸 쓰고, 없으면(옛 데이터·미지정) B/L로 연결된
      // 매출의 거래처를 빌려 보여준다 — 예전에는 후자만 있었다.
      partyName: c.party?.name ?? c.sale?.party.name ?? null,
      partyCode: c.party?.code ?? c.sale?.party.code ?? null,
      partyFromSale: c.partyId === null && c.saleId !== null,
      payeePartyId: c.payeePartyId,
      payeePartyName: c.payeeParty?.name ?? null,
      payeePartyCode: c.payeeParty?.code ?? null,
      matched: c.saleId !== null,
      taxInvoiceNo: c.ntsSendKey ? (numbers[c.ntsSendKey] ?? null) : null,
      paidDate: c.paidDate,
      amount: c.amount,
      currency: c.currency,
      fxAmount: c.fxAmount,
      fxRate: c.fxRate,
      note: c.note,
      recoveries: c.recoveries,
      recoveredTotal,
      outstanding: c.amount - recoveredTotal,
      depositAllocations,
      depositAllocatedTotal,
      depositFullyAllocated: isFullyAllocated(c.amount, depositAllocatedTotal),
      depositBasis: depositAllocatedTotal > 0 ? basisFor(c.amount, depositAllocatedTotal) : null,
      depositDate: earliestDepositAlloc?.date ?? null,
      depositAmount: depositAllocatedTotal > 0 ? depositAllocatedTotal : null,
      depositConfirmedAt: c.depositConfirmedAt ? c.depositConfirmedAt.toISOString() : null,
      depositConfirmedByEmail: c.depositConfirmedByEmail,
      withdrawAllocations,
      withdrawAllocatedTotal,
      withdrawFullyAllocated: isFullyAllocated(c.amount, withdrawAllocatedTotal),
      withdrawBasis: withdrawAllocatedTotal > 0 ? basisFor(c.amount, withdrawAllocatedTotal) : null,
      withdrawDate: earliestAlloc?.date ?? null,
      withdrawAmount: withdrawAllocatedTotal > 0 ? withdrawAllocatedTotal : null,
      settlementConfirmedAt: c.settlementConfirmedAt ? c.settlementConfirmedAt.toISOString() : null,
      settlementConfirmedByEmail: c.settlementConfirmedByEmail,
    };
  });
}
