import Link from "next/link";
import { getSalePnlRows, groupByMonth, groupByParty } from "@/lib/pnl";
import { getParties } from "@/lib/parties";
import { formatDate, formatPartyLabel } from "@/lib/format";
import { PnlSummaryTable, PnlBlTable } from "@/components/PnlTables";
import { getCurrentUserFresh } from "@/lib/session";
import { PartySearchFormField } from "@/components/PartySearchFormField";

export const dynamic = "force-dynamic";

type SP = Promise<{ view?: string; start?: string; end?: string; party?: string }>;

const TABS = [
  { key: "month", label: "월별 손익" },
  { key: "bl", label: "B/L별 손익" },
  { key: "party", label: "거래처별 손익" },
];

// 탭을 바꿀 때도 지금 걸린 기간·거래처 필터가 유지되도록, 탭 링크마다 그 필터를 그대로
// 붙여준다 — 필터만 URL에 남고 탭은 다른 상태로 잃어버리면 "필터 걸고 다른 탭 보기"가 안 된다.
function buildQuery(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export default async function PnlPage({ searchParams }: { searchParams: SP }) {
  const user = await getCurrentUserFresh();
  if (!user?.canViewPnl) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-lg font-semibold text-fg">손익조회</h1>
        <div className="card p-4 text-sm text-muted">
          이 탭을 열람할 권한이 없습니다. 관리자에게 문의하세요.
        </div>
      </div>
    );
  }

  const sp = await searchParams;
  const view = sp.view === "party" ? "party" : sp.view === "bl" ? "bl" : "month";
  const start = sp.start ?? "";
  const end = sp.end ?? "";
  const partyId = sp.party ?? "";

  const [rows, parties] = await Promise.all([
    getSalePnlRows({ start: start || undefined, end: end || undefined, partyId: partyId || undefined }),
    getParties(),
  ]);

  const filterActive = Boolean(start || end || partyId);
  const selectedParty = parties.find((p) => p.id === partyId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">손익조회</h1>
      </div>

      {/* 순수 GET 폼 — 손익조회는 로컬 DB 집계라 별도 서버 액션 없이 페이지를 다시 그리는 것만으로
          충분히 빠르다(세금계산서/입출금내역처럼 외부 API를 부르는 화면과 다른 점). */}
      <form method="get" className="card flex flex-wrap items-end gap-3 p-4">
        <input type="hidden" name="view" value={view} />
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">시작일</label>
          <input
            type="date"
            name="start"
            defaultValue={start}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">종료일</label>
          <input
            type="date"
            name="end"
            defaultValue={end}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">거래처</label>
          <PartySearchFormField
            name="party"
            parties={parties}
            defaultValue={partyId}
            placeholder="전체 (코드/거래처명 검색)"
            className="w-56"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          조회
        </button>
        {filterActive && (
          <Link
            href={`/pnl${buildQuery({ view })}`}
            className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg"
          >
            필터 초기화
          </Link>
        )}
        {filterActive && (
          <span className="text-xs text-muted">
            {start || "처음"} ~ {end || "지금"}
            {selectedParty && ` · ${formatPartyLabel(selectedParty.code, selectedParty.name)}`}
          </span>
        )}
      </form>

      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/pnl${buildQuery({ view: t.key, start, end, party: partyId })}`}
            className={`rounded-t-md px-4 py-2 text-sm ${
              view === t.key
                ? "border border-b-0 border-border bg-surface font-medium text-fg"
                : "text-muted hover:text-fg"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <div className="card overflow-x-auto p-4">
        {view === "month" && (
          <PnlSummaryTable rows={groupByMonth(rows)} labelHeader="월" downloadLabel="월별손익" />
        )}
        {view === "party" && (
          <PnlSummaryTable
            rows={groupByParty(rows)}
            labelHeader="거래처명"
            codeHeader="거래처코드"
            downloadLabel="거래처별손익"
          />
        )}
        {view === "bl" && (
          // Date는 클라이언트 컴포넌트로 넘기지 않고 여기서 문자열로 포맷해서 보낸다.
          <PnlBlTable
            rows={rows.map((r) => ({
              saleId: r.saleId,
              date: formatDate(r.date),
              blNo: r.blNo,
              partyCode: r.partyCode,
              partyName: r.partyName,
              saleAmount: r.saleAmount,
              purchaseAmount: r.purchaseAmount,
              profit: r.profit,
            }))}
          />
        )}

        {rows.length === 0 && (
          <div className="py-8 text-center text-sm text-muted">
            {filterActive ? "이 조건에 맞는 매출이 없습니다." : "등록된 매출이 없습니다."}
          </div>
        )}
      </div>
    </div>
  );
}
