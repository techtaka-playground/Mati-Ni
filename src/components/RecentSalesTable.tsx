"use client";

import { useState } from "react";
import { SortableTh } from "@/components/SortableTh";
import { formatAmount } from "@/lib/format";
import { sortRowsBy, toggleSort, type SortState } from "@/lib/tableSort";

export type RecentSaleRow = {
  saleId: string;
  dateStr: string; // 서버에서 "YYYY-MM-DD"로 포맷해서 넘긴다
  blNo: string;
  partyCode: string | null;
  partyName: string;
  profit: number;
};

type RecentSortKey = "dateStr" | "blNo" | "partyCode" | "partyName" | "profit";

// 대시보드 "최근 매출"도 다른 표와 같이 열 정렬이 되도록 클라이언트 컴포넌트로 뽑았다.
export function RecentSalesTable({ rows }: { rows: RecentSaleRow[] }) {
  const [sort, setSort] = useState<SortState<RecentSortKey>>(null);
  const onSort = (k: RecentSortKey) => setSort((prev) => toggleSort(prev, k));
  const sorted = sortRowsBy(rows, sort, (r, k) => r[k]);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted">
          <SortableTh label="날짜" sortKey="dateStr" state={sort} onSort={onSort} />
          <SortableTh label="B/L" sortKey="blNo" state={sort} onSort={onSort} />
          <SortableTh label="거래처코드" sortKey="partyCode" state={sort} onSort={onSort} />
          <SortableTh label="거래처명" sortKey="partyName" state={sort} onSort={onSort} />
          <SortableTh label="손익" sortKey="profit" state={sort} onSort={onSort} align="right" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.saleId} className="border-b border-border/60">
            <td className="py-1.5 pr-2 whitespace-nowrap num text-muted">{s.dateStr}</td>
            <td className="py-1.5 pr-2 whitespace-nowrap num text-fg">{s.blNo}</td>
            <td className="py-1.5 pr-2 whitespace-nowrap num text-muted">{s.partyCode ?? "-"}</td>
            <td className="py-1.5 pr-2 text-fg">{s.partyName}</td>
            <td className={`num py-1.5 text-right font-medium ${s.profit >= 0 ? "text-pos" : "text-neg"}`}>
              {formatAmount(s.profit)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type TrendRow = {
  key: string;
  label: string;
  saleAmount: number;
  purchaseAmount: number;
  profit: number;
};

type TrendSortKey = "label" | "saleAmount" | "purchaseAmount" | "profit";

// 대시보드 "최근 6개월 추이" 표. 기본 순서는 위 차트와 같은 월 순서다 — 금액순으로 정렬하면
// 표와 차트의 순서가 달라지므로, 헤더를 세 번째로 누르면 원래(월) 순서로 되돌아간다.
export function TrendTable({ rows }: { rows: TrendRow[] }) {
  const [sort, setSort] = useState<SortState<TrendSortKey>>(null);
  const onSort = (k: TrendSortKey) => setSort((prev) => toggleSort(prev, k));
  const sorted = sortRowsBy(rows, sort, (r, k) => r[k]);

  return (
    <table className="w-full min-w-[500px] text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted">
          <SortableTh label="월" sortKey="label" state={sort} onSort={onSort} className="pl-2" />
          <SortableTh label="매출액" sortKey="saleAmount" state={sort} onSort={onSort} align="right" />
          <SortableTh label="배분매입액" sortKey="purchaseAmount" state={sort} onSort={onSort} align="right" />
          <SortableTh label="손익" sortKey="profit" state={sort} onSort={onSort} align="right" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((m) => (
          <tr key={m.key} className="border-b border-border/60">
            <td className="py-1.5 pl-2 num text-fg">{m.label}</td>
            <td className="num py-1.5 text-right text-fg">{formatAmount(m.saleAmount)}</td>
            <td className="num py-1.5 text-right text-muted">{formatAmount(m.purchaseAmount)}</td>
            <td
              className={`num py-1.5 pr-2 text-right font-medium ${m.profit >= 0 ? "text-pos" : "text-neg"}`}
            >
              {formatAmount(m.profit)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
