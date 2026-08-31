"use client";

import { useState } from "react";
import { formatAmount } from "@/lib/format";
import type { PnlSummary } from "@/lib/pnl";

const W = 900;
const H = 240;
const BASELINE_Y = 130;
const HALF_HEIGHT = 90;
const BAR_WIDTH = 22;
const SALE_COLOR = "#2a78d6";
const PURCHASE_COLOR = "#e34948";

// 월별 매출(위)/배분매입(아래)을 0선 기준 나비형 바 차트로 보여준다. 손익은 두 막대 길이
// 차이로 드러나고, 정확한 숫자는 호버 툴팁과 아래 표(접근성 대안)로 확인한다.
export function MonthlyPnlChart({ months }: { months: PnlSummary[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (months.length === 0) {
    return <div className="py-8 text-center text-sm text-muted">표시할 기간이 없습니다.</div>;
  }

  const colWidth = W / months.length;
  const maxAbs = Math.max(1, ...months.map((m) => Math.max(m.saleAmount, m.purchaseAmount)));
  const scale = HALF_HEIGHT / maxAbs;
  const hovered = hover !== null ? months[hover] : null;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SALE_COLOR }} />
          매출액
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PURCHASE_COLOR }} />
          배분매입액
        </span>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="월별 매출/배분매입 추이">
          <line x1={0} y1={BASELINE_Y} x2={W} y2={BASELINE_Y} stroke="var(--border)" strokeWidth={1} />
          {months.map((m, i) => {
            const x = i * colWidth + colWidth / 2 - BAR_WIDTH / 2;
            const saleH = Math.max(m.saleAmount * scale, m.saleAmount > 0 ? 2 : 0);
            const purchaseH = Math.max(m.purchaseAmount * scale, m.purchaseAmount > 0 ? 2 : 0);
            return (
              <g key={m.key}>
                <rect
                  x={x}
                  y={BASELINE_Y - saleH}
                  width={BAR_WIDTH}
                  height={saleH}
                  rx={4}
                  fill={SALE_COLOR}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((v) => (v === i ? null : v))}
                  onFocus={() => setHover(i)}
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                />
                <rect
                  x={x}
                  y={BASELINE_Y}
                  width={BAR_WIDTH}
                  height={purchaseH}
                  rx={4}
                  fill={PURCHASE_COLOR}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((v) => (v === i ? null : v))}
                  onFocus={() => setHover(i)}
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                />
                <text
                  x={i * colWidth + colWidth / 2}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--muted)"
                >
                  {m.label.slice(5)}월
                </text>
              </g>
            );
          })}
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg"
            style={{
              left: `${((hover! + 0.5) / months.length) * 100}%`,
              top: `${((BASELINE_Y - Math.max(hovered.saleAmount * scale, 2)) / H) * 100}%`,
            }}
          >
            <div className="font-medium text-fg">{hovered.label}</div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">매출액</span>
              <span className="num" style={{ color: SALE_COLOR }}>
                {formatAmount(hovered.saleAmount)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">배분매입액</span>
              <span className="num" style={{ color: PURCHASE_COLOR }}>
                {formatAmount(hovered.purchaseAmount)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-0.5">
              <span className="text-muted">손익</span>
              <span className={`num font-semibold ${hovered.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {formatAmount(hovered.profit)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
