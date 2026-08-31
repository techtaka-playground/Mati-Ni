import Link from "next/link";
import { getCustomsAdvances } from "@/lib/customs";
import { getSaleOptions } from "@/lib/sales";
import { getParties } from "@/lib/parties";
import { CustomsQuickEntry } from "@/components/CustomsQuickEntry";
import { CustomsTable } from "@/components/CustomsTable";
import { DateModeFilterFields } from "@/components/DateModeFilterFields";
import { formatDate, monthRange } from "@/lib/format";
import { getCurrentUserFresh } from "@/lib/session";

export const dynamic = "force-dynamic";

type SP = Promise<{ start?: string; end?: string; month?: string; mode?: string }>;

export default async function CustomsPage({ searchParams }: { searchParams: SP }) {
  const user = await getCurrentUserFresh();
  if (!user?.canViewCustoms) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-lg font-semibold text-fg">관세전표</h1>
        <div className="card p-4 text-sm text-muted">
          이 탭을 열람할 권한이 없습니다. 관리자에게 문의하세요.
        </div>
      </div>
    );
  }

  const sp = await searchParams;
  const mode = sp.mode === "month" ? "month" : "day";
  const start = sp.start ?? "";
  const end = sp.end ?? "";
  const month = sp.month ?? "";

  const range = mode === "month" && month ? monthRange(month) : { start, end };
  const filterActive = Boolean(range.start || range.end);

  const [advances, sales, parties] = await Promise.all([
    getCustomsAdvances({ start: range.start || undefined, end: range.end || undefined }),
    getSaleOptions(),
    getParties(),
  ]);
  const saleOptions = sales.map((s) => ({
    id: s.id,
    blNo: s.blNo,
    dateStr: formatDate(s.date),
    partyName: s.party.name,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-fg">관세전표</h1>
        <CustomsQuickEntry
          saleOptions={saleOptions}
          parties={parties.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
        />
      </div>

      {/* 청구일(paidDate) 기준 기간 조회 — 손익조회와 같은 순수 GET 폼(별도 서버 액션 없이
          페이지를 다시 그리는 것만으로 충분하다, 2026-08-27). 일반전표와 같은 월/일 조회
          방식 전환을 더했다(2026-08-27). */}
      <form method="get" className="card flex flex-wrap items-end gap-3 p-4">
        <DateModeFilterFields defaultMode={mode} defaultMonth={month} defaultStart={start} defaultEnd={end} />
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          조회
        </button>
        {filterActive && (
          <Link href="/customs" className="rounded-md px-3 py-1.5 text-sm text-muted hover:text-fg">
            필터 초기화
          </Link>
        )}
      </form>

      <CustomsTable
        rows={advances}
        parties={parties.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
        isAdmin={user.role === "admin"}
      />
    </div>
  );
}
