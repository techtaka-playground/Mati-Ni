"use client";

import { useState } from "react";
import { SortableTh } from "@/components/SortableTh";
import { formatAmount } from "@/lib/format";
import { sortRowsBy, toggleSort, type SortState, type SortValue } from "@/lib/tableSort";
import type { PnlSummary } from "@/lib/pnl";

// 손익조회의 세 탭 표를 클라이언트 컴포넌트로 뽑았다 — 열 정렬은 서버를 다시 부를 필요가 없는데
// 페이지가 서버 컴포넌트라 useState를 쓸 수 없었다. 집계는 계속 서버에서 하고 여기서는 정렬·
// 엑셀 다운로드만 한다.

// 매출액이 0이면 나눌 수 없다(0으로 나누기 방지) — 그런 행은 마진을 아예 표시하지 않는다.
function marginPct(profit: number, saleAmount: number): string {
  if (saleAmount === 0) return "-";
  return `${((profit / saleAmount) * 100).toFixed(1)}%`;
}

// 세금계산서/입출금내역 화면과 같은 방식(BOM + Blob) — 엑셀에서 한글이 깨지지 않는다.
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type SummarySortKey = "code" | "label" | "count" | "saleAmount" | "purchaseAmount" | "profit";

function summarySortValue(r: PnlSummary, key: SummarySortKey): SortValue {
  return r[key];
}

// codeHeader를 주면 코드 열이 앞에 하나 더 붙는다(거래처별 손익) — 거래처는 "[0001] 이름" 한 칸이
// 아니라 코드와 이름을 나눠서 보여준다. 월별 손익에는 코드가 없으므로 주지 않는다.
export function PnlSummaryTable({
  rows,
  labelHeader,
  codeHeader,
  downloadLabel,
}: {
  rows: PnlSummary[];
  labelHeader: string;
  codeHeader?: string;
  // 엑셀 다운로드 파일명에 쓸 구분자("월별손익"/"거래처별손익") — 안 주면 다운로드 버튼을 숨긴다.
  downloadLabel?: string;
}) {
  const [sort, setSort] = useState<SortState<SummarySortKey>>(null);
  const sorted = sortRowsBy(rows, sort, summarySortValue);
  const onSort = (k: SummarySortKey) => setSort((prev) => toggleSort(prev, k));

  // 합계는 정렬과 무관하게 전체 행을 더한 값이다(정렬은 순서만 바꾼다).
  const totals = rows.reduce(
    (acc, r) => ({
      saleAmount: acc.saleAmount + r.saleAmount,
      purchaseAmount: acc.purchaseAmount + r.purchaseAmount,
      profit: acc.profit + r.profit,
    }),
    { saleAmount: 0, purchaseAmount: 0, profit: 0 }
  );

  function handleDownload() {
    downloadCsv(
      `${downloadLabel ?? "손익"}_${new Date().toISOString().slice(0, 10)}.csv`,
      [codeHeader, labelHeader, "건수", "매출액", "배분매입액", "손익", "손익률"].filter(
        (h): h is string => Boolean(h)
      ),
      sorted.map((r) =>
        [
          codeHeader ? r.code ?? "" : null,
          r.label,
          r.count,
          r.saleAmount,
          r.purchaseAmount,
          r.profit,
          marginPct(r.profit, r.saleAmount),
        ].filter((v): v is string | number => v !== null)
      )
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {downloadLabel && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={handleDownload}
            className="rounded-md bg-gray-95 px-3 py-1.5 text-xs font-medium text-fg hover:bg-gray-90 disabled:opacity-50"
          >
            엑셀 다운로드
          </button>
        </div>
      )}
      <table className="w-full min-w-[680px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {codeHeader && <SortableTh label={codeHeader} sortKey="code" state={sort} onSort={onSort} />}
            <SortableTh label={labelHeader} sortKey="label" state={sort} onSort={onSort} />
            <SortableTh label="건수" sortKey="count" state={sort} onSort={onSort} align="right" />
            <SortableTh label="매출액" sortKey="saleAmount" state={sort} onSort={onSort} align="right" />
            <SortableTh label="배분매입액" sortKey="purchaseAmount" state={sort} onSort={onSort} align="right" />
            <SortableTh label="손익" sortKey="profit" state={sort} onSort={onSort} align="right" />
            {/* 손익률 = 손익 ÷ 매출액. 정렬 대상으로 두지 않는다 — 손익(원) 정렬과 결과가 거의
                같아서 별도 정렬 기준을 두면 혼란만 커진다. */}
            <th className="py-2 pr-3 text-right">손익률</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.key} className="border-b border-border/60">
              {codeHeader && <td className="py-2 pr-3 whitespace-nowrap num text-muted">{r.code ?? "-"}</td>}
              <td className="py-2 pr-3 text-fg">{r.label}</td>
              <td className="py-2 pr-3 text-right num text-muted">{r.count}</td>
              <td className="py-2 pr-3 text-right num text-fg">{formatAmount(r.saleAmount)}</td>
              <td className="py-2 pr-3 text-right num text-muted">{formatAmount(r.purchaseAmount)}</td>
              <td
                className={`py-2 pr-3 text-right num font-medium ${r.profit >= 0 ? "text-pos" : "text-neg"}`}
              >
                {formatAmount(r.profit)}
              </td>
              <td className={`py-2 pr-3 text-right num ${r.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {marginPct(r.profit, r.saleAmount)}
              </td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-border font-medium">
              {/* 코드 열이 있으면 "합계"가 코드+이름 두 칸을 덮는다. */}
              <td className="py-2 pr-3 text-fg" colSpan={codeHeader ? 2 : 1}>
                합계
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 pr-3 text-right num text-fg">{formatAmount(totals.saleAmount)}</td>
              <td className="py-2 pr-3 text-right num text-muted">{formatAmount(totals.purchaseAmount)}</td>
              <td className={`py-2 pr-3 text-right num ${totals.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {formatAmount(totals.profit)}
              </td>
              <td className={`py-2 pr-3 text-right num ${totals.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {marginPct(totals.profit, totals.saleAmount)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export type PnlBlRow = {
  saleId: string;
  date: string; // 이미 "YYYY-MM-DD"로 포맷해서 넘긴다(Date를 클라이언트로 보내지 않기 위해)
  blNo: string;
  partyCode: string | null;
  partyName: string;
  saleAmount: number;
  purchaseAmount: number;
  profit: number;
};

type BlSortKey = "date" | "blNo" | "partyCode" | "partyName" | "saleAmount" | "purchaseAmount" | "profit";

export function PnlBlTable({ rows }: { rows: PnlBlRow[] }) {
  const [sort, setSort] = useState<SortState<BlSortKey>>(null);
  const sorted = sortRowsBy(rows, sort, (r, k) => r[k]);
  const onSort = (k: BlSortKey) => setSort((prev) => toggleSort(prev, k));

  // 합계는 정렬과 무관하게 전체 행을 더한 값이다(요약 표와 같은 규칙).
  const totals = rows.reduce(
    (acc, r) => ({
      saleAmount: acc.saleAmount + r.saleAmount,
      purchaseAmount: acc.purchaseAmount + r.purchaseAmount,
      profit: acc.profit + r.profit,
    }),
    { saleAmount: 0, purchaseAmount: 0, profit: 0 }
  );

  function handleDownload() {
    downloadCsv(
      `B/L별손익_${new Date().toISOString().slice(0, 10)}.csv`,
      ["날짜", "B/L", "거래처코드", "거래처명", "매출액", "배분매입액", "손익", "손익률"],
      sorted.map((r) => [
        r.date,
        r.blNo,
        r.partyCode ?? "",
        r.partyName,
        r.saleAmount,
        r.purchaseAmount,
        r.profit,
        marginPct(r.profit, r.saleAmount),
      ])
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button
          type="button"
          disabled={rows.length === 0}
          onClick={handleDownload}
          className="rounded-md bg-gray-95 px-3 py-1.5 text-xs font-medium text-fg hover:bg-gray-90 disabled:opacity-50"
        >
          엑셀 다운로드
        </button>
      </div>
      <table className="w-full min-w-[880px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <SortableTh label="날짜" sortKey="date" state={sort} onSort={onSort} />
            <SortableTh label="B/L" sortKey="blNo" state={sort} onSort={onSort} />
            <SortableTh label="거래처코드" sortKey="partyCode" state={sort} onSort={onSort} />
            <SortableTh label="거래처명" sortKey="partyName" state={sort} onSort={onSort} />
            <SortableTh label="매출액" sortKey="saleAmount" state={sort} onSort={onSort} align="right" />
            <SortableTh label="배분매입액" sortKey="purchaseAmount" state={sort} onSort={onSort} align="right" />
            <SortableTh label="손익" sortKey="profit" state={sort} onSort={onSort} align="right" />
            <th className="py-2 pr-3 text-right">손익률</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.saleId} className="border-b border-border/60">
              <td className="py-2 pr-3 whitespace-nowrap num text-muted">{r.date}</td>
              <td className="py-2 pr-3 whitespace-nowrap num text-fg">{r.blNo}</td>
              <td className="py-2 pr-3 whitespace-nowrap num text-muted">{r.partyCode ?? "-"}</td>
              <td className="py-2 pr-3 text-fg">{r.partyName}</td>
              <td className="py-2 pr-3 text-right num text-fg">{formatAmount(r.saleAmount)}</td>
              <td className="py-2 pr-3 text-right num text-muted">{formatAmount(r.purchaseAmount)}</td>
              <td
                className={`py-2 pr-3 text-right num font-medium ${r.profit >= 0 ? "text-pos" : "text-neg"}`}
              >
                {formatAmount(r.profit)}
              </td>
              <td className={`py-2 pr-3 text-right num ${r.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {marginPct(r.profit, r.saleAmount)}
              </td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="py-2 pr-3 text-fg" colSpan={4}>
                합계 ({rows.length}건)
              </td>
              <td className="py-2 pr-3 text-right num text-fg">{formatAmount(totals.saleAmount)}</td>
              <td className="py-2 pr-3 text-right num text-muted">{formatAmount(totals.purchaseAmount)}</td>
              <td className={`py-2 pr-3 text-right num ${totals.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {formatAmount(totals.profit)}
              </td>
              <td className={`py-2 pr-3 text-right num ${totals.profit >= 0 ? "text-pos" : "text-neg"}`}>
                {marginPct(totals.profit, totals.saleAmount)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
