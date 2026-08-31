import Link from "next/link";
import { getDashboardSummary } from "@/lib/dashboard";
import { formatAmount, formatDate } from "@/lib/format";
import { MonthlyPnlChart } from "@/components/MonthlyPnlChart";
import { TopPartyBars } from "@/components/TopPartyBars";
import { RecentSalesTable, TrendTable } from "@/components/RecentSalesTable";

export const dynamic = "force-dynamic";

function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "signed";
}) {
  const color = tone === "signed" ? (value >= 0 ? "text-pos" : "text-neg") : "text-fg";
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num mt-1 text-xl font-semibold ${color}`}>{formatAmount(value)}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const summary = await getDashboardSummary(6);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-fg">대시보드</h1>
        <p className="mt-1 text-sm text-muted">
          매출 작성일자 기준 손익 요약입니다. 관세대납은 별도 자금흐름이라 손익에는 포함되지
          않습니다.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="이번달 매출" value={summary.thisMonth.saleAmount} />
        <StatTile label="이번달 배분매입" value={summary.thisMonth.purchaseAmount} />
        <StatTile label="이번달 손익" value={summary.thisMonth.profit} tone="signed" />
        <StatTile label="누적 손익 (전체)" value={summary.allTime.profit} tone="signed" />
        <StatTile label="관세대납 미회수" value={summary.customsOutstanding} />
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-medium text-fg">최근 6개월 매출/배분매입 추이</div>
        <MonthlyPnlChart months={summary.trend} />

        <div className="mt-4 overflow-x-auto">
          <TrendTable
            rows={summary.trend.map((m) => ({
              key: m.key,
              label: m.label,
              saleAmount: m.saleAmount,
              purchaseAmount: m.purchaseAmount,
              profit: m.profit,
            }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 text-sm font-medium text-fg">거래처별 손익 Top 5</div>
          <TopPartyBars rows={summary.topParties} />
        </div>

        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-fg">최근 매출</span>
            <Link href="/vouchers" className="text-xs text-accent hover:underline">
              전체 보기
            </Link>
          </div>
          <RecentSalesTable
            rows={summary.recentSales.map((s) => ({
              saleId: s.saleId,
              dateStr: formatDate(s.date),
              blNo: s.blNo,
              partyCode: s.partyCode,
              partyName: s.partyName,
              profit: s.profit,
            }))}
          />
          {summary.recentSales.length === 0 && (
            <div className="py-8 text-center text-sm text-muted">등록된 매출이 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
