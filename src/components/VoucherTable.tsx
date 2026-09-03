"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import { updateSale, deleteSale } from "@/app/(app)/sales/actions";
import { updatePurchase, deletePurchase } from "@/app/(app)/purchases/actions";
import {
  confirmVoucher,
  unconfirmVoucher,
  requestUnconfirm,
  approveUnconfirmRequest,
  rejectUnconfirmRequest,
  searchMatchCandidates,
  createManualAllocation,
  deleteAllocation,
  createFxAdjustment,
  deleteFxAdjustment,
  type VoucherKind,
} from "@/app/(app)/vouchers/actions";
import { commaInput, numOf, formatAmount, formatDate } from "@/lib/format";
import { DeleteButton } from "@/components/DeleteButton";
import { SortableTh } from "@/components/SortableTh";
import { sortGroupedRowsBy, toggleSort, type SortState, type SortValue } from "@/lib/tableSort";
import { IconPlus, IconMinus, IconTreeConnector, IconCheckCircle } from "@/components/icons";
import type { AllocationDetail, FxAdjustmentDetail, MatchCandidate } from "@/lib/bankAllocation";

export type VoucherRow = {
  id: string; // Purchase.id 또는 Sale.id — 수정·삭제(전표 단위 동작) 대상
  // 매칭·확정 대상 id. 매출은 id와 같고, 매입은 B/L 배분(PurchaseAllocation) 단위라 blIndex별로
  // 다르다(2026-08-31, "예일해운항공 13건 묶음 중 일부만 출금"처럼 B/L별로 따로 매칭·확정하기
  // 위해 Purchase 전체가 아니라 여기로 내렸다).
  settleId: string;
  date: Date;
  kind: "sale" | "purchase";
  partyId: string;
  partyName: string;
  partyCode: string | null;
  taxInvoiceNo: string | null; // 세금계산서에서 등록된 전표면 그 관리번호(I00001/O00001), 아니면 null
  blNo: string;
  // 이 배분 줄의 명칭. 세금계산서에 없는 금액(부가세·영세율·해외운임 등)에만 값이 있고,
  // 세금계산서 대상 금액은 빈 값이다.
  allocLabel: string;
  amount: number; // 이 B/L에 해당하는 금액 — 배분이 여러 건인 매입이면 전표 총액이 아니라 배분액
  // 외화로 수기입력된 건에만 채워진다("KRW"면 fxAmount/fxRate는 항상 null) — amount는 이미
  // 원화로 환산된 값이다(CustomsTable과 같은 방식).
  currency: string;
  fxAmount: number | null;
  fxRate: number | null;
  note: string;
  locked: boolean; // 세금계산서에서 등록됐거나(ntsSendKey 있음), 매입인데 배분이 여러 건이라 수정 불가
  // 한 전표가 여러 B/L로 배분되어 여러 줄로 펼쳐질 때 몇 번째 줄인지. 수정·삭제 버튼은 전표
  // 단위 동작이라 첫 줄(blIndex === 0)에만 둔다 — 줄마다 삭제 버튼이 있으면 그 B/L만 지워지는
  // 것처럼 보이는데, 실제로는 전표 전체가 지워진다. 매칭·확정은 반대로 **줄마다** 따로 동작한다.
  blIndex: number;
  blCount: number;
  // 이 줄에 배분된 실제 입출금 내역(여러 은행거래에 나뉠 수 있다) — **매출은 입금, 매입은
  // 출금**이다(2026-08-31, 저장되는 배분 기반. bankAllocation.ts 참고).
  allocations: AllocationDetail[];
  // 외화 전표에서, 입력 시점 환율과 실제 결제 환율의 차이로 남는 잔액을 은행거래 없이 직접
  // 정리한 내역(bankAllocation.ts createFxAdjustment 참고). allocatedTotal에 이미 합산되어
  // 있다 — 확정 판정은 그 값만 보면 되고, 이 배열은 매칭 팝업에 정리 내역을 보여줄 때만 쓴다.
  fxAdjustments: FxAdjustmentDetail[];
  allocatedTotal: number;
  fullyAllocated: boolean; // 100% 배분 완료 — 이래야 확정할 수 있다.
  // 입출금 완료(1단계)를 사람이 최종 검토해서 확정(2단계)한 시각 — 값이 있으면 관리자가
  // 해제하기 전까지 수정·삭제할 수 없다.
  settlementConfirmedAt: string | null;
  settlementConfirmedByEmail: string | null;
  // 관리자가 아닌 사용자가 올린 "확정 해제 요청" — 대기 중인 요청이 있으면 값이 있다.
  pendingUnconfirmRequest: { id: string; reason: string; requestedByEmail: string; createdAt: string } | null;
};

// 묶음의 첫 열에 주는 왼쪽 세로선(관세전표와 같은 방식).
const GROUP = "border-l border-border pl-3";

// 입출금일·공급가액·세액·입출금액 네 칸은 폭이 들쭉날쭉하지 않도록 같은 너비로 고정한다(2026-08-27).
const SETTLE_COL = "w-24";

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// 화면 표시용 kind("sale"|"purchase")와 매칭·확정 액션의 kind("sale"|"purchaseAllocation")는
// 이름이 다르다 — 매입은 B/L 배분 단위로 확정하기 때문(VoucherRow.settleId 주석 참고).
function voucherKindOf(r: VoucherRow): VoucherKind {
  return r.kind === "sale" ? "sale" : "purchaseAllocation";
}

type VoucherSortKey =
  | "date"
  | "kind"
  | "taxInvoiceNo"
  | "partyCode"
  | "partyName"
  | "blNo"
  | "amount"
  | "settledDate"
  | "settledAmount"
  | "note";

function voucherSortValue(r: VoucherRow, key: VoucherSortKey): SortValue {
  switch (key) {
    case "date":
      return r.date;
    case "kind":
      // "매출"/"매입"으로 정렬해야 화면에 보이는 글자와 순서가 맞는다(sale/purchase로 하면
      // 화면에는 매입이 먼저인데 값으로는 purchase가 뒤라 어긋난다).
      return r.kind === "sale" ? "매출" : "매입";
    case "taxInvoiceNo":
      return r.taxInvoiceNo;
    case "partyCode":
      return r.partyCode;
    case "partyName":
      return r.partyName;
    case "blNo":
      // 미발행 줄은 B/L이 없으니 명칭으로 정렬한다(빈 값이면 뒤로 밀린다).
      return r.blNo || r.allocLabel;
    case "amount":
      return r.amount;
    case "settledDate":
      return r.allocations[0]?.date ?? null;
    case "settledAmount":
      return r.allocatedTotal || null;
    case "note":
      return r.note;
  }
}

// 같은 전표(kind+id)의 B/L 배분 줄들을 한 단위로 묶은 것 — 정렬 뒤에도 항상 붙어 있다
// (sortGroupedRowsBy가 보장).
type Entry = { key: string; kind: "sale" | "purchase"; id: string; subRows: VoucherRow[] };

const COLSPAN = 14;

// 실제 입출금액을 공급가액·세액으로 나눠 보여준다 — 공급가액은 항상 전표 금액(r.amount)
// 그대로이고, 세액은 배분 합계 중 그 나머지다(여러 은행거래에 나뉘어 배분됐어도 합계만 보면
// 되므로 그대로 적용된다, 2026-08-31).
function settledBreakdown(r: VoucherRow): { supply: number; tax: number; total: number } | null {
  if (r.allocatedTotal <= 0) return null;
  const total = r.allocatedTotal;
  const tax = Math.max(0, total - r.amount);
  return { supply: r.amount, tax, total };
}

export function VoucherTable({
  rows,
  parties,
  isAdmin,
}: {
  rows: VoucherRow[];
  parties: { id: string; name: string }[];
  isAdmin: boolean;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [partyId, setPartyId] = useState("");
  const [blNo, setBlNo] = useState("");
  const [amountDisplay, setAmountDisplay] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [sort, setSort] = useState<SortState<VoucherSortKey>>(null);
  // 같은 세금계산서(승인번호)에서 여러 전표로 나뉜 건들을 펼쳐서 볼지 — 세금계산서 화면의
  // "N건 묶음"과 같은 방식이다(2026-08-27).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // "확정"(1단계→2단계) 확인 팝업 — 어느 줄을 확정하려는지만 들고 있는다.
  const [confirmingRow, setConfirmingRow] = useState<VoucherRow | null>(null);
  const [confirmPending, startConfirmTransition] = useTransition();
  // "확정 해제" 팝업 — 사유가 필수라 DeleteButton과 달리 별도 상태로 관리한다. mode가
  // "direct"면 관리자가 바로 해제하고, "request"면 관리자가 아닌 사용자가 사유를 남겨
  // 해제를 요청만 한다(2026-08-31).
  const [unconfirmModal, setUnconfirmModal] = useState<
    { mode: "direct" | "request"; kind: VoucherKind; id: string; blNo: string; reason: string } | null
  >(null);
  const [unconfirmError, setUnconfirmError] = useState<string | null>(null);
  const [unconfirmPending, startUnconfirmTransition] = useTransition();
  // 관리자의 요청 승인/거절 — 어느 요청에서 실패했는지 알아야 그 줄에만 오류를 보여줄 수 있다.
  const [decideError, setDecideError] = useState<{ requestId: string; message: string } | null>(null);
  const [decidePending, startDecideTransition] = useTransition();
  // "거절" 사유 팝업 — 거절도 되돌림 동작이라 사유를 반드시 남긴다(2026-08-31).
  const [rejectModal, setRejectModal] = useState<{ requestId: string; blNo: string; note: string } | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  // "매칭"(입출금 배분) 팝업 — 자동으로 안 붙은 경우 수기로 은행거래를 골라 배분한다
  // (2026-08-31). 팝업을 여는 시점의 행 정보를 그대로 들고 있다가, 배분 저장/취소가 끝나면
  // 닫는다 — 다시 열면 서버에서 새로 내려온 값으로 갱신된다.
  const [matchModal, setMatchModal] = useState<
    {
      kind: VoucherKind;
      settleId: string;
      blNo: string;
      partyId: string;
      amount: number;
      currency: string;
      allocatedTotal: number;
      allocations: VoucherRow["allocations"];
      fxAdjustments: VoucherRow["fxAdjustments"];
    } | null
  >(null);
  const [matchCandidates, setMatchCandidates] = useState<MatchCandidate[]>([]);
  const [matchSearch, setMatchSearch] = useState("");
  const [matchLoading, startMatchLoadTransition] = useTransition();
  const [selectedCandidate, setSelectedCandidate] = useState<MatchCandidate | null>(null);
  const [matchAmountDisplay, setMatchAmountDisplay] = useState("");
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchSavePending, startMatchSaveTransition] = useTransition();
  // 환차손익으로 정리 — 외화 전표에서 은행거래로는 안 채워지는 남은 잔액을 사유와 함께 직접
  // 정리한다(2026-09-03). "매칭" 팝업 안에 붙는 작은 기능이라 별도 팝업을 만들지 않았다.
  const [fxNote, setFxNote] = useState("");

  // 한 전표가 B/L별로 여러 줄로 펼쳐지므로 **줄 단위가 아니라 전표 단위로** 정렬한다 —
  // 줄 단위로 정렬하면 같은 전표의 줄들이 흩어져 왼쪽 연결선이 무의미해진다. 정렬 값은 그 전표의
  // 첫 줄에서 뽑으므로, B/L·금액처럼 줄마다 다른 열로 정렬하면 "첫 배분 기준"으로 정렬된다.
  const sortedRows = sortGroupedRowsBy(rows, sort, (r) => `${r.kind}-${r.id}`, voucherSortValue);
  function handleSort(key: VoucherSortKey) {
    setSort((prev) => toggleSort(prev, key));
    // 정렬하면 행 순서가 바뀌므로 편집 중이던 폼은 닫는다(다른 행을 고치고 있다고 착각하기 쉽다).
    setEditingKey(null);
  }

  // 정렬된 줄들을 다시 전표(entry) 단위로 묶는다 — blIndex 줄들은 항상 붙어 있으므로 순서대로
  // 훑으며 key가 바뀔 때만 새 entry를 만들면 된다.
  const entries: Entry[] = [];
  const entryByKey = new Map<string, Entry>();
  for (const r of sortedRows) {
    const key = `${r.kind}-${r.id}`;
    let e = entryByKey.get(key);
    if (!e) {
      e = { key, kind: r.kind, id: r.id, subRows: [] };
      entryByKey.set(key, e);
      entries.push(e);
    }
    e.subRows.push(r);
  }

  // 같은 세금계산서(taxInvoiceNo)에서 나온 전표가 둘 이상이면 묶음 후보다 — 세금계산서 1건을
  // 여러 B/L로 나눠 등록하면(매출) 또는 여러 세금계산서를 묶어 등록하면(매입) 서로 다른
  // 전표(id)가 같은 승인번호를 공유한다.
  const entriesByTaxInvoiceNo = new Map<string, Entry[]>();
  for (const e of entries) {
    const tn = e.subRows[0].taxInvoiceNo;
    if (!tn) continue;
    const arr = entriesByTaxInvoiceNo.get(tn) ?? [];
    arr.push(e);
    entriesByTaxInvoiceNo.set(tn, arr);
  }
  // 묶음 기준은 "같은 세금계산서코드의 줄이 2개 이상"이다 — 서로 다른 전표 여러 건이 한
  // 승인번호를 공유하는 경우뿐 아니라, 매입 한 건이 여러 B/L로 배분되어 그 자체로 여러
  // 줄인 경우(예: O00041)도 마찬가지로 묶는다(2026-08-27, 후자를 놓쳤던 버그 수정).
  const bundleKeyOf = new Map<string, string>(); // entry.key -> taxInvoiceNo
  for (const [tn, es] of entriesByTaxInvoiceNo) {
    const totalRows = es.reduce((sum, e) => sum + e.subRows.length, 0);
    if (totalRows > 1) for (const e of es) bundleKeyOf.set(e.key, tn);
  }

  function toggleGroup(taxInvoiceNo: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(taxInvoiceNo)) next.delete(taxInvoiceNo);
      else next.add(taxInvoiceNo);
      return next;
    });
  }

  function startEdit(r: VoucherRow) {
    setEditingKey(`${r.kind}-${r.id}`);
    setDate(toDateInputValue(r.date));
    setPartyId(r.partyId);
    setBlNo(r.blNo);
    setAmountDisplay(commaInput(String(r.amount)));
    setNote(r.note);
    setError(null);
  }

  function cancelEdit() {
    setEditingKey(null);
    setError(null);
  }

  function saveEdit(r: VoucherRow) {
    setError(null);
    const amount = numOf(amountDisplay);
    startTransition(async () => {
      const result =
        r.kind === "sale"
          ? await updateSale({ id: r.id, blNo, date, partyId, amount, note })
          : await updatePurchase({ id: r.id, blNo, date, partyId, amount, note });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEditingKey(null);
    });
  }

  function handleConfirmVoucher() {
    if (!confirmingRow) return;
    const r = confirmingRow;
    startConfirmTransition(async () => {
      await confirmVoucher(voucherKindOf(r), r.settleId);
      setConfirmingRow(null);
    });
  }

  // 확정 팝업이 열려 있는 동안 Enter로도 바로 확정할 수 있게 한다 — 수기기입 팝업들과 같은
  // 관례(2026-08-27). 입력 칸이 없는 단순 확인 팝업이라 폼 대신 키보드 이벤트로 처리한다.
  useEffect(() => {
    if (!confirmingRow) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirmVoucher();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmingRow]);

  function handleSaveUnconfirm() {
    if (!unconfirmModal) return;
    if (!unconfirmModal.reason.trim()) {
      setUnconfirmError(unconfirmModal.mode === "request" ? "확정 해제 요청 사유를 입력하세요." : "확정 해제 사유를 입력하세요.");
      return;
    }
    startUnconfirmTransition(async () => {
      const result =
        unconfirmModal.mode === "request"
          ? await requestUnconfirm(unconfirmModal.kind, unconfirmModal.id, unconfirmModal.reason)
          : await unconfirmVoucher(unconfirmModal.kind, unconfirmModal.id, unconfirmModal.reason);
      if (!result.ok) {
        setUnconfirmError(result.message);
        return;
      }
      setUnconfirmModal(null);
    });
  }

  function handleApproveRequest(requestId: string) {
    setDecideError(null);
    startDecideTransition(async () => {
      const result = await approveUnconfirmRequest(requestId);
      if (!result.ok) setDecideError({ requestId, message: result.message });
    });
  }

  function handleSaveReject() {
    if (!rejectModal) return;
    if (!rejectModal.note.trim()) {
      setRejectError("거절 사유를 입력하세요.");
      return;
    }
    startDecideTransition(async () => {
      const result = await rejectUnconfirmRequest(rejectModal.requestId, rejectModal.note);
      if (!result.ok) {
        setRejectError(result.message);
        return;
      }
      setRejectModal(null);
    });
  }

  function loadMatchCandidates(kind: VoucherKind, partyId: string, search: string) {
    startMatchLoadTransition(async () => {
      setMatchCandidates(await searchMatchCandidates(kind, partyId, search));
    });
  }

  function openMatchModal(r: VoucherRow) {
    const kind = voucherKindOf(r);
    setMatchModal({
      kind,
      settleId: r.settleId,
      blNo: r.blNo || r.allocLabel,
      partyId: r.partyId,
      amount: r.amount,
      currency: r.currency,
      allocatedTotal: r.allocatedTotal,
      allocations: r.allocations,
      fxAdjustments: r.fxAdjustments,
    });
    setSelectedCandidate(null);
    setMatchAmountDisplay("");
    setMatchError(null);
    setMatchSearch("");
    setFxNote("");
    loadMatchCandidates(kind, r.partyId, "");
  }

  function selectCandidate(c: MatchCandidate) {
    if (!matchModal) return;
    setSelectedCandidate(c);
    const remainingVoucher = matchModal.amount - matchModal.allocatedTotal;
    setMatchAmountDisplay(commaInput(String(Math.round(Math.min(remainingVoucher, c.remaining)))));
  }

  function handleSaveMatch() {
    if (!matchModal || !selectedCandidate) return;
    const amount = numOf(matchAmountDisplay);
    if (!(amount > 0)) {
      setMatchError("배분 금액을 입력하세요.");
      return;
    }
    startMatchSaveTransition(async () => {
      const result = await createManualAllocation(matchModal.kind, matchModal.settleId, selectedCandidate.transRefKey, amount);
      if (!result.ok) {
        setMatchError(result.message);
        return;
      }
      setMatchModal(null);
    });
  }

  function handleDeleteAllocation(allocationId: string) {
    setMatchError(null);
    startMatchSaveTransition(async () => {
      const result = await deleteAllocation(allocationId);
      if (!result.ok) {
        setMatchError(result.message);
        return;
      }
      setMatchModal(null);
    });
  }

  // 남은 잔액 **전액**을 환차손익으로 정리한다 — 금액은 서버가 다시 계산하므로 여기서는
  // 사유만 넘긴다(bankAllocation.ts createFxAdjustment 참고).
  function handleCreateFxAdjustment() {
    if (!matchModal) return;
    if (!fxNote.trim()) {
      setMatchError("환차손익 처리 사유를 입력하세요.");
      return;
    }
    setMatchError(null);
    startMatchSaveTransition(async () => {
      const result = await createFxAdjustment(matchModal.kind, matchModal.settleId, fxNote);
      if (!result.ok) {
        setMatchError(result.message);
        return;
      }
      setMatchModal(null);
    });
  }

  function handleDeleteFxAdjustment(adjustmentId: string) {
    setMatchError(null);
    startMatchSaveTransition(async () => {
      const result = await deleteFxAdjustment(adjustmentId);
      if (!result.ok) {
        setMatchError(result.message);
        return;
      }
      setMatchModal(null);
    });
  }

  // 전표 한 줄(blIndex 하나)을 그린다 — 단독 전표로도, 묶음을 펼쳤을 때 구성원으로도 그대로
  // 재사용한다. isLastInGroup이면 묶음의 마지막 줄이라는 뜻으로 파란 밑줄을 준다(세금계산서
  // 화면과 같은 규칙 — "여기까지가 이 묶음"이 한눈에 보이게).
  function renderSubRow(r: VoucherRow, opts?: { inGroup?: boolean; isLastInGroup?: boolean }) {
    const inGroup = opts?.inGroup ?? false;
    const isLastInGroup = opts?.isLastInGroup ?? false;
    const key = `${r.kind}-${r.id}-${r.blIndex}`;
    const isEditing = editingKey === key;
    // 입출금 완료(1단계)와 확정(2단계)을 다른 색으로 나눠 보여준다 — 완료됐다고 다 끝난 게
    // 아니라 사람이 최종 검토해서 확정을 눌러야 2단계라는 걸 색으로도 구분한다(2026-08-27).
    // 1단계: 매출(입금)은 입출금내역의 "확정"과 같은 초록, 매입(출금)은 "좋은 소식"이 아니라
    // 옅은 강조색으로만 표시. 2단계(확정)는 둘 다 강조색(파랑) — 확정은 입금/출금 방향과
    // 무관한 중립적인 절차이기 때문이다.
    const isSettled = r.allocatedTotal > 0;
    const isConfirmed = r.settlementConfirmedAt !== null;
    const rowTintClass = isConfirmed
      ? "bg-accent-soft"
      : isSettled
        ? r.kind === "sale"
          ? "bg-pos/10"
          : "bg-accent/5"
        : "";
    const isLastSubRow = r.blIndex === r.blCount - 1;
    // 묶음 구성원 줄은 왼쪽·오른쪽에도 파란 테두리를 둘러서, 대표행부터 마지막 줄까지
    // 하나의 파란 상자로 보이게 한다(2026-08-31) — 세로 연결선(L) 하나만으로는 "여기까지가
    // 이 묶음"이라는 경계가 잘 안 보인다는 피드백에 따름.
    const sideBorder = inGroup ? "border-l-2 border-r-2 border-accent/50" : "";
    const bottomBorder = isLastSubRow
      ? isLastInGroup
        ? "border-b-2 border-accent/50"
        : "border-b border-border/60"
      : "";
    const borderClass = `${sideBorder} ${bottomBorder}`.trim();
    return (
      // 같은 전표에서 펼쳐진 줄들 사이에는 가로 구분선을 넣지 않는다 — 줄마다 선이 그어지면
      // 왼쪽 세로 연결선이 토막토막 끊겨 보이고, 각 줄이 별개의 전표처럼 읽힌다. 구분선은
      // 그 묶음의 마지막 줄에만 그어서 다음 전표와 갈라준다.
      <tr key={key} className={`${borderClass}${rowTintClass ? ` ${rowTintClass}` : ""}`}>
        {isEditing ? (
          <>
            <td className="py-1.5 pr-3">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-fg"
              />
            </td>
            <td className="py-1.5 pr-3 whitespace-nowrap">
              <span className={r.kind === "sale" ? "text-pos" : "text-accent"}>
                {r.kind === "sale" ? "매출" : "매입"}
              </span>
            </td>
            {/* 세금계산서에서 등록된 전표는 locked이라 애초에 편집 모드로 들어올 수 없다 —
                그래서 편집행의 세금계산서코드는 항상 비어 있다. */}
            <td className="py-1.5 pr-3 num text-muted">{r.taxInvoiceNo ?? "-"}</td>
            <td className="py-1.5 pr-3 num text-muted">{r.partyCode ?? "-"}</td>
            <td className="py-1.5 pr-3">
              <select
                value={partyId}
                onChange={(e) => setPartyId(e.target.value)}
                className="w-40 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-fg"
              >
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </td>
            <td className="py-1.5 pr-3">
              <input
                value={blNo}
                onChange={(e) => setBlNo(e.target.value)}
                className="w-32 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-fg"
              />
            </td>
            <td className="py-1.5 pr-3">
              <input
                value={amountDisplay}
                onChange={(e) => setAmountDisplay(commaInput(e.target.value))}
                inputMode="decimal"
                className="w-28 rounded-md border border-border bg-surface px-1.5 py-1 text-right text-xs text-fg num"
              />
            </td>
            {/* 편집 중에도 열 수를 맞춰야 표가 어긋나지 않는다 — 실제 입출금은 은행 데이터라
                여기서 고치는 값이 아니므로 그대로 보여준다. */}
            <td className={`py-1.5 pr-3 whitespace-nowrap num text-muted ${GROUP} ${SETTLE_COL}`}>
              {r.allocations[0]?.date ?? "-"}
            </td>
            <td className={`py-1.5 pr-3 text-right num text-muted ${SETTLE_COL}`}>
              {settledBreakdown(r) ? formatAmount(settledBreakdown(r)!.supply) : "-"}
            </td>
            <td className={`py-1.5 pr-3 text-right num text-muted ${SETTLE_COL}`}>
              {settledBreakdown(r) ? formatAmount(settledBreakdown(r)!.tax) : "-"}
            </td>
            <td className={`py-1.5 pr-3 text-right num ${SETTLE_COL} ${r.kind === "sale" ? "text-pos" : "text-neg"}`}>
              {r.allocatedTotal > 0 ? formatAmount(r.allocatedTotal) : "-"}
            </td>
            <td className="py-1.5 pr-3" />
            <td className={`py-1.5 pr-3 ${GROUP}`}>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-36 rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-fg"
              />
            </td>
            <td className="py-1.5 pr-2 text-right whitespace-nowrap">
              <button
                type="button"
                disabled={pending}
                onClick={() => saveEdit(r)}
                className="mr-2 text-xs text-accent hover:underline disabled:opacity-50"
              >
                {pending ? "저장 중..." : "저장"}
              </button>
              <button type="button" onClick={cancelEdit} className="text-xs text-muted hover:underline">
                취소
              </button>
              {error && <div className="mt-1 text-xs text-neg">{error}</div>}
            </td>
          </>
        ) : (
          <>
            <td className="py-2 pr-3 whitespace-nowrap text-muted">
              {/* 묶음 구성원 줄에는 전부 연결선 아이콘을 붙인다 — 어느 줄이 이 묶음 소속인지
                  줄마다 바로 보이게(2026-08-27, 첫 줄에만 붙였더니 나머지 줄은 소속이 안
                  보인다는 피드백에 따라 전체로 넓힘). */}
              {inGroup && <IconTreeConnector className="mr-1 inline h-3.5 w-3.5 text-accent" />}
              {formatDate(r.date)}
            </td>
            <td className="py-2 pr-3 whitespace-nowrap">
              <span className={r.kind === "sale" ? "text-pos" : "text-accent"}>
                {r.kind === "sale" ? "매출" : "매입"}
              </span>
            </td>
            <td className="py-2 pr-3 whitespace-nowrap num text-muted">
              {r.taxInvoiceNo ?? (
                // 세금계산서 화면을 거치지 않고 이 화면에서 직접 입력한 건임을 표시한다(2026-08-27).
                <span
                  className="rounded bg-gray-95 px-1.5 py-0.5 text-xs font-normal text-muted"
                  title="세금계산서 화면을 거치지 않고 이 화면에서 직접 입력한 건입니다."
                >
                  수기기입
                </span>
              )}
            </td>
            <td className="py-2 pr-3 whitespace-nowrap num text-muted">{r.partyCode ?? "-"}</td>
            <td className="py-2 pr-3 text-fg">{r.partyName}</td>
            {/* 묶음 표시는 이제 날짜 칸의 연결선 아이콘만으로 충분하다 — B/L 칸의 세로선은
                중복이라 뺐다(2026-08-27). */}
            <td className="py-2 pr-3 whitespace-nowrap text-fg">
              {/* 미발행 줄은 B/L이 비어 있고 명칭만 있다 — B/L 자리에 명칭을 보여준다. */}
              {r.blNo ? <span className="num">{r.blNo}</span> : <span className="text-muted">-</span>}
              {r.allocLabel && (
                <span
                  className="ml-1.5 rounded bg-gray-95 px-1.5 py-0.5 text-xs text-muted"
                  title="세금계산서에 없는 금액(미발행분)입니다."
                >
                  {r.allocLabel}
                </span>
              )}
            </td>
            <td className="py-2 pr-3 text-right num text-fg">
              {r.currency !== "KRW" && r.fxAmount != null && r.fxRate != null ? (
                <span title={`${r.currency} ${r.fxAmount.toLocaleString("ko-KR")} × 환율 ${r.fxRate.toLocaleString("ko-KR")}`}>
                  {formatAmount(r.amount)}
                </span>
              ) : (
                formatAmount(r.amount)
              )}
            </td>
            <td className={`py-2 pr-3 whitespace-nowrap num text-muted ${GROUP} ${SETTLE_COL}`}>
              {r.allocations[0]?.date ?? (
                <span
                  className="text-xs"
                  title={`전표 금액·거래처와 일치하는 은행 ${r.kind === "sale" ? "입금" : "출금"}을 찾지 못했습니다. 해당 기간을 입출금내역에서 아직 조회하지 않았을 수도 있고, 자동으로 못 찾아 수기 매칭이 필요할 수도 있습니다.`}
                >
                  -
                </span>
              )}
            </td>
            {/* 실제 입출금액을 공급가액·세액·합계(입출금액)로 나눠 보여준다 — 부가세 포함 여부를
                한 뭉치로 뭉뚱그리지 않고 세 칸에 각각 얼마인지 그대로 밝힌다(2026-08-27). */}
            <td className={`py-2 pr-3 text-right num text-muted ${SETTLE_COL}`}>
              {settledBreakdown(r) ? formatAmount(settledBreakdown(r)!.supply) : "-"}
            </td>
            <td className={`py-2 pr-3 text-right num text-muted ${SETTLE_COL}`}>
              {settledBreakdown(r) ? formatAmount(settledBreakdown(r)!.tax) : "-"}
            </td>
            <td className={`py-2 pr-3 text-right num ${SETTLE_COL} ${r.kind === "sale" ? "text-pos" : "text-neg"}`}>
              <div className="flex flex-col items-end gap-0.5">
                <span>
                  {r.allocatedTotal > 0 ? formatAmount(r.allocatedTotal) : "-"}
                </span>
                {r.allocatedTotal > 0 && !r.fullyAllocated && (
                  <span className="text-[11px] font-normal text-muted">{formatAmount(r.amount)} 중</span>
                )}
              </div>
            </td>
            <td className="py-2 pr-3 whitespace-nowrap">
              {!isConfirmed && (
                <button
                  type="button"
                  onClick={() => openMatchModal(r)}
                  className="text-xs text-accent hover:underline"
                >
                  매칭
                </button>
              )}
            </td>
            <td className={`py-2 pr-3 text-muted ${GROUP}`}>{r.note}</td>
            {/* 수정·삭제는 전표 단위 동작이라 펼쳐진 첫 줄에만 둔다(줄마다 버튼이 있으면 그
                B/L만 대상인 것처럼 보이는데 실제로는 전표 전체가 대상이다). 매칭·확정·해제는
                반대로 B/L 배분 단위 동작이라 줄마다 각각 보여준다(2026-08-31). */}
            <td className="py-2 pr-2 text-right whitespace-nowrap">
              {isConfirmed ? (
                <div className="flex flex-col items-end gap-1">
                  <div className="flex items-center justify-end gap-1.5">
                    <span
                      className="flex items-center gap-1 text-xs font-medium text-accent"
                      title={
                        r.settlementConfirmedByEmail
                          ? `${r.settlementConfirmedByEmail} · ${new Date(r.settlementConfirmedAt!).toLocaleString("ko-KR")} 확정`
                          : "확정됨"
                      }
                    >
                      <IconCheckCircle className="h-3.5 w-3.5" />
                      확정됨
                    </span>
                    {/* 관리자는 대기 중인 요청이 있으면 그 요청을 승인/거절하고, 없으면 직접
                        해제한다. 관리자가 아니면 사유를 남겨 해제를 "요청"만 할 수 있다
                        (2026-08-31, "수정이 필요하면 관리자 승인을 받는다"를 요청/승인 흐름으로
                        구현). */}
                    {isAdmin ? (
                      r.pendingUnconfirmRequest ? (
                        <>
                          <button
                            type="button"
                            disabled={decidePending}
                            onClick={() => handleApproveRequest(r.pendingUnconfirmRequest!.id)}
                            className="text-xs text-accent hover:underline disabled:opacity-50"
                          >
                            승인
                          </button>
                          <button
                            type="button"
                            disabled={decidePending}
                            onClick={() => {
                              setRejectError(null);
                              setRejectModal({ requestId: r.pendingUnconfirmRequest!.id, blNo: r.blNo, note: "" });
                            }}
                            className="text-xs text-muted hover:underline disabled:opacity-50"
                          >
                            거절
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setUnconfirmError(null);
                            setUnconfirmModal({ mode: "direct", kind: voucherKindOf(r), id: r.settleId, blNo: r.blNo, reason: "" });
                          }}
                          className="text-xs text-muted hover:underline"
                        >
                          해제
                        </button>
                      )
                    ) : r.pendingUnconfirmRequest ? (
                      <span
                        className="text-xs text-muted"
                        title={`사유: ${r.pendingUnconfirmRequest.reason} · ${new Date(r.pendingUnconfirmRequest.createdAt).toLocaleString("ko-KR")} 요청`}
                      >
                        해제 요청됨 · 관리자 승인 대기중
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setUnconfirmError(null);
                          setUnconfirmModal({ mode: "request", kind: voucherKindOf(r), id: r.settleId, blNo: r.blNo, reason: "" });
                        }}
                        className="text-xs text-muted hover:underline"
                      >
                        해제 요청
                      </button>
                    )}
                  </div>
                  {decideError?.requestId === r.pendingUnconfirmRequest?.id && decideError && (
                    <span className="text-[11px] text-neg">{decideError.message}</span>
                  )}
                </div>
              ) : (
                <>
                  {/* 수정·삭제는 전표(Purchase/Sale) 단위 동작이라 펼쳐진 첫 줄에만 둔다 —
                      세금계산서에서 등록됐거나 B/L이 여러 건으로 배분된 전표는 수정 버튼 자체가
                      없다(예전엔 "잠김" 글자로 밝혔는데, 버튼 하나 없는 빈 칸이 더 깔끔하다는
                      피드백에 따라 뺐다, 2026-08-27). */}
                  {r.blIndex === 0 && !r.locked && (
                    <button
                      type="button"
                      onClick={() => startEdit(r)}
                      className="mr-2 text-xs text-accent hover:underline"
                    >
                      수정
                    </button>
                  )}
                  {/* 확정은 이 줄(B/L 배분)이 100% 배분 완료됐을 때만 — 부분 배분 상태에서
                      확정하면 나머지가 어느 대상 몫인지 알 수 없어진다(2026-08-31). */}
                  {r.fullyAllocated && (
                    <button
                      type="button"
                      onClick={() => setConfirmingRow(r)}
                      className="mr-2 text-xs text-accent hover:underline"
                    >
                      확정
                    </button>
                  )}
                  {r.blIndex === 0 && (
                    <DeleteButton
                      action={r.kind === "sale" ? deleteSale : deletePurchase}
                      id={r.id}
                      confirmMessage={
                        r.kind === "sale"
                          ? `B/L "${r.blNo}" 매출을 삭제할까요? 연결된 매입배분·관세대납 기록도 함께 삭제됩니다.`
                          : r.blCount > 1
                            ? `이 매입 건(${r.blCount}건 B/L 배분)을 삭제할까요? 아래로 펼쳐진 ${r.blCount}줄이 전부 함께 삭제됩니다.`
                            : "이 매입 건과 배분 내역을 삭제할까요?"
                      }
                      reasonMessages={{ confirmed: "확정된 건은 관리자가 해제하기 전까지 삭제할 수 없습니다." }}
                    />
                  )}
                </>
              )}
            </td>
          </>
        )}
      </tr>
    );
  }

  // 세금계산서 승인번호 하나를 공유하는 전표 여러 건을 대표행 + (펼쳤을 때) 구성원 줄로 그린다.
  function renderGroupRow(taxInvoiceNo: string, members: Entry[]) {
    const isExpanded = expandedGroups.has(taxInvoiceNo);
    const first = members[0].subRows[0];
    // "N건 묶음"의 N은 전표(entry) 수가 아니라 실제 줄(B/L) 수다 — 매입 한 건이 여러 B/L로
    // 배분된 경우(entry 1개, 줄 여러 개)에도 몇 줄이 묶였는지 그대로 보여줘야 한다.
    const totalRowCount = members.reduce((sum, e) => sum + e.subRows.length, 0);
    const totalAmount = members.reduce(
      (sum, e) => sum + e.subRows.reduce((s, r) => s + r.amount, 0),
      0
    );
    const earliestDate = members.reduce(
      (min, e) => (e.subRows[0].date < min ? e.subRows[0].date : min),
      first.date
    );
    const blLabel = members
      .flatMap((e) => e.subRows.map((r) => r.blNo || r.allocLabel))
      .filter(Boolean)
      .join(", ");

    // 대표행부터(펼쳤으면) 마지막 구성원 줄까지를 파란 상자 하나로 둘러싼다 — 접혀 있으면
    // 대표행 혼자 네 변을 다 두르고, 펼치면 대표행은 위·양옆만(아래는 구성원 줄이 이어받는다).
    const boxBorder = isExpanded
      ? "border-l-2 border-r-2 border-t-2 border-accent/50 rounded-t-lg"
      : "";

    return (
      <Fragment key={`bundle-${taxInvoiceNo}`}>
        <tr className={`${boxBorder} bg-gray-95/60`}>
          <td className="py-2 pr-3 whitespace-nowrap text-muted">{formatDate(earliestDate)}</td>
          <td className="py-2 pr-3 whitespace-nowrap">
            <span className={first.kind === "sale" ? "text-pos" : "text-accent"}>
              {first.kind === "sale" ? "매출" : "매입"}
            </span>
          </td>
          <td className="py-2 pr-3 whitespace-nowrap num text-muted">{taxInvoiceNo}</td>
          <td className="py-2 pr-3 whitespace-nowrap num text-muted">{first.partyCode ?? "-"}</td>
          <td className="py-2 pr-3 text-fg">{first.partyName}</td>
          <td className="py-2 pr-3 whitespace-nowrap text-fg" title={blLabel}>
            {/* 묶음 배지는 접혀 있을 때가 기본 상태라, 그때도 눈에 확 띄어야 "여러 줄이 안 보이게
                접혀 있다"는 걸 놓치지 않는다 — 회색 톤 대신 항상 강조색을 쓴다(2026-08-27). */}
            <button
              type="button"
              onClick={() => toggleGroup(taxInvoiceNo)}
              aria-expanded={isExpanded}
              title={isExpanded ? "묶음 접기" : "묶음 펼치기"}
              className={`flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                isExpanded
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-accent/60 bg-accent-soft text-accent-hover hover:border-accent hover:bg-accent/20"
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
                  isExpanded ? "bg-accent-fg text-accent" : "bg-accent text-accent-fg"
                }`}
              >
                {isExpanded ? <IconMinus className="h-2.5 w-2.5" /> : <IconPlus className="h-2.5 w-2.5" />}
              </span>
              {totalRowCount}건 묶음
            </button>
          </td>
          <td className="py-2 pr-3 text-right num font-medium text-fg">{formatAmount(totalAmount)}</td>
          <td className={`py-2 pr-3 whitespace-nowrap num text-muted ${GROUP} ${SETTLE_COL}`}>-</td>
          <td className={`py-2 pr-3 text-right num text-muted ${SETTLE_COL}`}>-</td>
          <td className={`py-2 pr-3 text-right num text-muted ${SETTLE_COL}`}>-</td>
          <td className={`py-2 pr-3 text-right num text-muted ${SETTLE_COL}`}>-</td>
          <td className="py-2 pr-3" />
          <td className={`py-2 pr-3 text-muted ${GROUP}`}>{first.note}</td>
          <td className="py-2 pr-2" />
        </tr>
        {isExpanded &&
          members.flatMap((entry, mi) =>
            entry.subRows.map((r) =>
              renderSubRow(r, { inGroup: true, isLastInGroup: mi === members.length - 1 })
            )
          )}
      </Fragment>
    );
  }

  // 묶이지 않은 단독 전표 — 기존 방식 그대로, 줄들 사이 구분선은 마지막 blIndex에만.
  function renderEntry(entry: Entry) {
    return entry.subRows.map((r) => renderSubRow(r));
  }

  const renderedBundles = new Set<string>();
  const body: React.ReactNode[] = [];
  for (const entry of entries) {
    const tn = bundleKeyOf.get(entry.key);
    if (tn) {
      if (renderedBundles.has(tn)) continue;
      renderedBundles.add(tn);
      body.push(renderGroupRow(tn, entriesByTaxInvoiceNo.get(tn)!));
    } else {
      body.push(
        <Fragment key={entry.key}>
          {renderEntry(entry)}
        </Fragment>
      );
    }
    // 전표(또는 묶음) 사이를 살짝 띄워서 어디까지가 한 건인지 더 잘 보이게 한다 — 세금계산서
    // 화면과 같은 이유(2026-08-27).
    body.push(
      <tr aria-hidden="true" key={`${tn ?? entry.key}-spacer`}>
        <td colSpan={COLSPAN} className="h-2" />
      </tr>
    );
  }

  return (
    <>
    <table className="w-full min-w-[1040px] text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted">
          <SortableTh label="날짜" sortKey="date" state={sort} onSort={handleSort} />
          <SortableTh label="구분" sortKey="kind" state={sort} onSort={handleSort} />
          <SortableTh label="세금계산서코드" sortKey="taxInvoiceNo" state={sort} onSort={handleSort} />
          <SortableTh label="거래처코드" sortKey="partyCode" state={sort} onSort={handleSort} />
          <SortableTh label="거래처명" sortKey="partyName" state={sort} onSort={handleSort} />
          <SortableTh label="B/L" sortKey="blNo" state={sort} onSort={handleSort} />
          <SortableTh label="금액" sortKey="amount" state={sort} onSort={handleSort} align="right" />
          {/* 실제 은행 입출금 — 매출이면 입금, 매입이면 출금. 왼쪽 세로선으로 앞의 전표 값들과
              갈라둔다(전표에 적힌 금액과 실제로 움직인 돈은 다른 성질의 값이다). */}
          <SortableTh
            label="입출금일"
            sortKey="settledDate"
            state={sort}
            onSort={handleSort}
            className={`${GROUP} ${SETTLE_COL}`}
          />
          <th className={`py-2 pr-3 text-right font-normal ${SETTLE_COL}`}>공급가액</th>
          <th className={`py-2 pr-3 text-right font-normal ${SETTLE_COL}`}>세액</th>
          <SortableTh
            label="입출금액"
            sortKey="settledAmount"
            state={sort}
            onSort={handleSort}
            align="right"
            className={SETTLE_COL}
          />
          {/* 매칭은 버튼 열이라 정렬 대상이 아니다. */}
          <th className="py-2 pr-3 text-left font-normal">매칭</th>
          <SortableTh label="비고" sortKey="note" state={sort} onSort={handleSort} className={GROUP} />
          {/* 관리는 버튼 열이라 정렬 대상이 아니다. */}
          <th className="py-2 pr-2 text-right">관리</th>
        </tr>
      </thead>
      <tbody>
        {/* 헤더와 첫 줄 사이도 다른 줄 사이 간격과 똑같이 살짝 띄운다(2026-08-27). */}
        <tr aria-hidden="true">
          <td colSpan={COLSPAN} className="h-2" />
        </tr>
        {body}
      </tbody>
    </table>

    {/* "확정" 확인 팝업 — 삭제처럼 되돌릴 수 없는 동작은 아니지만(관리자가 해제할 수 있다),
        확정하면 곧바로 수정·삭제가 막히므로 실수로 누르지 않게 한 번 더 확인한다. */}
    {confirmingRow && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card flex w-full max-w-sm flex-col items-center gap-5 p-7 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
            <IconCheckCircle className="h-6 w-6" />
          </span>
          <p className="w-full text-base leading-relaxed text-fg">
            B/L &quot;{confirmingRow.blNo || confirmingRow.allocLabel}&quot; 건을 확정할까요? 확정 후에는 관리자가
            해제하기 전까지 수정·삭제할 수 없습니다.
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
              onClick={handleConfirmVoucher}
              className="flex-1 rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              {confirmPending ? "확정 중..." : "확정"}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* "확정 해제" 팝업 — 관리자는 바로 해제하고(mode: direct), 관리자가 아니면 사유를 남겨
        해제를 요청만 한다(mode: request, 2026-08-31). 어느 쪽이든 사유는 필수다(묶음 풀기 등
        다른 되돌림 동작과 같은 이유). */}
    {unconfirmModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card flex w-full max-w-md flex-col gap-5 p-7">
          <h3 className="text-lg font-semibold text-fg">
            {unconfirmModal.mode === "request" ? "확정 해제 요청" : "확정 해제"}
          </h3>
          <p className="text-sm text-muted">
            {unconfirmModal.mode === "request" ? (
              <>
                B/L &quot;{unconfirmModal.blNo}&quot; 건의 확정 해제를 요청합니다. 관리자가 승인하면 다시
                수정·삭제할 수 있습니다.
              </>
            ) : (
              <>
                B/L &quot;{unconfirmModal.blNo}&quot; 건의 확정을 해제합니다. 해제하면 다시 수정·삭제할 수
                있습니다.
              </>
            )}
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted">{unconfirmModal.mode === "request" ? "요청 사유" : "해제 사유"}</label>
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
              {unconfirmPending
                ? unconfirmModal.mode === "request"
                  ? "요청 중..."
                  : "해제 중..."
                : unconfirmModal.mode === "request"
                  ? "요청"
                  : "해제"}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* "거절" 사유 팝업 — 거절도 되돌림 동작이라 사유를 반드시 남긴다(2026-08-31). */}
    {rejectModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card flex w-full max-w-md flex-col gap-5 p-7">
          <h3 className="text-lg font-semibold text-fg">확정 해제 요청 거절</h3>
          <p className="text-sm text-muted">
            B/L &quot;{rejectModal.blNo}&quot; 건의 확정 해제 요청을 거절합니다. 전표는 확정 상태 그대로
            남습니다.
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm text-muted">거절 사유</label>
            <textarea
              value={rejectModal.note}
              onChange={(e) => setRejectModal((prev) => (prev ? { ...prev, note: e.target.value } : prev))}
              rows={3}
              placeholder="예: 아직 검토가 끝나지 않음, 사유 불충분 등"
              className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
            />
          </div>
          {rejectError && <div className="text-sm text-neg">{rejectError}</div>}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setRejectModal(null)}
              className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
            >
              취소
            </button>
            <button
              type="button"
              disabled={decidePending}
              onClick={handleSaveReject}
              className="rounded-xl bg-neg px-6 py-2.5 text-base font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {decidePending ? "거절 중..." : "거절"}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* "매칭"(입출금 배분) 팝업 — 자동으로 안 붙은 경우 확정된 은행거래 중에서 사람이 직접
        골라 배분한다(2026-08-31). 이미 배분된 내역을 먼저 보여주고, 그 아래에 새로 배분할
        후보를 검색·선택한다. */}
    {matchModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="card flex w-full max-w-3xl flex-col gap-4 p-7">
          <div>
            <h3 className="text-lg font-semibold text-fg">입출금 매칭 — {matchModal.blNo}</h3>
            <p className="mt-1 text-sm text-muted">
              전표 금액 {formatAmount(matchModal.amount)} 중 {formatAmount(matchModal.allocatedTotal)} 배분됨
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

          {matchModal.amount - matchModal.allocatedTotal > 0.5 && matchModal.currency !== "KRW" && (
            <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent-soft/40 p-3">
              <span className="text-sm text-fg">
                남은 잔액 {formatAmount(matchModal.amount - matchModal.allocatedTotal)}원은 외화 입력 시점
                환율과 실제 결제 환율의 차이일 수 있습니다 — 은행거래를 더 찾지 않고 환차손익으로
                바로 정리할 수 있습니다.
              </span>
              <textarea
                value={fxNote}
                onChange={(e) => setFxNote(e.target.value)}
                placeholder="사유(필수) — 예: 결제일 환율 하락으로 8,000원 부족"
                rows={2}
                className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
              />
              <button
                type="button"
                disabled={matchSavePending}
                onClick={handleCreateFxAdjustment}
                className="w-fit rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {matchSavePending ? "처리 중..." : "환차손익으로 처리"}
              </button>
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
                  <span className="text-right">{matchModal.kind === "sale" ? "입금액" : "출금액"}</span>
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
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted">배분 금액</label>
                  <input
                    value={matchAmountDisplay}
                    onChange={(e) => setMatchAmountDisplay(commaInput(e.target.value))}
                    inputMode="decimal"
                    className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-right text-sm text-fg num"
                  />
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
