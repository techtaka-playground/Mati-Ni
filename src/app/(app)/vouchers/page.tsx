import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSalesWithPnl } from "@/lib/sales";
import { getPurchasesWithAllocations } from "@/lib/purchases";
import { getParties } from "@/lib/parties";
import { getSaleOptions } from "@/lib/sales";
import { getTaxInvoiceNumbersByKeys } from "@/lib/taxInvoiceNumbers";
import { runAutoMatch, getAllocationsByTargets, sumAllocated, isFullyAllocated } from "@/lib/bankAllocation";
import { VoucherQuickEntry } from "@/components/VoucherQuickEntry";
import { DateModeFilterFields } from "@/components/DateModeFilterFields";
import { VoucherTable, type VoucherRow } from "@/components/VoucherTable";
import { formatDate, monthRange } from "@/lib/format";
import { getCurrentUserFresh } from "@/lib/session";

export const dynamic = "force-dynamic";

type SP = Promise<{ start?: string; end?: string; month?: string; mode?: string; kind?: string }>;

function toPendingRequestInfo(
  r: { id: string; reason: string; requestedByEmail: string; createdAt: Date } | undefined
): VoucherRow["pendingUnconfirmRequest"] {
  if (!r) return null;
  return { id: r.id, reason: r.reason, requestedByEmail: r.requestedByEmail, createdAt: r.createdAt.toISOString() };
}

export default async function VouchersPage({ searchParams }: { searchParams: SP }) {
  const user = await getCurrentUserFresh();
  if (!user?.canViewVouchers) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-lg font-semibold text-fg">일반전표</h1>
        <div className="card p-4 text-sm text-muted">
          이 탭을 열람할 권한이 없습니다. 관리자에게 문의하세요.
        </div>
      </div>
    );
  }

  const sp = await searchParams;
  const mode = sp.mode === "month" ? "month" : "day";
  const kind = sp.kind === "sale" || sp.kind === "purchase" ? sp.kind : "all";
  const start = sp.start ?? "";
  const end = sp.end ?? "";
  const month = sp.month ?? "";

  const range = mode === "month" && month ? monthRange(month) : { start, end };
  const filterActive = Boolean(range.start || range.end || kind !== "all");
  const dateFilter = { start: range.start || undefined, end: range.end || undefined };

  const [sales, purchases, parties, saleOptions, pendingRequests] = await Promise.all([
    kind === "purchase" ? Promise.resolve([]) : getSalesWithPnl(dateFilter),
    kind === "sale" ? Promise.resolve([]) : getPurchasesWithAllocations(dateFilter),
    getParties(),
    getSaleOptions(),
    prisma.voucherUnconfirmRequest.findMany({ where: { status: "pending" } }),
  ]);
  // 전표(kind+id) 하나당 대기 중인 해제 요청은 최대 1건이라 그대로 맵으로 만든다.
  const pendingRequestByVoucher = new Map(pendingRequests.map((r) => [`${r.kind}-${r.voucherId}`, r]));

  // 실제 입출금은 저장된 배분(BankAllocation)에서 읽는다(2026-08-31) — 완전히 미배분인 대상은
  // 페이지를 열 때마다 자동매칭을 한 번 더 시도하고(정확히 같은 금액·같은 거래처인 "확정"된
  // 거래만), 나머지는 화면에서 수기로 배분한다. **매출은 입금, 매입은 B/L 배분 단위로 출금**을
  // 찾는다 — 매입 한 건이 여러 B/L로 나뉘면 그중 일부만 먼저 출금되는 경우를 표현하기 위해
  // 배분(PurchaseAllocation) 단위로 매칭한다(전표 총액 단위가 아니다).
  await runAutoMatch([
    ...sales.map((s) => ({ kind: "sale" as const, targetId: s.id, amount: s.amount, partyId: s.partyId, ntsSendKey: s.ntsSendKey })),
    ...purchases.flatMap((p) =>
      p.allocations.map((a) => ({
        kind: "purchaseAllocation" as const,
        targetId: a.id,
        amount: a.amount,
        partyId: p.partyId,
        ntsSendKey: null, // 매입은 B/L별 배분 단위라 부가세 후보를 시도하지 않는다(bankAllocation.ts 참고)
      }))
    ),
  ]);
  const [saleAllocByTarget, purchaseAllocByTarget] = await Promise.all([
    getAllocationsByTargets(
      "sale",
      sales.map((s) => s.id)
    ),
    getAllocationsByTargets(
      "purchaseAllocation",
      purchases.flatMap((p) => p.allocations.map((a) => a.id))
    ),
  ]);

  // 세금계산서에서 등록된 전표에는 그 세금계산서의 내부 관리번호(I00001/O00001)를 함께 보여준다.
  const taxInvoiceNumbers = await getTaxInvoiceNumbersByKeys([
    ...sales.map((s) => s.ntsSendKey),
    ...purchases.map((p) => p.ntsSendKey),
  ]);

  const saleOptionRows = saleOptions.map((s) => ({
    id: s.id,
    blNo: s.blNo,
    dateStr: formatDate(s.date),
    partyName: s.party.name,
  }));

  // 매출은 구조상 B/L 1건 = 1행이라 그대로 1줄이다.
  const saleRows: VoucherRow[] = sales.map((s) => {
    const allocations = saleAllocByTarget.get(s.id) ?? [];
    const allocatedTotal = sumAllocated(allocations);
    return {
      id: s.id,
      settleId: s.id,
      date: s.date,
      kind: "sale" as const,
      partyId: s.partyId,
      partyName: s.partyName,
      partyCode: s.partyCode,
      taxInvoiceNo: s.ntsSendKey ? (taxInvoiceNumbers[s.ntsSendKey] ?? null) : null,
      blNo: s.blNo,
      allocLabel: "",
      amount: s.amount,
      currency: s.currency,
      fxAmount: s.fxAmount,
      fxRate: s.fxRate,
      note: s.note,
      locked: Boolean(s.ntsSendKey),
      blIndex: 0,
      blCount: 1,
      allocations,
      allocatedTotal,
      fullyAllocated: isFullyAllocated(s.amount, allocatedTotal),
      settlementConfirmedAt: s.settlementConfirmedAt ? s.settlementConfirmedAt.toISOString() : null,
      settlementConfirmedByEmail: s.settlementConfirmedByEmail,
      pendingUnconfirmRequest: toPendingRequestInfo(pendingRequestByVoucher.get(`sale-${s.id}`)),
    };
  });

  // 매입은 한 건이 여러 B/L에 배분될 수 있다(PurchaseAllocation) — 예전엔 "PRKS26060051 외 3건"
  // 한 줄로 접어서 보여줬는데, 그러면 어느 B/L에 얼마씩 들어갔는지 이 화면에서 알 수 없었다.
  // 그래서 **배분 1건 = 1행**으로 펼친다. 금액도 전표 총액이 아니라 그 B/L에 배분된 금액이므로,
  // 같은 전표의 행들을 더하면 전표 총액이 된다. 입출금 매칭·확정도 이제 이 B/L 배분 단위로
  // 각 줄마다 따로 이뤄진다(2026-08-31) — 수정·삭제만 전표(Purchase) 단위라 blIndex===0에 남는다.
  const purchaseRows: VoucherRow[] = purchases.flatMap((p) => {
    const allocations =
      p.allocations.length > 0
        ? p.allocations
        : [
            {
              id: "",
              saleId: null,
              blNo: "",
              amount: p.amount,
              matched: false,
              label: "",
              settlementConfirmedAt: null,
              settlementConfirmedByEmail: null,
            },
          ];
    const locked = Boolean(p.ntsSendKey) || allocations.length !== 1;
    return allocations.map((a, idx) => {
      const bankAllocs = a.id ? (purchaseAllocByTarget.get(a.id) ?? []) : [];
      const allocatedTotal = sumAllocated(bankAllocs);
      return {
        id: p.id,
        settleId: a.id,
        date: p.date,
        kind: "purchase" as const,
        partyId: p.partyId,
        partyName: p.partyName,
        partyCode: p.partyCode,
        taxInvoiceNo: p.ntsSendKey ? (taxInvoiceNumbers[p.ntsSendKey] ?? null) : null,
        blNo: a.blNo,
        allocLabel: "label" in a ? a.label : "",
        amount: a.amount,
        currency: p.currency,
        fxAmount: p.fxAmount,
        fxRate: p.fxRate,
        note: p.note,
        locked,
        blIndex: idx,
        blCount: allocations.length,
        allocations: bankAllocs,
        allocatedTotal,
        fullyAllocated: isFullyAllocated(a.amount, allocatedTotal),
        settlementConfirmedAt: a.settlementConfirmedAt ? a.settlementConfirmedAt.toISOString() : null,
        settlementConfirmedByEmail: a.settlementConfirmedByEmail,
        pendingUnconfirmRequest: a.id
          ? toPendingRequestInfo(pendingRequestByVoucher.get(`purchaseAllocation-${a.id}`))
          : null,
      };
    });
  });

  // 정렬은 날짜 내림차순이지만, 같은 전표에서 펼쳐진 행들은 반드시 붙어 있어야 한다(전표 id →
  // 배분 순서). 그래서 날짜가 같을 때는 id, 그 다음 blIndex로 이어서 정렬한다.
  const rows: VoucherRow[] = [...saleRows, ...purchaseRows].sort((a, b) => {
    const byDate = b.date.getTime() - a.date.getTime();
    if (byDate !== 0) return byDate;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.blIndex - b.blIndex;
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-fg">일반전표</h1>
        <VoucherQuickEntry parties={parties} saleOptions={saleOptionRows} />
      </div>

      {/* 작성일자(date) 기준 기간 조회 — 관세전표·손익조회와 같은 순수 GET 폼(별도 서버
          액션 없이 페이지를 다시 그리는 것만으로 충분하다, 2026-08-27). 일/월 단위 선택과
          구분(매출·매입) 필터를 더했다(2026-08-27). */}
      <form method="get" className="card flex flex-wrap items-end gap-3 p-4">
        <DateModeFilterFields defaultMode={mode} defaultMonth={month} defaultStart={start} defaultEnd={end}>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">구분</label>
            <select
              name="kind"
              defaultValue={kind}
              className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
            >
              <option value="all">전체</option>
              <option value="sale">매출</option>
              <option value="purchase">매입</option>
            </select>
          </div>
        </DateModeFilterFields>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          조회
        </button>
        {filterActive && (
          <Link href="/vouchers" className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg">
            필터 초기화
          </Link>
        )}
      </form>

      <div className="card overflow-x-auto p-4">
        <VoucherTable rows={rows} parties={parties} isAdmin={user.role === "admin"} />

        {rows.length === 0 && (
          <div className="py-8 text-center text-sm text-muted">등록된 전표가 없습니다.</div>
        )}
      </div>
    </div>
  );
}
