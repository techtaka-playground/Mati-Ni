"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  listBankAccounts,
  searchBankLog,
  setBankPartyAlias,
  setBankTransactionStatus,
  type StatusInfo,
  type BankTxStatus,
  type BankTransactionLink,
} from "@/app/(app)/bank/actions";
import type { BankAccount, BankLogRow } from "@/lib/barobillBank";
import { formatAmount, monthOf, monthRange } from "@/lib/format";
import { SortableTh } from "@/components/SortableTh";
import { sortRowsBy, toggleSort, type SortState, type SortValue } from "@/lib/tableSort";
import { buildBankSlipHtml, stripParens } from "@/lib/bankSlip";
import { PartySearchSelect, type PartyOption } from "@/components/PartySearchSelect";
import { IconAlertCircle } from "@/components/icons";
import type { MatchedParty } from "@/lib/bankPartyMatch";

// 확정 칸에 쓰는 짧은 날짜(MM-DD) — 열이 좁아서 연도는 빼고 전체 시각은 title로 띄운다
// (세금계산서 화면의 확정 표시와 같은 방식).
function formatConfirmShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 바로빌이 주는 TransDT는 "YYYYMMDDHHMMSS"(또는 그보다 짧을 수 있다) — 보기 좋게 자른다.
function formatTransDT(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length < 8) return raw;
  const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (d.length < 12) return date;
  return `${date} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
}

function accountLabel(a: BankAccount): string {
  const bank = a.bankName || a.bankCode;
  return a.alias ? `${bank} ${a.accountNum} (${a.alias})` : `${bank} ${a.accountNum}`;
}

// 화면에서는 잔액 열을 빼지만 엑셀에는 남겨둔다 — 표는 훑어보는 용도, 엑셀은 원본 기록 용도다.
const CSV_HEADERS = [
  "거래일시", "구분", "입금액", "출금액", "잔액", "은행", "송금인/적요", "거래처코드", "거래처", "비고",
  "상태", "제외사유", "표시일", "표시자",
];

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(
  rows: BankLogRow[],
  label: string,
  matches: Record<string, MatchedParty>,
  statuses: Record<string, StatusInfo>
) {
  const lines = [
    CSV_HEADERS.join(","),
    ...rows.map((r) =>
      [
        formatTransDT(r.transDT),
        r.deposit > 0 ? "입금" : "출금",
        r.deposit,
        r.withdraw,
        r.balance,
        stripParens(r.transOffice),
        r.transRemark,
        matches[r.transRemark]?.code ?? "",
        matches[r.transRemark]?.name ?? "",
        [r.mgtRemark1, r.mgtRemark2].filter(Boolean).join(" / "),
        statuses[r.transRefKey]
          ? statuses[r.transRefKey].status === "excluded"
            ? "제외"
            : "확정"
          : "미확정",
        statuses[r.transRefKey]?.reason ?? "",
        statuses[r.transRefKey] ? statuses[r.transRefKey].confirmedAt.slice(0, 10) : "",
        statuses[r.transRefKey]?.confirmedByEmail ?? "",
      ]
        .map(csvCell)
        .join(",")
    ),
  ];
  // UTF-8 BOM — 엑셀에서 한글이 깨지지 않게(세금계산서 다운로드와 동일).
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `입출금내역_${label}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthAgoStr(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

// "제외" 사유 분류 — 자유 텍스트만 받던 것을 자주 쓰는 항목으로 먼저 고르게 한다(다른
// 사유 입력들과 같은 관례, 2026-08-31).
type ExcludeReasonCategory = "내부이체" | "이자수익" | "수수료" | "기타";
const EXCLUDE_REASON_CATEGORIES: ExcludeReasonCategory[] = ["내부이체", "이자수익", "수수료", "기타"];

type BankSortKey =
  | "transDT"
  | "kind"
  | "deposit"
  | "withdraw"
  | "balance"
  | "transOffice"
  | "transRemark"
  | "partyCode"
  | "partyName"
  | "mgtRemark"
  | "linked"
  | "confirmedAt";

function bankSortValue(r: BankLogRow, key: BankSortKey): SortValue {
  switch (key) {
    case "transDT":
      // "YYYYMMDDHHMMSS" 문자열이라 사전순 = 시간순이다(그대로 비교해도 맞다).
      return r.transDT;
    case "kind":
      return r.deposit > 0 ? "입금" : "출금";
    case "deposit":
      return r.deposit;
    case "withdraw":
      return r.withdraw;
    case "balance":
      return r.balance;
    case "transOffice":
      return r.transOffice;
    case "transRemark":
      return r.transRemark;
    case "partyCode":
    case "partyName":
    case "linked":
    case "confirmedAt":
      // 이 열들은 행 자체에 값이 없고 matches/confirms/links에서 찾아야 한다 — sortedRows에서 처리한다.
      return null;
    case "mgtRemark":
      return [r.mgtRemark1, r.mgtRemark2].filter(Boolean).join(" / ");
  }
}

export function BankLogSearchForm({
  corpName,
  parties,
}: {
  corpName: string;
  parties: PartyOption[];
}) {
  // 조회조건은 URL 쿼리에 담는다 — 다른 탭에 갔다 돌아와도 사이드바가 기억한 주소로 복원된다
  // (Sidebar.tsx 참고). 세금계산서 화면과 같은 규칙: URL은 초기값으로만 읽고 이후엔 상태 → URL
  // 한 방향으로만 쓴다(양방향이면 replace ↔ 상태 갱신이 서로를 트리거해 무한 루프).
  const initialParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [accountNum, setAccountNum] = useState(initialParams.get("account") ?? "");
  // 일반전표·관세전표와 같은 "월/일" 조회 방식 전환(2026-08-27) — "일"은 기존처럼 시작일·
  // 종료일 두 칸, "월"은 그 달 전체를 한 번에 고른다.
  const [mode, setMode] = useState<"day" | "month">(() => (initialParams.get("mode") === "month" ? "month" : "day"));
  const [month, setMonth] = useState(() => {
    const v = initialParams.get("month");
    return v && /^\d{4}-\d{2}$/.test(v) ? v : monthOf(new Date());
  });
  const [startDate, setStartDate] = useState(() => {
    const v = initialParams.get("start");
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : monthAgoStr();
  });
  const [endDate, setEndDate] = useState(() => {
    const v = initialParams.get("end");
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : todayStr();
  });
  // 입금/출금 구분 필터 — 일반전표의 "구분"(매출/매입)과 같은 자리(2026-08-27).
  const [kindFilter, setKindFilter] = useState<"all" | "deposit" | "withdraw">(() => {
    const v = initialParams.get("kind");
    return v === "deposit" || v === "withdraw" ? v : "all";
  });

  const [accounts, setAccounts] = useState<BankAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [rows, setRows] = useState<BankLogRow[] | null>(null);
  // 조회를 다시 불러온 시각 — 안내 문구 대신 이것만 보여준다(세금계산서 화면과 같은 패턴).
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [sort, setSort] = useState<SortState<BankSortKey>>(null);
  // 송금인/적요 → 매칭된 거래처. 서버가 계산해서 내려준다(정규화 규칙을 화면에서 다시 만들지 않게).
  const [matches, setMatches] = useState<Record<string, MatchedParty>>({});
  // 지금 거래처를 고치고 있는 송금인 문자열(한 번에 한 줄만 편집).
  const [editingRemark, setEditingRemark] = useState<string | null>(null);
  const [aliasPending, setAliasPending] = useState(false);
  // 거래 1건의 검토 상태: 은행 거래고유번호(TransRefKey) → {상태, 누가, 언제}. 키가 없으면 미확정.
  const [statuses, setStatuses] = useState<Record<string, StatusInfo>>({});
  // "제외" 사유 입력 팝업 — 브라우저 기본 prompt() 대신 앱 톤에 맞는 팝업으로 받는다
  // (2026-08-27, "localhost:3000 내용:" 식 브라우저 기본 팝업이 어색하다는 피드백에 따름).
  const [excludeModal, setExcludeModal] = useState<
    { row: BankLogRow; category: ExcludeReasonCategory | ""; reason: string } | null
  >(null);
  // "확정/제외 해제" 확인 팝업 — 잘못 눌러 검토 표시가 바로 풀리지 않도록 한 번 더 확인한다
  // (2026-08-31).
  const [releaseConfirm, setReleaseConfirm] = useState<BankLogRow | null>(null);
  // 거래 1건이 연동된 전표: 은행 거래고유번호(TransRefKey) → {관세전표/일반전표, 표시용 문구}.
  // 키가 없으면 아직 어느 전표에도 붙지 않았다는 뜻이다.
  const [links, setLinks] = useState<Record<string, BankTransactionLink>>({});
  const [statusPending, setStatusPending] = useState<string | null>(null);
  // 확정 여부 필터. URL에 담아서 다른 탭에 갔다 돌아와도 유지된다(사이드바 탭별 위치 기억과 맞춤).
  const [confirmFilter, setConfirmFilter] = useState<"all" | "confirmed" | "unconfirmed" | "excluded">(
    () => {
      const v = initialParams.get("confirm");
      return v === "confirmed" || v === "unconfirmed" || v === "excluded" ? v : "all";
    }
  );

  // 정렬은 조회 결과를 화면에서만 다시 늘어놓는 것이다 — 바로빌을 다시 부르지 않는다.
  // 건수는 **필터와 무관하게 조회 결과 전체**를 센다 — 필터를 걸면 숫자도 같이 줄어들면
  // "몇 개 남았는지"를 알 수 없다. **제외된 건은 미확정에서 빠진다** — 그게 제외의 목적이다.
  const confirmedCount = (rows ?? []).filter((r) => statuses[r.transRefKey]?.status === "confirmed").length;
  const excludedCount = (rows ?? []).filter((r) => statuses[r.transRefKey]?.status === "excluded").length;
  const unconfirmedCount = (rows ?? []).length - confirmedCount - excludedCount;

  const sortedRows = sortRowsBy(rows ?? [], sort, (r, k) => {
    // 거래처 열은 행 자체에 값이 없고 matches에서 찾아야 하므로 여기서 처리한다.
    if (k === "partyCode") return matches[r.transRemark]?.code ?? null;
    if (k === "partyName") return matches[r.transRemark]?.name ?? null;
    if (k === "linked") return links[r.transRefKey]?.kind ?? null;
    // 정렬은 상태 → 시각 순으로 보이게 문자열을 합친다(미확정은 빈 값이라 뒤로 밀린다).
    if (k === "confirmedAt") {
      const st = statuses[r.transRefKey];
      return st ? `${st.status}-${st.confirmedAt}` : null;
    }
    return bankSortValue(r, k);
  }).filter((r) => {
    const st = statuses[r.transRefKey]?.status;
    if (confirmFilter === "confirmed") return st === "confirmed";
    if (confirmFilter === "excluded") return st === "excluded";
    if (confirmFilter === "unconfirmed") return !st;
    return true;
  }).filter((r) => {
    if (kindFilter === "deposit") return r.deposit > 0;
    if (kindFilter === "withdraw") return r.withdraw > 0;
    return true;
  });
  // 조회에 실제로 쓰인 기간 — 월 모드에서도 다운로드 파일명이 그 달을 그대로 보여주게 한다.
  const rangeLabel = mode === "month" ? month : `${startDate}_${endDate}`;
  function handleSort(key: BankSortKey) {
    setSort((prev) => toggleSort(prev, key));
  }

  // 송금인/적요에 거래처를 지정하거나 해제한다. **같은 송금인의 모든 거래에 적용**된다.
  async function applyAlias(remark: string, partyId: string | null) {
    setAliasPending(true);
    setError(null);
    const result = await setBankPartyAlias({
      remark,
      partyId,
      remarks: (rows ?? []).map((r) => r.transRemark),
    });
    setAliasPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setMatches(result.matches);
    setEditingRemark(null);
  }

  // 입출금내역 한 건의 검토 상태를 정한다(확정 / 제외 / 해제). 확정은 초록, 제외는 회색 음영이다.
  async function applyStatus(row: BankLogRow, status: BankTxStatus | null, reason = "") {
    if (!row.transRefKey) {
      setError("이 거래에는 은행 거래고유번호가 없어 상태를 표시할 수 없습니다.");
      return;
    }
    setStatusPending(row.transRefKey);
    setError(null);
    const result = await setBankTransactionStatus({
      transRefKey: row.transRefKey,
      accountNum: row.accountNum || accountNum,
      transDT: row.transDT,
      // 입금은 +, 출금은 - 로 남긴다 — 나중에 금액이 달라졌는지 대조할 수 있게.
      amount: row.deposit > 0 ? row.deposit : -row.withdraw,
      status,
      reason,
      transRefKeys: (rows ?? []).map((r) => r.transRefKey),
    });
    setStatusPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setStatuses(result.statuses);
  }

  // 거래 1건을 "계좌 거래내역 확인서"(입금증/출금증) 한 장으로 띄운다. PDF 라이브러리를 새로
  // 넣지 않고 인쇄용 HTML을 만드는 이유는 bankSlip.ts 주석 참고 — 브라우저의 "PDF로 저장"이
  // 곧 다운로드다. 화면에는 아무 팝업도 띄우지 않는다 — 화면 밖 숨긴 iframe에 넣어서 그
  // iframe만 인쇄하고(html 안의 스크립트가 로드되자마자 window.print()를 부른다), 인쇄
  // 대화상자가 닫히면(afterprint) iframe을 지운다(2026-08-31, 앱 팝업 단계를 없애달라는
  // 요청에 따름 — 실수로 놔둔 폴백 타이머는 대화상자를 계속 열어두는 경우를 대비한다).
  function openSlip(row: BankLogRow) {
    const account = (accounts ?? []).find((a) => a.accountNum === row.accountNum || a.accountNum === accountNum);
    const html = buildBankSlipHtml({
      corpName,
      bankName: account?.bankName ?? "",
      accountNum: row.accountNum || accountNum,
      row,
      printedAt: new Date(),
    });

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "none";
    iframe.srcdoc = html;

    let removed = false;
    function cleanup() {
      if (removed) return;
      removed = true;
      iframe.remove();
    }
    // 대화상자를 취소해도 afterprint는 뜬다 — 정상 케이스는 이걸로 충분하다. 혹시 안 뜨는
    // 브라우저를 대비해 넉넉한 시간 뒤 강제로 치운다.
    iframe.addEventListener("load", () => {
      iframe.contentWindow?.addEventListener("afterprint", cleanup);
    });
    setTimeout(cleanup, 5 * 60 * 1000);

    document.body.appendChild(iframe);
  }

  // 계좌 목록은 화면을 열 때 한 번 불러온다. 아직 계좌를 등록하지 않았거나 계좌조회 서비스가
  // 신청되지 않았으면 여기서 실패하는데, 그때도 화면 자체는 열리고 이유만 보여준다.
  useEffect(() => {
    listBankAccounts().then((result) => {
      if (!result.ok) {
        setAccountsError(result.message);
        setAccounts([]);
        return;
      }
      setAccounts(result.accounts);
      // 아직 고른 계좌가 없으면 첫 계좌를 기본값으로.
      setAccountNum((prev) => prev || result.accounts[0]?.accountNum || "");
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (accountNum) params.set("account", accountNum);
    if (mode === "month") {
      params.set("mode", "month");
      params.set("month", month);
    } else {
      params.set("start", startDate);
      params.set("end", endDate);
    }
    if (confirmFilter !== "all") params.set("confirm", confirmFilter);
    if (kindFilter !== "all") params.set("kind", kindFilter);
    const qs = params.toString();
    if (window.location.search.replace(/^\?/, "") === qs) return;
    router.replace(`${pathname}?${qs}`, { scroll: false });
  }, [accountNum, mode, month, startDate, endDate, confirmFilter, kindFilter, pathname, router]);

  function runSearch() {
    setError(null);
    const effective = mode === "month" ? monthRange(month) : { start: startDate, end: endDate };
    startTransition(async () => {
      const result = await searchBankLog({ accountNum, startDate: effective.start, endDate: effective.end });
      if (!result.ok) {
        setError(result.message);
        setRows(null);
        return;
      }
      setRows(result.rows);
      setMatches(result.matches);
      setStatuses(result.statuses);
      setLinks(result.links);
      setEditingRemark(null);
      setTruncated(result.truncated);
      setLastUpdatedAt(new Date());
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch();
  }



  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-fg">입출금내역</h1>
        {lastUpdatedAt && (
          <div className="mt-1 text-xs text-muted">
            입출금내역 업데이트{" "}
            {lastUpdatedAt.toLocaleString("ko-KR", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
      <form onSubmit={handleSubmit} className="card flex flex-wrap items-end gap-3 p-4">
        {/* 일반전표·관세전표와 같은 월/일 조회 방식 전환 + 구분(입금/출금) 필터
            (2026-08-27). 순서는 조회 방식 → 구분 → 계좌 → 조회년월/기간(2026-08-31). */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">조회 방식</label>
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              type="button"
              onClick={() => setMode("month")}
              className={`rounded px-3 py-1 text-sm transition-colors ${
                mode === "month" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
              }`}
            >
              월
            </button>
            <button
              type="button"
              onClick={() => setMode("day")}
              className={`rounded px-3 py-1 text-sm transition-colors ${
                mode === "day" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
              }`}
            >
              일
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">구분</label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as "all" | "deposit" | "withdraw")}
            className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          >
            <option value="all">전체</option>
            <option value="deposit">입금</option>
            <option value="withdraw">출금</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">계좌</label>
          <select
            value={accountNum}
            onChange={(e) => setAccountNum(e.target.value)}
            className="w-72 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          >
            {accounts === null && <option value="">계좌 불러오는 중...</option>}
            {accounts?.length === 0 && <option value="">등록된 계좌가 없습니다</option>}
            {accounts?.map((a) => (
              <option key={a.accountNum} value={a.accountNum}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
        </div>
        {mode === "month" ? (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">조회년월</label>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
            />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">시작일</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">종료일</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
              />
            </div>
          </>
        )}
        <button
          type="submit"
          disabled={pending || !accountNum}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? "조회 중..." : "조회"}
        </button>
      </form>

      {accountsError && (
        <div className="card p-4 text-sm text-neg">
          계좌 목록을 불러오지 못했습니다: {accountsError}
          <div className="mt-1 text-xs text-muted">
            바로빌에 계좌조회 서비스가 신청되어 있고, 조회할 계좌가 등록되어 있어야 합니다.
          </div>
        </div>
      )}

      {error && <div className="card p-4 text-sm text-neg">{error}</div>}

      {truncated && (
        <div className="text-xs text-neg">
          결과가 많아 최초 2,000건까지만 표시했습니다 — 기간을 나눠서 조회하세요.
        </div>
      )}

      {rows && (
        <div className="card overflow-x-auto p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">
                {rows.length}건 조회됨
                {/* 필터를 걸면 지금 몇 건이 보이는지도 함께 알려준다. */}
                {confirmFilter !== "all" && ` · 표시 ${sortedRows.length}건`}
              </span>
              {/* 확정/미확정 건수 + 미확정만 보기. 건수는 필터와 무관하게 조회 결과 전체 기준이다 —
                  필터를 걸면 숫자도 줄어들면 "몇 개 남았는지"를 알 수 없다. */}
              <div className="flex items-center gap-1">
                {(
                  [
                    ["all", `전체 ${rows.length}`],
                    ["confirmed", `확정 ${confirmedCount}`],
                    ["unconfirmed", `미확정 ${unconfirmedCount}`],
                    ["excluded", `제외 ${excludedCount}`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setConfirmFilter(key)}
                    className={`rounded-full px-2.5 py-1 text-xs ${
                      confirmFilter === key
                        ? "bg-accent font-medium text-accent-fg"
                        : key === "unconfirmed" && unconfirmedCount > 0
                          ? "bg-gray-95 text-neg hover:bg-gray-90"
                          : "bg-gray-95 text-muted hover:bg-gray-90"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* 다운로드는 **화면에 보이는 것**을 내린다 — 미확정만 걸러 본 뒤 그걸 그대로 받는 게
                자연스럽고, 필터와 파일 내용이 다르면 헷갈린다. 파일명에도 필터를 적는다. */}
            <button
              type="button"
              disabled={sortedRows.length === 0}
              onClick={() =>
                downloadCsv(
                  sortedRows,
                  `${rangeLabel}${confirmFilter === "confirmed" ? "_확정" : confirmFilter === "unconfirmed" ? "_미확정" : ""}`,
                  matches,
                  statuses
                )
              }
              className="rounded-md bg-gray-95 px-3 py-1.5 text-xs font-medium text-fg hover:bg-gray-90 disabled:opacity-50"
            >
              엑셀 다운로드
            </button>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                {/* 확인서 열은 맨 왼쪽 — 정렬 대상이 아닌 버튼 열이다. */}
                <th className="w-16 py-2 pr-3">확인서</th>
                <SortableTh label="거래일시" sortKey="transDT" state={sort} onSort={handleSort} />
                <SortableTh label="구분" sortKey="kind" state={sort} onSort={handleSort} />
                <SortableTh label="입금액" sortKey="deposit" state={sort} onSort={handleSort} align="right" />
                <SortableTh label="출금액" sortKey="withdraw" state={sort} onSort={handleSort} align="right" />
                {/* 잔액 열은 화면에서 빼달라는 요청으로 없앴다 — 값 자체는 계속 받아오고 있어서
                    엑셀 다운로드에는 그대로 들어간다(필요하면 헤더 한 줄로 되살릴 수 있다). */}
                {/* 이 값(TransOffice)은 상대 회사가 아니라 **거래점/경유은행**이다(예: 기업, 우리,
                    국민, 강남, 선릉중) — "거래처"라고 두면 상대 회사로 오해한다. 실제 상대방
                    이름은 옆의 "송금인/적요"(TransRemark)에 온다. */}
                <SortableTh label="은행" sortKey="transOffice" state={sort} onSort={handleSort} />
                {/* 바로빌/은행에는 "송금인" 전용 필드가 따로 없다 — TransRemark(적요)가 입금이면
                    송금인명(예: "(주)앱솔브랩"), 출금이면 거래내용(예: "해외송금")으로 온다.
                    그래서 열 이름을 실제 내용에 맞게 "송금인/적요"로 둔다. */}
                <SortableTh label="송금인/적요" sortKey="transRemark" state={sort} onSort={handleSort} />
                {/* 송금인 이름으로 거래처 마스터를 찾아 붙인 결과. 자동 추정이 틀리면 "지정"으로
                    고칠 수 있고, 그 지정은 같은 송금인의 다른 거래에도 적용된다. */}
                <SortableTh label="거래처코드" sortKey="partyCode" state={sort} onSort={handleSort} />
                <SortableTh label="거래처" sortKey="partyName" state={sort} onSort={handleSort} />
                <SortableTh label="비고" sortKey="mgtRemark" state={sort} onSort={handleSort} />
                {/* 전표연동 = 이 거래에 실제로 배분된 관세전표/일반전표가 있는지(bankAllocation.ts의
                    getBankTransactionLinks 참고, 2026-08-31 — 저장된 배분 기준). 사람이 표시하는 게
                    아니라 자동 판단이라 "확정"과는 별개의 열이다. */}
                <SortableTh label="전표연동" sortKey="linked" state={sort} onSort={handleSort} />
                {/* 확정 = "이 건 내용을 확인했다"는 검토 표시. 전표를 만들지 않으므로 되돌릴 수
                    있다(세금계산서의 승인/확정과 다른 점). */}
                <SortableTh label="확정" sortKey="confirmedAt" state={sort} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r, i) => (
                // TransRefKey가 거래 1건을 고유하게 가리키므로 그걸 key로 쓴다. 혹시 비어 있는
                // 응답이 오면 거래일시+금액+index 조합으로 떨어진다.
                <Fragment key={r.transRefKey || `${r.transDT}-${r.deposit}-${r.withdraw}-${i}`}>
                <tr
                  // 확정은 초록 음영(세금계산서 화면과 같은 규칙), 제외는 노란 음영 — 대조 대상이
                  // 아니라는 뜻이므로 "완료"로 보이는 초록과 구분되어야 한다.
                  className={`border-b border-border/60 ${
                    statuses[r.transRefKey]?.status === "confirmed"
                      ? "bg-pos/10"
                      : statuses[r.transRefKey]?.status === "excluded"
                        ? "bg-warn/15"
                        : ""
                  }`}
                >
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openSlip(r)}
                      title={`${r.deposit > 0 ? "입금" : "출금"}건 거래확인서를 새 창으로 엽니다 (인쇄 / PDF로 저장)`}
                      // 입금증/출금증도 구분 열과 같은 색으로 — 초록=입금, 빨강=출금.
                      className={`text-xs hover:underline ${r.deposit > 0 ? "text-pos" : "text-neg"}`}
                    >
                      {r.deposit > 0 ? "입금증" : "출금증"}
                    </button>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap num text-muted">{formatTransDT(r.transDT)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className={`text-xs ${r.deposit > 0 ? "text-pos" : "text-neg"}`}>
                      {r.deposit > 0 ? "입금" : "출금"}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right num text-pos">
                    {r.deposit > 0 ? formatAmount(r.deposit) : "-"}
                  </td>
                  <td className="py-2 pr-3 text-right num text-neg">
                    {r.withdraw > 0 ? formatAmount(r.withdraw) : "-"}
                  </td>
                  <td className="py-2 pr-3 text-fg">{stripParens(r.transOffice) || "-"}</td>
                  {/* 입금 건의 적요는 곧 송금인 이름이라 진하게, 출금 건은 거래내용이라 흐리게. */}
                  <td className={`py-2 pr-3 ${r.deposit > 0 ? "text-fg" : "text-muted"}`}>
                    {r.transRemark || "-"}
                  </td>
                  {/* 거래처코드 · 거래처 — 송금인 이름으로 찾은 결과. 편집 중인 줄에서는 검색
                      선택칸이 뜨고, 지정하면 **같은 송금인의 모든 거래**에 적용된다. */}
                  <td className="py-2 pr-3 whitespace-nowrap num text-muted">
                    {editingRemark === r.transRemark && !statuses[r.transRefKey]
                      ? ""
                      : (matches[r.transRemark]?.code ?? "-")}
                  </td>
                  <td className="py-2 pr-3">
                    {editingRemark === r.transRemark && !statuses[r.transRefKey] ? (
                      <div className="flex items-start gap-2">
                        <div className="w-56">
                          {/* 기존 거래처를 지우지 않고 바로 새로 검색해서 고를 수 있게, 항상
                              빈 검색칸으로 연다(2026-08-31) — PartySearchSelect는 value가
                              있으면 선택된 거래처 표시 + 그 안에서 한 번 더 "변경"을 눌러야
                              검색칸이 뜨는데, 바깥 "변경"을 누른 시점에 이미 바꾸려는 의도가
                              분명하므로 그 한 단계를 건너뛴다. */}
                          <PartySearchSelect
                            parties={parties}
                            value={null}
                            onChange={(id) => applyAlias(r.transRemark, id)}
                            placeholder="코드/거래처명"
                            disabled={aliasPending}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setEditingRemark(null)}
                          className="shrink-0 whitespace-nowrap pt-1.5 text-xs text-muted hover:underline"
                        >
                          닫기
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        {matches[r.transRemark] ? (
                          <>
                            <span className="text-fg">{matches[r.transRemark].name}</span>
                            {/* 사람이 지정한 것과 이름으로 추정한 것을 구분해서 보여준다 —
                                추정은 틀릴 수 있으니 그대로 믿고 쓰면 안 된다. */}
                            <span
                              className="text-xs text-muted"
                              title={
                                matches[r.transRemark].source === "exact"
                                  ? "송금인 이름이 거래처명과 정확히 일치해 자동으로 붙였습니다."
                                  : matches[r.transRemark].source === "alias"
                                    ? "사람이 직접 지정한 거래처입니다."
                                    : "송금인 이름이 거래처명과 일부만 일치해 추정한 것입니다 — 확인해주세요."
                              }
                            >
                              {matches[r.transRemark].source === "exact"
                                ? "(자동)"
                                : matches[r.transRemark].source === "alias"
                                  ? "(수정)"
                                  : "(추정)"}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-muted">미지정</span>
                        )}
                        {/* 확정/제외로 검토가 끝난 거래는 거래처를 함부로 바꾸지 못하게 잠근다 —
                            바꾸려면 먼저 "확정" 칸의 "해제"로 검토를 되돌려야 한다(2026-08-31). */}
                        {!statuses[r.transRefKey] && r.transRemark && (
                          <button
                            type="button"
                            disabled={aliasPending}
                            onClick={() => setEditingRemark(r.transRemark)}
                            className="text-xs text-accent hover:underline disabled:opacity-50"
                          >
                            {matches[r.transRemark] ? "변경" : "지정"}
                          </button>
                        )}
                        {!statuses[r.transRefKey] && matches[r.transRemark]?.source === "alias" && (
                          <button
                            type="button"
                            disabled={aliasPending}
                            onClick={() => applyAlias(r.transRemark, null)}
                            title="지정을 지우고 이름 자동 추정으로 되돌립니다."
                            className="text-xs text-muted hover:underline disabled:opacity-50"
                          >
                            해제
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-muted">
                    {[r.mgtRemark1, r.mgtRemark2].filter(Boolean).join(" / ") || "-"}
                  </td>
                  {/* 관세전표는 일반전표(초록)와 헷갈리지 않도록 노란 계열(text-warn)로 구별한다
                      (세금계산서 화면의 전표종류 표시와 같은 규칙). */}
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {links[r.transRefKey] ? (
                      <span
                        className={`text-xs ${links[r.transRefKey].kind === "customs" ? "text-warn" : "text-pos"}`}
                        title={links[r.transRefKey].label}
                      >
                        {links[r.transRefKey].count > 1
                          ? links[r.transRefKey].label
                          : links[r.transRefKey].kind === "customs"
                            ? "관세전표 연동"
                            : "일반전표 연동"}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">-</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {statusPending === r.transRefKey ? (
                      <span className="text-xs text-muted">처리 중...</span>
                    ) : statuses[r.transRefKey] ? (
                      <span className="flex items-center gap-2">
                        <span
                          className={`text-xs ${
                            statuses[r.transRefKey].status === "confirmed" ? "text-pos" : "text-warn"
                          }`}
                          title={[
                            statuses[r.transRefKey].status === "confirmed" ? "확정" : "제외(대조 대상 아님)",
                            statuses[r.transRefKey].reason,
                            new Date(statuses[r.transRefKey].confirmedAt).toLocaleString("ko-KR"),
                            `표시자 ${statuses[r.transRefKey].confirmedByEmail}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          {statuses[r.transRefKey].status === "confirmed" ? "확정" : "제외"}{" "}
                          {formatConfirmShort(statuses[r.transRefKey].confirmedAt)}
                        </span>
                        {/* 검토 표시일 뿐이라 되돌릴 수 있다 — 잘못 눌렀을 때 풀 수 있어야 한다.
                            바로 풀지 않고 한 번 확인한다(2026-08-31). */}
                        <button
                          type="button"
                          onClick={() => setReleaseConfirm(r)}
                          className="text-xs text-muted hover:underline"
                        >
                          해제
                        </button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {/* 거래처가 지정되지 않은 거래는 확정할 수 없다 — 확정은 "누구와의
                            거래인지까지 확인했다"는 뜻이라, 거래처가 없으면 대조 자체가
                            끝난 게 아니다(2026-08-31). */}
                        <button
                          type="button"
                          disabled={!r.transRefKey || !matches[r.transRemark]}
                          onClick={() => applyStatus(r, "confirmed")}
                          title={
                            !r.transRefKey
                              ? "은행 거래고유번호가 없어 표시할 수 없습니다."
                              : !matches[r.transRemark]
                                ? "거래처를 먼저 지정해야 확정할 수 있습니다."
                                : "이 건의 내용을 확인했다고 표시합니다(되돌릴 수 있습니다)."
                          }
                          className="text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                        >
                          확정
                        </button>
                        <button
                          type="button"
                          disabled={!r.transRefKey}
                          onClick={() => setExcludeModal({ row: r, category: "", reason: "" })}
                          title={
                            r.transRefKey
                              ? "대조 대상이 아니라고 표시합니다 — 미확정 집계에서 빠집니다."
                              : "은행 거래고유번호가 없어 표시할 수 없습니다."
                          }
                          className="text-xs text-muted hover:underline disabled:cursor-not-allowed disabled:no-underline"
                        >
                          제외
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
                {/* 세금계산서 화면과 같은 이유로, 행 사이를 살짝 띄워서 한 줄씩 더 잘 읽히게
                    한다(2026-08-27). */}
                <tr aria-hidden="true">
                  <td colSpan={12} className="h-2" />
                </tr>
                </Fragment>
              ))}
            </tbody>
            {/* 합계줄은 없앴다 — 금액 합계가 필요하면 엑셀로 내려서 보고, 확정/미확정/제외 현황은
                표 위의 필터 칩에 이미 있다(같은 숫자를 두 곳에 두면 한쪽이 어긋난다). */}
          </table>

          {rows.length === 0 && (
            <div className="py-8 text-center text-sm text-muted">
              이 기간에는 입출금내역이 없습니다. 기간을 바꿔서 확인해보세요.
            </div>
          )}
          {rows.length > 0 && sortedRows.length === 0 && (
            <div className="py-8 text-center text-sm text-muted">
              {confirmFilter === "unconfirmed"
                ? "미확정 건이 없습니다 — 이 기간은 전부 확정되었습니다."
                : "확정된 건이 없습니다."}
            </div>
          )}
        </div>
      )}

      {excludeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-md flex-col gap-4 p-6">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">제외 사유</span>
              <div className="flex gap-3">
                <select
                  value={excludeModal.category}
                  onChange={(e) =>
                    setExcludeModal((prev) =>
                      prev ? { ...prev, category: e.target.value as ExcludeReasonCategory | "" } : prev
                    )
                  }
                  autoFocus
                  className="w-32 shrink-0 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                >
                  <option value="" disabled>
                    선택
                  </option>
                  {EXCLUDE_REASON_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  value={excludeModal.reason}
                  onChange={(e) => setExcludeModal((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
                  placeholder="상세 사유"
                  className="flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setExcludeModal(null)}
                className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                disabled={!excludeModal.category}
                onClick={() => {
                  if (!excludeModal.category) return;
                  const reason = excludeModal.reason.trim()
                    ? `[${excludeModal.category}] ${excludeModal.reason.trim()}`
                    : excludeModal.category;
                  applyStatus(excludeModal.row, "excluded", reason);
                  setExcludeModal(null);
                }}
                className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {releaseConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-sm flex-col items-center gap-5 p-7 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gray-95 text-muted">
              <IconAlertCircle className="h-6 w-6" />
            </span>
            <p className="w-full text-base leading-relaxed text-fg">
              {statuses[releaseConfirm.transRefKey]?.status === "confirmed" ? "확정" : "제외"} 표시를
              해제할까요? 다시 미확정 상태로 돌아갑니다.
            </p>
            <div className="flex w-full justify-center gap-3">
              <button
                type="button"
                onClick={() => setReleaseConfirm(null)}
                className="flex-1 rounded-xl border border-border px-5 py-2.5 text-base text-muted hover:bg-gray-95 hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  applyStatus(releaseConfirm, null);
                  setReleaseConfirm(null);
                }}
                className="flex-1 rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover"
              >
                해제
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
