"use client";

import { Fragment, useState, useTransition } from "react";
import { DeleteButton } from "@/components/DeleteButton";
import { formatAmount, formatDate } from "@/lib/format";
import {
  deleteCustomsAdvance,
  setCustomsAdvancePayee,
  confirmCustomsAdvance,
  unconfirmCustomsAdvance,
  searchCustomsMatchCandidates,
  createCustomsAllocation,
  deleteCustomsAllocation,
  createCustomsFxAdjustment,
  deleteCustomsFxAdjustment,
  confirmCustomsRecovery,
  unconfirmCustomsRecovery,
  searchCustomsRecoveryMatchCandidates,
  createCustomsRecoveryAllocation,
  deleteCustomsRecoveryAllocation,
  createCustomsRecoveryFxAdjustment,
  deleteCustomsRecoveryFxAdjustment,
} from "@/app/(app)/customs/actions";
import { SortableTh } from "@/components/SortableTh";
import { sortRowsBy, toggleSort, type SortState, type SortValue } from "@/lib/tableSort";
import { PartySearchSelect, type PartyOption } from "@/components/PartySearchSelect";
import { IconCheckCircle } from "@/components/icons";
import type { AllocationDetail, FxAdjustmentDetail, MatchCandidate } from "@/lib/bankAllocation";
import { commaInput, numOf } from "@/lib/format";

export type CustomsTableRow = {
  id: string;
  blNo: string;
  // 입금(회수) 매칭에 쓰는 거래처 id — partyName/partyCode와 가리키는 대상은 같다.
  recoveryPartyId: string | null;
  partyName: string | null;
  partyCode: string | null;
  partyFromSale: boolean; // 거래처가 전표 자체가 아니라 연결된 매출에서 온 값인지
  // 지급처(실제로 돈을 받는 관세사·포워더 등) — 거래처(회수 대상 고객사)와 다를 수 있다.
  payeePartyId: string | null;
  payeePartyName: string | null;
  payeePartyCode: string | null;
  taxInvoiceNo: string | null; // 세금계산서에서 등록된 건이면 그 관리번호(O00001 등)
  // 입금(회수)은 2026-09-03부터 출금과 같은 BankAllocation 기반 매칭·확정 흐름이다.
  depositAllocations: AllocationDetail[];
  depositFxAdjustments: FxAdjustmentDetail[];
  depositAllocatedTotal: number;
  depositFullyAllocated: boolean;
  depositBasis: "supply" | "withVat" | null;
  depositDate: string | null;
  depositAmount: number | null;
  depositConfirmedAt: string | null;
  depositConfirmedByEmail: string | null;
  // 출금(대납 지급)은 2026-08-31부터 BankAllocation 기반 — 일반전표와 같은 매칭·확정 흐름.
  withdrawAllocations: AllocationDetail[];
  withdrawFxAdjustments: FxAdjustmentDetail[];
  withdrawAllocatedTotal: number;
  withdrawFullyAllocated: boolean;
  withdrawBasis: "supply" | "withVat" | null;
  withdrawDate: string | null;
  withdrawAmount: number | null;
  settlementConfirmedAt: string | null;
  settlementConfirmedByEmail: string | null;
  matched: boolean;
  paidDate: Date;
  amount: number;
  currency: string;
  fxAmount: number | null;
  fxRate: number | null;
  note: string;
  // 아래 세 값은 화면에서 열을 뺀 뒤로 쓰지 않는다(lib/customs는 계속 내려준다) — 실제 입금은
  // 입출금내역에서 가져오므로 수기 회수 기록을 이 화면에서 다루지 않기로 했다.
  recoveries: { id: string; date: Date; amount: number; note: string }[];
  recoveredTotal: number;
  outstanding: number;
};

// 관세전표는 한 건이 "출금(대납) 1회 + 입금(회수) N회"로 이뤄지는데, 예전에는 건마다 카드를
// 만들고 그 안에 회수 표를 따로 그려서 세로로 길게 늘어졌다. 지금은 **한 건 = 한 줄**로 두고
// 청구정보/회수정보를 각각 한 칸에 담는다 — 여러 건의 잔액을 한눈에 훑기 위함이다.
//
// **이 화면은 "청구 내역"이다 — 실제 현금 이동이 아니다.** 세금계산서에서 온 관세 내용은
// 관세사/포워더가 우리에게 청구한 금액이고, 실제 입금·출금은 은행 거래이므로 입출금내역
// 화면에서 가져온다. 그래서 열 이름도 "출금정보"가 아니라 "청구정보"다.
// 회수가 2건 이상이면 회수정보 칸의 "N건"을 눌러 그 줄 아래로 세부 내역을 펼친다(개별 회수
// 삭제는 거기서 한다) — 목록을 한 줄로 유지하면서도 세부 관리 기능을 잃지 않게.
type CustomsSortKey =
  | "blNo"
  | "partyCode"
  | "partyName"
  | "paidDate"
  | "depositDate"
  | "depositAmount"
  | "paidAmount"
  | "withdrawDate"
  | "withdrawAmount"
  | "note";

function customsSortValue(r: CustomsTableRow, key: CustomsSortKey): SortValue {
  switch (key) {
    case "blNo":
      return r.blNo;
    case "partyCode":
      // 거래처가 없으면(전표 미지정 + 매출도 없음) 빈 값으로 둬서 정렬 시 뒤로 밀린다.
      return r.partyName ? r.partyCode : null;
    case "partyName":
      return r.partyName;
    case "paidDate":
      // "청구정보" 칸은 청구일 + 청구액인데, 정렬 기준은 청구일로 잡는다(금액이 아니라 날짜가
      // 채권을 보는 기준이라서).
      return r.paidDate;
    case "depositDate":
      return r.depositDate;
    case "depositAmount":
      return r.depositAmount;
    case "paidAmount":
      return r.amount;
    case "withdrawDate":
      return r.withdrawDate;
    case "withdrawAmount":
      return r.withdrawAmount;
    case "note":
      return r.note;
  }
}

// 묶음의 첫 열에 주는 왼쪽 세로선. 입금 / 청구 / 출금 / 관리 묶음을 눈으로 가른다.
const GROUP = "border-l border-border pl-3";

export function CustomsTable({
  rows,
  parties,
  isAdmin,
}: {
  rows: CustomsTableRow[];
  parties: PartyOption[];
  isAdmin: boolean;
}) {
  const [sort, setSort] = useState<SortState<CustomsSortKey>>(null);
  // 지금 지급처를 고치고 있는 행(한 번에 한 줄만) — 목록엔 없던 지급처를 나중에 채우거나
  // 잘못 붙은 것을 바꿀 때 쓴다. 삭제 후 재등록하면 회수 기록·B/L 연결이 같이 사라지므로
  // 이 값만 따로 고칠 수 있게 했다.
  const [editingPayeeId, setEditingPayeeId] = useState<string | null>(null);
  const [payeePending, startPayeeTransition] = useTransition();
  const [payeeError, setPayeeError] = useState<string | null>(null);
  // 출금·입금은 완전히 독립된 두 흐름이라 어느 쪽 팝업인지 kind로 구분한다(2026-09-03,
  // 입금 매칭 추가 — 일반전표(VoucherTable)가 이미 sale/purchaseAllocation을 이렇게
  // 구분하는 것과 같은 패턴).
  type AllocKind = "customsAdvance" | "customsAdvanceRecovery";
  const directionLabel = (kind: AllocKind) => (kind === "customsAdvance" ? "출금" : "입금");

  // "확정"(1단계→2단계) 확인 팝업 — 일반전표와 같은 규칙, 100% 배분 완료된 건만 확정할 수 있다.
  const [confirmingRow, setConfirmingRow] = useState<{ row: CustomsTableRow; kind: AllocKind } | null>(null);
  const [confirmPending, startConfirmTransition] = useTransition();
  // "확정 해제" 팝업 — 관세전표는 요청/승인 흐름 없이 관리자만 직접 해제한다(2026-08-31, 이번
  // 범위는 매칭+확정까지).
  const [unconfirmModal, setUnconfirmModal] = useState<{
    id: string;
    blNo: string;
    kind: AllocKind;
    reason: string;
  } | null>(null);
  const [unconfirmError, setUnconfirmError] = useState<string | null>(null);
  const [unconfirmPending, startUnconfirmTransition] = useTransition();
  // "매칭"(배분) 팝업 — 일반전표와 같은 패턴. kind로 출금/입금을 구분한다.
  const [matchModal, setMatchModal] = useState<
    | {
        id: string;
        blNo: string;
        kind: AllocKind;
        partyId: string | null;
        amount: number;
        currency: string;
        allocatedTotal: number;
        allocations: AllocationDetail[];
        fxAdjustments: FxAdjustmentDetail[];
      }
    | null
  >(null);
  const [matchCandidates, setMatchCandidates] = useState<MatchCandidate[]>([]);
  const [matchSearch, setMatchSearch] = useState("");
  const [matchLoading, startMatchLoadTransition] = useTransition();
  const [selectedCandidate, setSelectedCandidate] = useState<MatchCandidate | null>(null);
  const [matchAmountDisplay, setMatchAmountDisplay] = useState("");
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchSavePending, startMatchSaveTransition] = useTransition();
  // 환차손익으로 정리 — 일반전표(VoucherTable)와 같은 기능(2026-09-03) — "배분" 액션 안에
  // 합쳐져 있다(VoucherTable의 fxWriteOff 주석 참고).
  const [fxWriteOff, setFxWriteOff] = useState(false);

  const onSort = (k: CustomsSortKey) => setSort((p) => toggleSort(p, k));

  function applyPayee(id: string, payeePartyId: string | null) {
    setPayeeError(null);
    startPayeeTransition(async () => {
      const result = await setCustomsAdvancePayee(id, payeePartyId);
      if (!result.ok) {
        setPayeeError(result.message);
        return;
      }
      setEditingPayeeId(null);
    });
  }

  function handleConfirm() {
    if (!confirmingRow) return;
    const { id } = confirmingRow.row;
    const kind = confirmingRow.kind;
    startConfirmTransition(async () => {
      await (kind === "customsAdvance" ? confirmCustomsAdvance(id) : confirmCustomsRecovery(id));
      setConfirmingRow(null);
    });
  }

  function handleSaveUnconfirm() {
    if (!unconfirmModal) return;
    if (!unconfirmModal.reason.trim()) {
      setUnconfirmError("확정 해제 사유를 입력하세요.");
      return;
    }
    startUnconfirmTransition(async () => {
      const result =
        unconfirmModal.kind === "customsAdvance"
          ? await unconfirmCustomsAdvance(unconfirmModal.id, unconfirmModal.reason)
          : await unconfirmCustomsRecovery(unconfirmModal.id, unconfirmModal.reason);
      if (!result.ok) {
        setUnconfirmError(result.message);
        return;
      }
      setUnconfirmModal(null);
    });
  }

  function loadMatchCandidates(kind: AllocKind, partyId: string | null, search: string) {
    startMatchLoadTransition(async () => {
      setMatchCandidates(
        await (kind === "customsAdvance"
          ? searchCustomsMatchCandidates(partyId, search)
          : searchCustomsRecoveryMatchCandidates(partyId, search))
      );
    });
  }

  function openMatchModal(r: CustomsTableRow, kind: AllocKind) {
    const isWithdraw = kind === "customsAdvance";
    const partyId = isWithdraw ? (r.payeePartyId ?? null) : r.recoveryPartyId;
    setMatchModal({
      id: r.id,
      blNo: r.blNo,
      kind,
      partyId,
      amount: r.amount,
      currency: r.currency,
      allocatedTotal: isWithdraw ? r.withdrawAllocatedTotal : r.depositAllocatedTotal,
      allocations: isWithdraw ? r.withdrawAllocations : r.depositAllocations,
      fxAdjustments: isWithdraw ? r.withdrawFxAdjustments : r.depositFxAdjustments,
    });
    setSelectedCandidate(null);
    setMatchAmountDisplay("");
    setMatchError(null);
    setMatchSearch("");
    setFxWriteOff(false);
    loadMatchCandidates(kind, partyId, "");
  }

  function selectCandidate(c: MatchCandidate) {
    if (!matchModal) return;
    setSelectedCandidate(c);
    const remaining = matchModal.amount - matchModal.allocatedTotal;
    setMatchAmountDisplay(commaInput(String(Math.round(Math.min(remaining, c.remaining)))));
    setFxWriteOff(false);
  }

  // 배분 저장 — "차액을 환차손익으로 함께 처리" 체크박스를 켰으면 배분 직후 남은 잔액도
  // 같은 동작 안에서 정리한다(VoucherTable의 같은 함수와 같은 이유).
  function handleSaveMatch() {
    if (!matchModal || !selectedCandidate) return;
    const amount = numOf(matchAmountDisplay);
    if (!(amount > 0)) {
      setMatchError("배분 금액을 입력하세요.");
      return;
    }
    startMatchSaveTransition(async () => {
      const result = await (matchModal.kind === "customsAdvance"
        ? createCustomsAllocation(matchModal.id, selectedCandidate.transRefKey, amount)
        : createCustomsRecoveryAllocation(matchModal.id, selectedCandidate.transRefKey, amount));
      if (!result.ok) {
        setMatchError(result.message);
        return;
      }
      if (fxWriteOff) {
        const fxResult = await (matchModal.kind === "customsAdvance"
          ? createCustomsFxAdjustment(matchModal.id)
          : createCustomsRecoveryFxAdjustment(matchModal.id));
        if (!fxResult.ok) {
          setMatchError(fxResult.message);
          return;
        }
      }
      setMatchModal(null);
    });
  }

  function handleDeleteAllocation(allocationId: string) {
    setMatchError(null);
    const kind = matchModal?.kind ?? "customsAdvance";
    startMatchSaveTransition(async () => {
      const result = await (kind === "customsAdvance"
        ? deleteCustomsAllocation(allocationId)
        : deleteCustomsRecoveryAllocation(allocationId));
      if (!result.ok) {
        setMatchError(result.message);
        return;
      }
      setMatchModal(null);
    });
  }

  function handleDeleteFxAdjustment(adjustmentId: string) {
    setMatchError(null);
    const kind = matchModal?.kind ?? "customsAdvance";
    startMatchSaveTransition(async () => {
      const result = await (kind === "customsAdvance"
        ? deleteCustomsFxAdjustment(adjustmentId)
        : deleteCustomsRecoveryFxAdjustment(adjustmentId));
      if (!result.ok) {
        setMatchError(result.message);
        return;
      }
      setMatchModal(null);
    });
  }

  // 회수 세부 줄은 대표 줄 바로 아래에 렌더되므로(펼침 상태), 대표 줄만 정렬하면 자동으로 따라온다.
  const sortedRows = sortRowsBy(rows, sort, customsSortValue);

  return (
    <>
    <div className="card overflow-x-auto p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <SortableTh label="B/L" sortKey="blNo" state={sort} onSort={onSort} />
            <SortableTh label="거래처코드" sortKey="partyCode" state={sort} onSort={onSort} />
            <SortableTh label="거래처명" sortKey="partyName" state={sort} onSort={onSort} />
            {/* 거래처(위)는 회수 대상 고객사, 지급처는 실제 돈을 지급받는 관세사·포워더 —
                서로 다른 회사라 출금 매칭도 이 값을 따로 쓴다(bankAllocation.ts 참고).
                지정/변경 버튼이 같이 들어가는 칸이라 정렬 대상으로 두지 않는다. */}
            <th className="py-2 pr-3">지급처</th>
            {/* 세 묶음(입금 / 청구 / 출금)을 왼쪽 세로선으로 갈라서 어디까지가 한 묶음인지 보이게
                한다 — 열이 6개나 붙어 있으면 어느 날짜가 어느 금액의 짝인지 헷갈린다.
                각 묶음의 **첫 열**에만 선을 준다. */}
            <SortableTh label="입금일" sortKey="depositDate" state={sort} onSort={onSort} className={GROUP} />
            <SortableTh label="입금액" sortKey="depositAmount" state={sort} onSort={onSort} align="right" />
            <SortableTh label="청구일" sortKey="paidDate" state={sort} onSort={onSort} className={GROUP} />
            <SortableTh label="청구액" sortKey="paidAmount" state={sort} onSort={onSort} align="right" />
            <SortableTh label="출금일" sortKey="withdrawDate" state={sort} onSort={onSort} className={GROUP} />
            <SortableTh label="출금액" sortKey="withdrawAmount" state={sort} onSort={onSort} align="right" />
            {/* 매칭·관리(확정·삭제)는 버튼 열이라 정렬 대상이 아니다. */}
            <th className="py-2 pr-3 text-left font-normal">매칭</th>
            <SortableTh label="비고" sortKey="note" state={sort} onSort={onSort} className={GROUP} />
            <th className="py-2 pr-2 text-right">관리</th>
          </tr>
        </thead>
        <tbody>
          {/* 헤더와 첫 줄 사이도 다른 줄 사이 간격과 똑같이 살짝 띄운다(2026-08-27). */}
          <tr aria-hidden="true">
            <td colSpan={13} className="h-2" />
          </tr>
          {sortedRows.map((r) => {
            return (
              <Fragment key={r.id}>
              <tr
                className={`border-b border-border/60${
                  r.settlementConfirmedAt || r.depositConfirmedAt ? " bg-accent-soft" : ""
                }`}
              >
                  <td className="py-2 pr-3 whitespace-nowrap font-medium text-fg">
                    {r.blNo}
                    {/* 세금계산서에서 등록된 게 아니라 이 화면에서 직접 입력한 건임을 표시한다
                        (2026-08-27) — taxInvoiceNo가 없으면 세금계산서 화면을 거치지 않은
                        수기기입이다. */}
                    {!r.taxInvoiceNo && (
                      <span
                        className="ml-1.5 rounded bg-gray-95 px-1.5 py-0.5 text-xs font-normal text-muted"
                        title="세금계산서 화면을 거치지 않고 이 화면에서 직접 입력한 건입니다."
                      >
                        수기기입
                      </span>
                    )}
                  </td>
                  {/* 관세대납은 거래처를 직접 들고 있지 않고 B/L로 매출에 연결돼서 거래처가 붙는다 —
                      매출이 아직 없으면 코드는 "-", 이름 칸에 "매출 미등록"을 띄운다. */}
                  {/* 거래처는 전표에 직접 지정된 값이 우선이고, 없으면 B/L로 연결된 매출에서
                      빌려온다(lib/customs.ts 참고). 빌려온 값에는 "(매출)"을 붙여 구분한다 —
                      그 매출이 지워지면 사라지는 값이라 직접 지정된 것과 성질이 다르다. */}
                  <td className="py-2 pr-3 whitespace-nowrap num text-muted">
                    {r.partyName ? (r.partyCode ?? "-") : "-"}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {r.partyName ? (
                      <span className="text-muted">
                        {r.partyName}
                        {r.partyFromSale && (
                          <span className="ml-1 text-xs text-muted/70" title="이 전표에 거래처가 지정되지 않아, B/L로 연결된 매출의 거래처를 보여주고 있습니다.">
                            (매출)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted" title="이 전표에 거래처가 지정되지 않았고, 이 B/L로 등록된 매출도 없습니다.">
                        -
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {editingPayeeId === r.id ? (
                      <div className="flex items-center gap-1">
                        <PartySearchSelect
                          parties={parties}
                          value={r.payeePartyId}
                          onChange={(id) => applyPayee(r.id, id)}
                          placeholder="코드/거래처명"
                          disabled={payeePending}
                          className="w-44"
                        />
                        <button
                          type="button"
                          onClick={() => setEditingPayeeId(null)}
                          className="text-xs text-muted hover:underline"
                        >
                          닫기
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        {r.payeePartyName ? (
                          <span className="text-muted" title="실제로 이 대납금을 지급받는 대상 — 회수 대상 거래처와 다를 수 있습니다.">
                            {r.payeePartyName}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">미지정</span>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditingPayeeId(r.id)}
                          className="text-xs text-accent hover:underline"
                        >
                          {r.payeePartyName ? "변경" : "지정"}
                        </button>
                      </div>
                    )}
                  </td>
                  {/* ── 입금 묶음: 입출금내역에서 찾은 실제 입금(청구액·거래처가 같은 거래) ── */}
                  <td className={`py-2 pr-3 whitespace-nowrap num text-muted ${GROUP}`}>
                    {r.depositDate ?? (
                      <span
                        className="text-xs"
                        title="청구액·거래처가 같은 은행 입금을 찾지 못했습니다. 해당 기간을 입출금내역에서 아직 조회하지 않았을 수도 있습니다."
                      >
                        -
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right num text-pos">
                    {/* 입금(회수)도 2026-09-03부터 출금과 같은 배분·확정 흐름이다 — 별도 열을
                        새로 만드는 대신 이 칸 안에 매칭/확정 컨트롤을 같이 담는다(열 구조를
                        건드리지 않기 위함). */}
                    <div className="flex flex-col items-end gap-0.5 leading-tight">
                      {r.depositAmount != null ? (
                        <>
                          <span>{formatAmount(r.depositAmount)}</span>
                          <span
                            className="text-[11px] font-normal text-muted"
                            title={
                              r.depositBasis === "withVat"
                                ? `청구액 ${formatAmount(r.amount)}(공급가액)에 세금계산서 부가세를 더한 실제 입금액입니다.`
                                : `청구액(공급가액) ${formatAmount(r.amount)}과 그대로 일치하는 입금액입니다.`
                            }
                          >
                            {!r.depositFullyAllocated && `${formatAmount(r.amount)} 중 `}
                            {r.depositBasis === "withVat" ? "순입금액" : "공급가액기준"}
                          </span>
                        </>
                      ) : (
                        "-"
                      )}
                      {r.depositConfirmedAt ? (
                        <div className="flex items-center gap-1.5">
                          <span
                            className="flex items-center gap-1 text-[11px] font-medium text-accent"
                            title={
                              r.depositConfirmedByEmail
                                ? `${r.depositConfirmedByEmail} · ${new Date(r.depositConfirmedAt).toLocaleString("ko-KR")} 확정`
                                : "확정됨"
                            }
                          >
                            <IconCheckCircle className="h-3 w-3" />
                            확정됨
                          </span>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => {
                                setUnconfirmError(null);
                                setUnconfirmModal({ id: r.id, blNo: r.blNo, kind: "customsAdvanceRecovery", reason: "" });
                              }}
                              className="text-[11px] text-muted hover:underline"
                            >
                              해제
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openMatchModal(r, "customsAdvanceRecovery")}
                            className="text-xs text-accent hover:underline"
                          >
                            매칭
                          </button>
                          {r.depositFullyAllocated && (
                            <button
                              type="button"
                              onClick={() => setConfirmingRow({ row: r, kind: "customsAdvanceRecovery" })}
                              className="text-xs text-accent hover:underline"
                            >
                              확정
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>

                  {/* ── 청구 묶음: 우리에게 청구된 관세. 현금 이동이 아니다 ── */}
                  <td className={`py-2 pr-3 whitespace-nowrap num text-muted ${GROUP}`}>
                    {formatDate(r.paidDate)}
                  </td>
                  <td className="py-2 pr-3 text-right num font-medium text-fg">
                    {r.currency !== "KRW" && r.fxAmount != null && r.fxRate != null ? (
                      <div className="flex flex-col items-end gap-0.5 leading-tight">
                        <span>{formatAmount(r.amount)}</span>
                        <span className="text-[11px] font-normal text-muted">
                          {r.currency} {r.fxAmount.toLocaleString("ko-KR")} × 환율 {r.fxRate.toLocaleString("ko-KR")}
                        </span>
                      </div>
                    ) : (
                      formatAmount(r.amount)
                    )}
                  </td>

                  {/* ── 출금 묶음: 입출금내역에서 찾은 실제 출금 ── */}
                  <td className={`py-2 pr-3 whitespace-nowrap num text-muted ${GROUP}`}>
                    {r.withdrawDate ?? (
                      <span
                        className="text-xs"
                        title="청구액·거래처가 같은 은행 출금을 찾지 못했습니다. 해당 기간을 입출금내역에서 아직 조회하지 않았을 수도 있습니다."
                      >
                        -
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right num text-neg">
                    <div className="flex flex-col items-end leading-tight">
                      {r.withdrawAmount != null ? (
                        <>
                          <span>{formatAmount(r.withdrawAmount)}</span>
                          <span
                            className="text-[11px] font-normal text-muted"
                            title={
                              r.withdrawBasis === "withVat"
                                ? `청구액 ${formatAmount(r.amount)}(공급가액)에 세금계산서 부가세를 더한 실제 출금액입니다.`
                                : `청구액(공급가액) ${formatAmount(r.amount)}과 그대로 일치하는 출금액입니다.`
                            }
                          >
                            {!r.withdrawFullyAllocated && `${formatAmount(r.amount)} 중 `}
                            {r.withdrawBasis === "withVat" ? "순출금액" : "공급가액기준"}
                          </span>
                        </>
                      ) : (
                        "-"
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {!r.settlementConfirmedAt && (
                      <button
                        type="button"
                        onClick={() => openMatchModal(r, "customsAdvance")}
                        className="text-xs text-accent hover:underline"
                      >
                        매칭
                      </button>
                    )}
                  </td>

                  <td className={`max-w-[140px] truncate py-2 pr-3 text-muted ${GROUP}`} title={r.note}>
                    {r.note || "-"}
                  </td>
                  <td className="py-2 pr-2 text-right whitespace-nowrap">
                    {r.settlementConfirmedAt ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <span
                          className="flex items-center gap-1 text-xs font-medium text-accent"
                          title={
                            r.settlementConfirmedByEmail
                              ? `${r.settlementConfirmedByEmail} · ${new Date(r.settlementConfirmedAt).toLocaleString("ko-KR")} 확정`
                              : "확정됨"
                          }
                        >
                          <IconCheckCircle className="h-3.5 w-3.5" />
                          확정됨
                        </span>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              setUnconfirmError(null);
                              setUnconfirmModal({ id: r.id, blNo: r.blNo, kind: "customsAdvance", reason: "" });
                            }}
                            className="text-xs text-muted hover:underline"
                          >
                            해제
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        {r.withdrawFullyAllocated && (
                          <button
                            type="button"
                            onClick={() => setConfirmingRow({ row: r, kind: "customsAdvance" })}
                            className="mr-2 text-xs text-accent hover:underline"
                          >
                            확정
                          </button>
                        )}
                        <DeleteButton
                          action={deleteCustomsAdvance}
                          id={r.id}
                          confirmMessage={`"${r.blNo}" 관세 청구 건을 삭제할까요?`}
                          reasonMessages={{ confirmed: "확정된 건은 관리자가 해제하기 전까지 삭제할 수 없습니다." }}
                        />
                      </>
                    )}
                  </td>
              </tr>
              {/* 세금계산서 화면과 같은 이유로, 행 사이를 살짝 띄워서 한 줄씩 더 잘 읽히게
                  한다(2026-08-27). */}
              <tr aria-hidden="true">
                <td colSpan={13} className="h-2" />
              </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {payeeError && <div className="mt-2 text-sm text-neg">{payeeError}</div>}

      {rows.length === 0 && (
        <div className="py-8 text-center text-sm text-muted">등록된 관세대납이 없습니다.</div>
      )}
    </div>

    {/* "확정" 확인 팝업 — 일반전표와 같은 규칙(100% 배분 완료된 건만 확정할 수 있다). */}
    {confirmingRow && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card flex w-full max-w-sm flex-col items-center gap-5 p-7 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
            <IconCheckCircle className="h-6 w-6" />
          </span>
          <p className="w-full text-base leading-relaxed text-fg">
            B/L &quot;{confirmingRow.row.blNo}&quot; 건의 {directionLabel(confirmingRow.kind)}을 확정할까요?
            {confirmingRow.kind === "customsAdvance" && " 확정 후에는 관리자가 해제하기 전까지 삭제할 수 없습니다."}
          </p>
          <div className="flex w-full justify-center gap-3">
            <button
              type="button"
              onClick={() => setConfirmingRow(null)}
              className="flex-1 rounded-xl border border-border px-5 py-2.5 text-base text-muted hover:bg-gray-95 hover:text-fg"
            >
              취소
            </button>
            <button
              type="button"
              disabled={confirmPending}
              onClick={handleConfirm}
              className="flex-1 rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              {confirmPending ? "확정 중..." : "확정"}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* "확정 해제" 팝업 — 관리자만, 사유 필수(요청/승인 흐름은 이번 범위 밖). */}
    {unconfirmModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card flex w-full max-w-md flex-col gap-5 p-7">
          <h3 className="text-lg font-semibold text-fg">{directionLabel(unconfirmModal.kind)} 확정 해제</h3>
          <p className="text-sm text-muted">
            B/L &quot;{unconfirmModal.blNo}&quot; 건의 {directionLabel(unconfirmModal.kind)} 확정을 해제합니다. 해제하면
            다시 배분을 고칠 수 있습니다.
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted">해제 사유</label>
            <textarea
              value={unconfirmModal.reason}
              onChange={(e) => setUnconfirmModal((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
              rows={3}
              placeholder="예: 금액 오기입 정정, 거래처 재확인 등"
              className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
            />
          </div>
          {unconfirmError && <div className="text-sm text-neg">{unconfirmError}</div>}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setUnconfirmModal(null)}
              className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
            >
              취소
            </button>
            <button
              type="button"
              disabled={unconfirmPending}
              onClick={handleSaveUnconfirm}
              className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              {unconfirmPending ? "해제 중..." : "해제"}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* "매칭"(배분) 팝업 — 일반전표와 같은 패턴. kind로 출금/입금을 구분한다. */}
    {matchModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card flex w-full max-w-3xl flex-col gap-4 p-7">
          <div>
            <h3 className="text-lg font-semibold text-fg">
              {directionLabel(matchModal.kind)} 매칭 — {matchModal.blNo}
            </h3>
            <p className="mt-1 text-sm text-muted">
              청구액 {formatAmount(matchModal.amount)} 중 {formatAmount(matchModal.allocatedTotal)} 배분됨
              {matchModal.amount - matchModal.allocatedTotal > 0 && (
                <> · 잔액 {formatAmount(matchModal.amount - matchModal.allocatedTotal)}</>
              )}
            </p>
          </div>

          {(matchModal.allocations.length > 0 || matchModal.fxAdjustments.length > 0) && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
              <span className="text-xs font-medium text-muted">배분된 내역</span>
              {matchModal.allocations.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm">
                  <span className="text-fg">
                    {a.date} · {formatAmount(a.amount)}
                    {a.auto && <span className="ml-1 text-xs text-muted">(자동)</span>}
                  </span>
                  <button
                    type="button"
                    disabled={matchSavePending}
                    onClick={() => handleDeleteAllocation(a.id)}
                    className="text-xs text-muted hover:underline disabled:opacity-50"
                  >
                    배분 취소
                  </button>
                </div>
              ))}
              {matchModal.fxAdjustments.map((a) => (
                <div key={a.id} className="flex items-center justify-between text-sm">
                  <span className="text-fg">
                    {a.date} · {formatAmount(a.amount)}
                    <span className="ml-1 text-xs text-accent" title={a.note}>
                      (환차손익 정리)
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={matchSavePending}
                    onClick={() => handleDeleteFxAdjustment(a.id)}
                    className="text-xs text-muted hover:underline disabled:opacity-50"
                  >
                    정리 취소
                  </button>
                </div>
              ))}
            </div>
          )}

          {matchModal.amount - matchModal.allocatedTotal > 0.5 && (
            <>
              <input
                value={matchSearch}
                onChange={(e) => {
                  setMatchSearch(e.target.value);
                  loadMatchCandidates(matchModal.kind, matchModal.partyId, e.target.value);
                }}
                placeholder="송금인/적요로 검색"
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
              <div className="flex max-h-64 flex-col overflow-y-auto rounded-lg border border-border">
                <div
                  className="grid gap-2 border-b border-border bg-gray-95 px-2.5 py-1.5 text-xs font-medium text-muted"
                  style={{ gridTemplateColumns: "84px 1fr 60px 104px 104px 104px" }}
                >
                  <span>입출금일</span>
                  <span>거래처</span>
                  <span>일치여부</span>
                  <span className="text-right">{matchModal.kind === "customsAdvance" ? "출금액" : "입금액"}</span>
                  <span className="text-right">분배액</span>
                  <span className="text-right">미분배잔액</span>
                </div>
                {matchLoading ? (
                  <div className="p-3 text-center text-sm text-muted">불러오는 중...</div>
                ) : matchCandidates.length === 0 ? (
                  <div className="p-3 text-center text-sm text-muted">
                    확정된 입출금내역 중 배분 가능한 거래가 없습니다.
                  </div>
                ) : (
                  matchCandidates.map((c) => (
                    <button
                      key={c.transRefKey}
                      type="button"
                      onClick={() => selectCandidate(c)}
                      className={`grid items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-gray-95 ${
                        selectedCandidate?.transRefKey === c.transRefKey ? "bg-accent-soft" : ""
                      }`}
                      style={{ gridTemplateColumns: "84px 1fr 60px 104px 104px 104px" }}
                    >
                      <span className="text-fg">{c.date}</span>
                      <span className="truncate text-fg">{c.remark}</span>
                      <span>
                        {c.partyMatched ? (
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent">일치</span>
                        ) : (
                          <span className="text-muted">-</span>
                        )}
                      </span>
                      <span className="num text-right text-fg">{formatAmount(c.amount)}</span>
                      <span className="num text-right text-muted">{formatAmount(c.amount - c.remaining)}</span>
                      <span className="num text-right text-muted">{formatAmount(c.remaining)}</span>
                    </button>
                  ))
                )}
              </div>

              {selectedCandidate && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-muted">배분 금액</label>
                    <input
                      value={matchAmountDisplay}
                      onChange={(e) => setMatchAmountDisplay(commaInput(e.target.value))}
                      inputMode="decimal"
                      className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-right text-sm text-fg num"
                    />
                  </div>
                  {/* 배분 금액을 잔액보다 적게 입력했다는 건, 이 은행거래가 실제로 받은/보낸
                      진짜 금액은 그거고 나머지는 외화 입력 시점 환율과 실제 결제 환율의 차이라는
                      뜻일 수 있다 — 체크하면 배분과 동시에 그 차액을 환차손익으로 정리한다
                      (2026-09-03, VoucherTable과 같은 방식). */}
                  {matchModal.currency !== "KRW" &&
                    matchModal.amount - matchModal.allocatedTotal - numOf(matchAmountDisplay) > 0.5 && (
                      <label className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft/40 p-2.5 text-sm text-fg">
                        <input
                          type="checkbox"
                          checked={fxWriteOff}
                          onChange={(e) => setFxWriteOff(e.target.checked)}
                          className="h-4 w-4 accent-accent"
                        />
                        차액{" "}
                        {formatAmount(matchModal.amount - matchModal.allocatedTotal - numOf(matchAmountDisplay))}원을
                        환차손익으로 함께 처리
                      </label>
                    )}
                </div>
              )}
            </>
          )}

          {matchError && <div className="text-sm text-neg">{matchError}</div>}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setMatchModal(null)}
              className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
            >
              닫기
            </button>
            {selectedCandidate && (
              <button
                type="button"
                disabled={matchSavePending}
                onClick={handleSaveMatch}
                className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {matchSavePending ? "배분 중..." : "배분"}
              </button>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
