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
import { matchPartyForRemark, type PartyLite } from "@/lib/bankPartyMatch";
import { parseDateInput } from "@/lib/format";

export type CustomsAdvanceRow = {
  id: string;
  saleId: string | null;
  blNo: string;
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
  // 입금(회수)은 이번 작업(2026-08-31) 범위 밖이라 예전처럼 계산으로만 보여준다 — 저장되는
  // 배분·확정 대상이 아니다.
  depositDate: string | null;
  depositAmount: number | null;
  depositBasis: AllocBasis | null;
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
  note: string;
  recoveries: { id: string; date: Date; amount: number; note: string }[];
  recoveredTotal: number;
  outstanding: number;
};

export type CustomsAdvanceFilter = {
  start?: string; // "YYYY-MM-DD" — 청구일(paidDate) 기준, 포함
  end?: string; // "YYYY-MM-DD" — 포함(그날 끝까지)
};

// "YYYYMMDDHHMMSS" → "YYYY-MM-DD"
function toDate(transDT: string): string {
  const d = transDT.replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : transDT;
}

// 입금(회수) 쪽은 저장되는 배분 대상이 아니라서(이번 범위 밖), 예전 bankMatch.ts와 같은
// "그 자리에서 계산" 방식을 그대로 유지한다 — 청구액(공급가액) 또는 세금계산서 부가세를 더한
// 금액과 정확히 같고 거래처가 같은 입금을 찾아 보여주기만 한다.
async function findDepositMatches(
  entries: { targetId: string; amount: number; partyId: string | null; ntsSendKey: string | null }[]
): Promise<Map<string, { date: string; amount: number; basis: AllocBasis } | null>> {
  const result = new Map<string, { date: string; amount: number; basis: AllocBasis } | null>();
  if (entries.length === 0) return result;

  const ntsSendKeys = entries.map((e) => e.ntsSendKey).filter((k): k is string => !!k);
  const [bankRows, parties, aliasRows, taxRecords] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { deposit: { gt: 0 } }, orderBy: { transDT: "asc" } }),
    prisma.party.findMany({ select: { id: true, code: true, name: true } }),
    prisma.bankPartyAlias.findMany({ include: { party: { select: { id: true, code: true, name: true } } } }),
    prisma.taxInvoiceRecord.findMany({
      where: { ntsSendKey: { in: [...new Set(ntsSendKeys)] } },
      select: { ntsSendKey: true, taxTotal: true },
    }),
  ]);
  const aliases = new Map<string, PartyLite>(aliasRows.map((a) => [a.normalized, a.party]));
  const taxByKey = new Map(taxRecords.map((r) => [r.ntsSendKey, r.taxTotal]));
  const bank = bankRows.map((b) => ({
    transRefKey: b.transRefKey,
    transDT: b.transDT,
    deposit: b.deposit,
    partyId: matchPartyForRemark(b.transRemark, parties, aliases)?.id ?? null,
  }));

  for (const e of entries) {
    if (!e.partyId) {
      result.set(e.targetId, null);
      continue;
    }
    const tax = e.ntsSendKey ? (taxByKey.get(e.ntsSendKey) ?? null) : null;
    const candidates: { value: number; basis: AllocBasis }[] = [];
    if (tax != null && Math.round(tax) !== 0) candidates.push({ value: e.amount + tax, basis: "withVat" });
    candidates.push({ value: e.amount, basis: "supply" });

    let found: { date: string; amount: number; basis: AllocBasis } | null = null;
    for (const c of candidates) {
      const hit = bank.find((b) => b.partyId === e.partyId && Math.round(b.deposit) === Math.round(c.value));
      if (hit) {
        found = { date: toDate(hit.transDT), amount: hit.deposit, basis: c.basis };
        break;
      }
    }
    result.set(e.targetId, found);
  }
  return result;
}

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
  await runAutoMatch(withdrawEntries);
  const allocByTarget = await getAllocationsByTargets(
    "customsAdvance",
    advances.map((c) => c.id)
  );

  const depositMatches = await findDepositMatches(
    advances.map((c) => ({
      targetId: c.id,
      amount: c.amount,
      partyId: c.partyId ?? c.sale?.partyId ?? null,
      ntsSendKey: c.ntsSendKey,
    }))
  );

  return advances.map((c) => {
    const recoveredTotal = c.recoveries.reduce((sum, r) => sum + r.amount, 0);
    const dep = depositMatches.get(c.id) ?? null;
    const withdrawAllocations = allocByTarget.get(c.id) ?? [];
    const withdrawAllocatedTotal = sumAllocated(withdrawAllocations);
    const earliestAlloc = withdrawAllocations[0] ?? null;
    return {
      id: c.id,
      saleId: c.saleId,
      blNo: c.blNo,
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
      note: c.note,
      recoveries: c.recoveries,
      recoveredTotal,
      outstanding: c.amount - recoveredTotal,
      depositDate: dep?.date ?? null,
      depositAmount: dep?.amount ?? null,
      depositBasis: dep?.basis ?? null,
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
