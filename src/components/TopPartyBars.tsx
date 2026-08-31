import { formatAmount } from "@/lib/format";
import type { PnlSummary } from "@/lib/pnl";

const BAR_COLOR = "#2a78d6";

// 거래처별 손익 Top5 — 한 계열(손익 크기)의 순위이므로 단일 색조 막대로 표현한다.
export function TopPartyBars({ rows }: { rows: PnlSummary[] }) {
  if (rows.length === 0) {
    return <div className="py-8 text-center text-sm text-muted">표시할 거래처가 없습니다.</div>;
  }

  const maxProfit = Math.max(1, ...rows.map((r) => Math.abs(r.profit)));

  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => {
        const widthPct = Math.max(2, (Math.abs(r.profit) / maxProfit) * 100);
        return (
          <div key={r.key} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-sm">
              {/* 막대차트는 열로 나눌 수 없으니 코드와 이름을 한 줄에 두지만, "[0001] 이름"처럼
                  묶지 않고 코드를 muted로 따로 세워 눈으로 구분되게 한다(표는 별도 열 — PnlSummary.code 참고). */}
              <span className="flex items-baseline gap-1.5">
                {r.code && <span className="num text-xs text-muted">{r.code}</span>}
                <span className="text-fg">{r.label}</span>
              </span>
              <span className={`num font-medium ${r.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {formatAmount(r.profit)}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-95">
              <div
                className="h-full rounded-full"
                style={{ width: `${widthPct}%`, background: r.profit >= 0 ? BAR_COLOR : "#e34948" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
