"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  searchTaxInvoices,
  getPrintUrl,
  uploadTaxInvoiceExcel,
  getAttachmentStatuses,
  attachTaxInvoiceFile,
  registerFromTaxInvoice,
  registerBundledPurchase,
  registerBundledSale,
  previewTaxInvoiceLink,
  reattachGroupFile,
  unbundleGroup,
  editApprovedTaxInvoice,
  adjustApprovedTaxInvoiceAmount,
  getTaxInvoiceEditHistory,
  getRegistrationDetail,
  type TaxInvoiceEditHistoryEntry,
  type RegistrationDetail,
} from "@/app/(app)/tax-invoices/actions";
import { extractPurchaseStatementPdf } from "@/app/(app)/purchases/actions";
import { fileToBase64 } from "@/lib/clientFile";
import { formatAmount, commaInput, numOf, formatBizNo, bizNoDigits } from "@/lib/format";
import { extractBlNoFromRemark, extractAdditionalBlCount } from "@/lib/blNoExtract";
import type { TaxInvoiceDirection, TaxInvoiceRow } from "@/lib/barobill";
import type { AttachmentStatus } from "@/lib/taxInvoiceAttachments";
import { SortableTh } from "@/components/SortableTh";
import { PartySearchSelect, type PartyOption } from "@/components/PartySearchSelect";
import { sortRowsBy, toggleSort, type SortState, type SortValue } from "@/lib/tableSort";
import { IconPlus, IconMinus, IconTreeConnector, IconCheckCircle, IconAlertCircle } from "@/components/icons";

type RegisterAs = "purchase" | "customs";
type MultiBlRow = { blNo: string; amountDisplay: string };
// 매출 등록 확인 팝업에서 B/L을 여러 줄로 나눌 때만 쓰는 줄 종류 — "B/L"이면 실제 B/L 번호,
// "W/F"·"기타"면 B/L이 없는 금액이라 그 칸에 실제 B/L 대신 명칭을 적는다(둘 다 결국 같은
// blNo 칸에 문자열로 들어간다 — Sale.blNo는 그냥 문자열이라 새 스키마 없이 이렇게 처리한다).
type SalesBlRowKind = "bl" | "wf" | "etc";
type SalesBlRow = MultiBlRow & { kind: SalesBlRowKind };
// customsPartyId: 관세전표로 등록할 때 고른 거래처(선택). 일반전표(매입)로 등록하면 세금계산서
// 공급자가 그대로 거래처가 되므로 쓰지 않는다.
type MultiBlModalState = {
  row: TaxInvoiceRow;
  rows: MultiBlRow[];
  registerAs: RegisterAs;
  customsPartyId: string | null;
  unissued: UnissuedRow; // 세금계산서 합계금액과의 차액 줄
};
type BundleModalState = {
  direction: TaxInvoiceDirection;
  rows: TaxInvoiceRow[];
  blRows: MultiBlRow[];
  registerAs: RegisterAs; // 매출 묶음에서는 쓰지 않음(매출은 등록 유형 구분이 없음)
  customsPartyId: string | null;
  unissued: UnissuedRow;
};
type ConfirmModalState = {
  row: TaxInvoiceRow;
  dir: TaxInvoiceDirection;
  blNo: string;
  // 매출에서만 쓴다 — "+"로 B/L을 2건 이상 나누면 채워진다(null이면 기존처럼 blNo 하나 +
  // 전체 금액). 매입은 이미 "여러 B/L로 나눠 배분" 별도 팝업이 있어 여기서는 건드리지 않는다.
  blRows: SalesBlRow[] | null;
  registerAs: RegisterAs;
  customsPartyId: string | null;
  existingLabel: string | null;
  loadingPreview: boolean;
};
// 승인된 세금계산서 수정 팝업(매출·매입 공통) — B/L과 첨부파일을 바꾸고 사유를 남긴다.
// "B/L 변경" 수정 사유 항목 — "묶음 풀기"와 같은 패턴으로 자유 텍스트 앞에 분류를 붙인다
// (2026-08-27). 기존 안내 문구("예: B/L 오타 정정, 인보이스 재발행분으로 교체 등")에 있던
// 실제 사례를 그대로 항목으로 뽑았다.
type EditReasonCategory = "B/L 오타 정정" | "인보이스 재발행" | "기타";
const EDIT_REASON_CATEGORIES: EditReasonCategory[] = ["B/L 오타 정정", "인보이스 재발행", "기타"];

type EditModalState = {
  ntsSendKeys: string[]; // 묶음이면 묶음 전체, 단건이면 1개
  direction: TaxInvoiceDirection;
  counterpartCorpNum: string;
  currentBlNo: string;
  currentFileName: string;
  newBlNo: string;
  reasonCategory: EditReasonCategory;
  reason: string;
  file: File | null; // 다시 첨부할 파일(선택 — 안 고르면 기존 파일 유지)
  history: TaxInvoiceEditHistoryEntry[] | null;
  historyLoading: boolean;
  // 수정 팝업에서도 **무엇이 등록돼 있는지 눈으로 확인**할 수 있어야 한다 — B/L을 바꾸거나
  // 인보이스를 갈아끼우는 화면인데 정작 현재 전표 내역이 안 보이면 감으로 고치게 된다.
  detail: RegistrationDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  // 다시 첨부한 PDF에서 읽어낸 내용(검증용, 읽기 전용).
  extract: { method: "offline" | "ai"; lines: ExtractedLine[] } | null;
  extractError: string | null;
  extractLoading: boolean;
};

// "수정"을 누르면 뜨는 작은 선택 팝업 상태 — 묶음풀기/B/L변경/금액조정 중 하나를 고르면
// 그 팝업이 열린다(2026-08-27, 행에 세 링크를 다 늘어놓았더니 복잡하다는 피드백에 따라
// 다시 팝업으로 모음).
type EditChoiceState = {
  ntsSendKeys: string[];
  counterpartCorpNum: string;
  attachment: AttachmentStatus;
  blNo: string;
  isGroup: boolean;
};

// "묶음 풀기" 확인 팝업 상태 — window.confirm 대신 사유를 받는 전용 팝업으로 바꿨다
// (2026-08-27, 다른 수정 흐름들처럼 사유를 남기고 이력에 기록되도록).
type UnbundleReasonCategory = "재묶음" | "세금계산서 재발급" | "기타";
const UNBUNDLE_REASON_CATEGORIES: UnbundleReasonCategory[] = ["재묶음", "세금계산서 재발급", "기타"];

type UnbundleModalState = {
  ntsSendKeys: string[];
  counterpartCorpNum: string;
  blNo: string;
  combinedAmountTotal: number;
  reasonCategory: UnbundleReasonCategory;
  reason: string;
};

// "금액 조정" 팝업 상태 — B/L은 절대 안 바꾸고, 이미 등록된 B/L들의 금액만 고친다.
type AmountAdjustRow = { blNo: string; currentAmount: number; newAmountDisplay: string };
type AmountModalState = {
  ntsSendKeys: string[];
  direction: TaxInvoiceDirection;
  counterpartCorpNum: string;
  rows: AmountAdjustRow[] | null; // 등록 내역을 불러오는 동안 null
  detailError: string | null;
  reason: string;
  history: TaxInvoiceEditHistoryEntry[] | null;
  historyLoading: boolean;
};

// "{B/L} 외 N건"을 눌렀을 때 뜨는 등록내역 팝업 상태. 내용은 매번 서버에서 다시 조회한다
// (getRegistrationDetail) — 나중에 매출이 붙으면 B/L별 연결 여부가 달라지기 때문이다.
type DetailModalState = {
  title: string;
  detail: RegistrationDetail | null;
  loading: boolean;
  error: string | null;
};

// 데이터가 들어있는 열은 전부 정렬 대상이다. 버튼/입력만 있는 열(체크박스·"보기"·등록/첨부)은
// 정렬해봐야 의미가 없어서 제외한다. 값이 TaxInvoiceRow에 없는 열(번호·코드·인보이스·확정)은
// 컴포넌트 상태(numbers/partyCodes/attachments)에서 뽑으므로 값 추출기를 컴포넌트 안에 둔다.
type SortKey =
  | "number"
  | "writeDate"
  | "partyCode"
  | "counterpartCorpName"
  | "counterpartCorpNum"
  | "amountTotal"
  | "taxTotal"
  | "totalAmount"
  | "itemName"
  | "ntsSendKey"
  | "invoiceFileName"
  | "voucherKind"
  | "approvedAt";

// 등록된 전표가 어느 화면에 있는지 알려주는 이름. 화면 이름을 그대로 쓴다("매입등록"처럼
// 동작을 말하면 어디로 가서 봐야 하는지가 안 드러난다) — 매출은 Sale이라 일반전표에 있다.
function voucherKindLabel(kind: "sale" | "purchase" | "customs" | null): string {
  return kind === "customs" ? "관세전표" : "일반전표";
}

// 매입 세금계산서 품목명이 관세/DUTY로 보이면 관세전표를 기본값으로 미리 골라준다 — 그래도
// 항상 사용자가 팝업에서 최종 확인/변경한다.
function looksLikeCustoms(itemName: string): boolean {
  return /관세|duty/i.test(itemName);
}

// amount는 **부가세를 뺀 공급가액**이다. 지출결의서 명세서의 B/L별 합계는 부가세가 포함된
// 금액이라 그대로 쓰면 세금계산서 공급가액과 그 부가세만큼 어긋난다 — 파서가 VAT 열을 읽어
// supplyAmount로 내려주므로 여기서는 그 값을 쓴다(purchaseStatementParser 주석 참고).
// vat는 화면에 "부가세 N 제외"로 알려주기 위해 함께 들고 온다.
type ExtractedLine = { blNo: string; amount: number; vat: number };
type PdfExtractResult =
  | { status: "ok"; method: "offline" | "ai"; lines: ExtractedLine[] }
  | { status: "error"; message: string };

// B/L이 정확히 1건만 인식됐을 때, 그 금액이 세금계산서 공급가액과 실제로 맞는지 확인한다 —
// 확정 전에 "검증됐다"고 보여줄 근거다. 여러 건이 섞인 인보이스는 이 세금계산서 금액과
// 1:1로 비교할 수 없으므로 검증 대상이 아니다(null).
function amountMismatchWarning(lines: ExtractedLine[], targetAmount: number): string | null {
  if (lines.length !== 1) return null;
  if (Math.round(lines[0].amount) === Math.round(targetAmount)) return null;
  return (
    `인식된 금액(${formatAmount(lines[0].amount)})이 세금계산서 공급가액(${formatAmount(targetAmount)})과 ` +
    `다릅니다 — 다른 세금계산서용 파일이 아닌지 확인 후 등록하세요.`
  );
}

// 인식된 각 줄의 금액을 목표 합계(공급가액)에 맞춰 비율로 축소/확대한다 — 명세서 자체의
// 합계는 보통 부가세 등이 섞여 있어 목표와 정확히 안 맞을 때가 많다(반올림 오차는 마지막
// 줄에서 흡수해 합계가 정확히 맞게 만든다). 여러 곳(첨부 즉시 자동 인식/멀티 B/L 팝업/묶어서
// 등록 팝업)에서 재사용한다.
// 인보이스에서 읽은 B/L별 금액을 **그대로** 넣는다. 예전에는 합계가 세금계산서 공급가액과
// 같아지도록 비율로 눌러 담았는데(임의 안분), 그러면 B/L마다 실제 청구액이 조금씩 왜곡되고
// (예: 1,640,251 → 1,638,007) 인보이스와 대조가 안 됐다. 지금은 인보이스 금액이 그대로 들어가고,
// 세금계산서와의 차액은 아래 "미발행 줄"로 따로 뺀다.
function buildRawBlRows(lines: ExtractedLine[]): MultiBlRow[] {
  return lines.map((l) => ({ blNo: l.blNo, amountDisplay: commaInput(String(Math.round(l.amount))) }));
}

// 배분 합계가 맞는지 판단한다. **공급가액 합계와 합계금액(공급가액+세액) 합계 둘 다 정답으로
// 받아준다** — 입력 경로가 두 가지여서다:
//  - PDF를 첨부하지 않으면 B/L 줄이 세금계산서 **공급가액** 기준으로 채워진다.
//  - 인보이스를 첨부하면 인보이스 금액이 그대로 들어가는데 거기엔 **부가세가 섞여 있다**.
// 한쪽만 정답으로 두면 다른 경로에서 늘 세액만큼 차액이 남아 매번 "부가세" 줄을 입력해야 한다
// ("부가세는 상관없다"). 진짜로 세금계산서에 없는 금액만 미발행 줄로 잡히게 하는 것이 목적이다.
function allocationTargets(supplySum: number, totalSum: number): number[] {
  return supplySum === totalSum ? [supplySum] : [supplySum, totalSum];
}

function matchesAnyTarget(allocTotal: number, targets: number[]): boolean {
  return targets.some((t) => Math.round(allocTotal) === Math.round(t));
}

// 두 기준 중 **더 가까운 쪽**까지 남은 차액. 미발행 줄에 "채우기"로 제안하는 값이다.
function nearestRemaining(allocTotal: number, targets: number[]): number {
  let best = 0;
  let bestAbs = Infinity;
  for (const t of targets) {
    const d = Math.round(t - allocTotal);
    if (Math.abs(d) < bestAbs) {
      bestAbs = Math.abs(d);
      best = d;
    }
  }
  return best;
}

// 세금계산서에 없는(미발행) 금액에 붙일 수 있는 명칭. "기타"를 고르면 직접 입력한다.
export const UNISSUED_LABELS = ["W/F", "부가세", "영세율", "면세", "해외운임", "기타"] as const;

type UnissuedRow = {
  label: string; // UNISSUED_LABELS 중 하나
  custom: string; // label === "기타"일 때 직접 입력한 명칭
  amountDisplay: string;
  blNo: string; // 비워두면 특정 B/L에 속하지 않는 줄이 된다(B/L별 손익에 섞이지 않음)
};

function emptyUnissued(): UnissuedRow {
  // 기본값은 영세율 — 부가세는 전표에 넣지 않으므로(unissuedFromLines 주석), 실제로 미발행
  // 줄을 쓰는 경우는 대개 영세율/면세 매입이다.
  return { label: "영세율", custom: "", amountDisplay: "", blNo: "" };
}

// 추출 결과로 미발행 줄을 준비한다. **금액은 채우지 않는다.**
//
// 한때 명세서의 "W/F / VAT" 열 합계를 이 줄에 자동으로 채웠는데, 그 열의 값은 이 양식에서
// **부가세**다(실측: 8,395 = 세금계산서 세액). 전표는 **공급가액 기준**이므로 부가세는 아예
// 들어가지 않아야 한다 — 자동으로 채우면 전표 총액이 공급가액(6,129,097)이 아니라 합계금액
// (6,137,492)이 되어 세금계산서와 어긋난다.
//
// 미발행 줄 자체는 그대로 남긴다: 인보이스가 **부가세가 아닌 이유로** 세금계산서보다 많은 경우
// (영세율 해외운임 등 세금계산서를 안 받은 항목)에는 사람이 명칭을 골라 직접 적어야 한다.
function unissuedFromLines(_lines: ExtractedLine[]): UnissuedRow {
  return emptyUnissued();
}

// 실제로 전표에 남길 명칭.
function unissuedLabelOf(u: UnissuedRow): string {
  return u.label === "기타" ? u.custom.trim() : u.label;
}


function toBaseMonth(monthInput: string): string {
  return monthInput.replace("-", "");
}

function formatYmd(ymd: string): string {
  if (ymd.length !== 8) return ymd;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// "확정" 칸에 쓰는 짧은 날짜(MM-DD). 열이 좁아서 연도는 빼고, 전체 시각은 title로 띄운다.
function formatApprovedShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatApprovedFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR");
}

const CSV_HEADERS = [
  "번호",
  "작성일자",
  "거래처코드",
  "거래처명",
  "사업자번호",
  "대표자",
  "거래처 이메일",
  "공급가액",
  "세액",
  "합계금액",
  "품목",
  "승인번호",
];

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadTaxInvoicesCsv(
  rows: TaxInvoiceRow[],
  direction: TaxInvoiceDirection,
  label: string,
  numbers: Record<string, string>,
  partyCodes: Record<string, string>
) {
  const lines = [
    CSV_HEADERS.join(","),
    ...rows.map((r) =>
      [
        numbers[r.ntsSendKey] ?? "",
        formatYmd(r.writeDate),
        partyCodes[bizNoDigits(r.counterpartCorpNum)] ?? "",
        r.counterpartCorpName,
        formatBizNo(r.counterpartCorpNum),
        r.counterpartCEOName,
        r.counterpartEmail,
        r.amountTotal,
        r.taxTotal,
        r.totalAmount,
        r.itemName,
        r.ntsSendKey,
      ]
        .map(csvCell)
        .join(",")
    ),
  ];
  // UTF-8 BOM을 붙여야 엑셀에서 한글이 깨지지 않는다.
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `세금계산서_${direction === "sales" ? "매출" : "매입"}_${label}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function TaxInvoiceSearchForm({
  isAdmin,
  parties,
}: {
  isAdmin: boolean;
  parties: PartyOption[];
}) {
  const now = new Date();
  const defaultMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  // 조회조건은 URL 쿼리에 담는다 — 다른 탭에 갔다 돌아와도(사이드바가 탭별 마지막 URL을
  // 기억한다, Sidebar.tsx 참고) 같은 조건이 그대로 복원되고, 새로고침·뒤로가기·주소 공유도
  // 그대로 동작한다. **초기값으로만 읽고 이후에는 상태 → URL 한 방향으로만 쓴다** — URL을
  // 계속 되읽어 상태에 반영하면 replace ↔ 상태 갱신이 서로를 트리거해 무한 루프가 된다.
  const initialParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [direction, setDirection] = useState<TaxInvoiceDirection>(
    initialParams.get("direction") === "purchase" ? "purchase" : "sales"
  );
  const [month, setMonth] = useState(() => {
    const m = initialParams.get("month");
    return m && /^\d{4}-\d{2}$/.test(m) ? m : defaultMonth;
  });
  const [taxType, setTaxType] = useState(() => (initialParams.get("taxType") === "3" ? 3 : 1));
  const [dateType, setDateType] = useState(() => {
    const d = Number(initialParams.get("dateType"));
    return d === 2 || d === 3 ? d : 1;
  });
  const [rows, setRows] = useState<TaxInvoiceRow[] | null>(null);
  // 승인번호 → 내부 관리번호(매출 I00001 / 매입 O00001). 서버가 조회 시점에 부여해서 준다.
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  // 사업자등록번호(숫자만) → 거래처 코드. 거래처를 "[0001] 거래처명"으로 보여주기 위함.
  const [partyCodes, setPartyCodes] = useState<Record<string, string>>({});
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [printPending, setPrintPending] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const [source, setSource] = useState<"api" | "upload">("api");
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Record<string, AttachmentStatus>>({});
  const [attachPending, setAttachPending] = useState<Set<string>>(new Set());
  const [attachErrors, setAttachErrors] = useState<Record<string, string>>({});
  const [blNoInputs, setBlNoInputs] = useState<Record<string, string>>({});
  // 첨부 시점에 그 PDF를 오프라인 파싱으로 미리 확인해둔 결과 — 등록 확인 팝업을 열 때 다시
  // 첨부하지 않아도 바로 보여주기 위함(ntsSendKey별로 1건).
  const [pdfExtracts, setPdfExtracts] = useState<Record<string, PdfExtractResult>>({});
  const [registeringKeys, setRegisteringKeys] = useState<Set<string>>(new Set());
  const [registerErrors, setRegisterErrors] = useState<Record<string, string>>({});
  const [multiBlModal, setMultiBlModal] = useState<MultiBlModalState | null>(null);
  const [multiBlError, setMultiBlError] = useState<string | null>(null);
  const [multiBlPending, setMultiBlPending] = useState(false);
  const [multiBlFile, setMultiBlFile] = useState<File | null>(null);
  const [multiBlExtractInfo, setMultiBlExtractInfo] = useState<{
    method: "offline" | "ai";
    lineCount: number;
    // 명세서에서 빼낸 부가세 합계 — 화면 금액이 문서에 인쇄된 B/L 합계와 다른 이유를 알려준다.
    vatTotal: number;
  } | null>(null);
  const [multiBlExtractError, setMultiBlExtractError] = useState<string | null>(null);
  const [multiBlExtractLoading, setMultiBlExtractLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bundleModal, setBundleModal] = useState<BundleModalState | null>(null);
  const [bundleSelectError, setBundleSelectError] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [bundlePending, setBundlePending] = useState(false);
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const [bundleExtractInfo, setBundleExtractInfo] = useState<{
    method: "offline" | "ai";
    lineCount: number;
    // 명세서에서 빼낸 부가세 합계 — 화면 금액이 문서에 인쇄된 B/L 합계와 다른 이유를 알려준다.
    vatTotal: number;
  } | null>(null);
  const [bundleExtractError, setBundleExtractError] = useState<string | null>(null);
  const [bundleExtractLoading, setBundleExtractLoading] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmFile, setConfirmFile] = useState<File | null>(null);
  const [confirmExtractInfo, setConfirmExtractInfo] = useState<{
    method: "offline" | "ai";
    lines: ExtractedLine[];
  } | null>(null);
  const [confirmExtractError, setConfirmExtractError] = useState<string | null>(null);
  const [confirmExtractLoading, setConfirmExtractLoading] = useState(false);
  // 인식 결과(성공 내용 또는 실패 사유)를 팝업으로 보여줄지 — 안내문이 첨부 칸 옆에 작은
  // 글씨로 묻혀 있어서 놓치기 쉽다는 피드백(2026-08-27)에 따라, 인식이 끝나는 순간 별도
  // 팝업으로 띄운다("확인"을 눌러야 닫힘).
  const [confirmExtractPopupOpen, setConfirmExtractPopupOpen] = useState(false);
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);
  const [editModal, setEditModal] = useState<EditModalState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editPending, setEditPending] = useState(false);
  const [amountModal, setAmountModal] = useState<AmountModalState | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [amountPending, setAmountPending] = useState(false);
  const [editChoice, setEditChoice] = useState<EditChoiceState | null>(null);
  const [unbundleModal, setUnbundleModal] = useState<UnbundleModalState | null>(null);
  const [unbundleError, setUnbundleError] = useState<string | null>(null);
  // 첨부된 인보이스 PDF 미리보기 — 예전엔 파일명을 누르면 새 탭이 열렸는데, 팝업으로 바로
  // 보이게 해달라는 요청(2026-08-27)에 따라 앱 안에서 iframe으로 띄운다.
  const [pdfPreview, setPdfPreview] = useState<{ ntsSendKey: string; fileName: string } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState<SortKey>>(null);
  // 목록을 새로 불러온 시각(바로빌 API 조회 또는 엑셀 업로드) — 안내 문구 대신 이것만 보여준다.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  async function loadAttachmentStatuses(rowsToCheck: TaxInvoiceRow[], dir: TaxInvoiceDirection) {
    if (rowsToCheck.length === 0) {
      setAttachments({});
      return;
    }
    const statuses = await getAttachmentStatuses(
      rowsToCheck.map((r) => ({ ntsSendKey: r.ntsSendKey, direction: dir }))
    );
    setAttachments(statuses);
  }

  function runSearch() {
    setError(null);
    startTransition(async () => {
      const result = await searchTaxInvoices({ direction, baseMonth: toBaseMonth(month), taxType, dateType });
      if (!result.ok) {
        setError(result.message);
        setRows(null);
        return;
      }
      setSource("api");
      setRows(result.rows);
      setNumbers(result.numbers);
      setPartyCodes(result.partyCodes);
      setTruncated(result.truncated);
      setSelectedKeys(new Set());
      setLastUpdatedAt(new Date());
      loadAttachmentStatuses(result.rows, direction);
    });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setUploadError(null);
    setUploadPending(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await uploadTaxInvoiceExcel(base64);
      if (!result.ok) {
        setUploadError(result.message);
        return;
      }
      setDirection(result.direction);
      setSource("upload");
      setUploadFileName(file.name);
      setRows(result.rows);
      setNumbers(result.numbers);
      setPartyCodes(result.partyCodes);
      setTruncated(false);
      setError(null);
      setLastUpdatedAt(new Date());
      loadAttachmentStatuses(result.rows, result.direction);
    } catch {
      setUploadError("엑셀 파일을 읽는 중 오류가 발생했습니다.");
    } finally {
      setUploadPending(false);
    }
  }

  async function handleAttachFile(row: TaxInvoiceRow, dir: TaxInvoiceDirection, file: File) {
    const ntsSendKey = row.ntsSendKey;
    setAttachErrors((prev) => {
      const next = { ...prev };
      delete next[ntsSendKey];
      return next;
    });
    setAttachPending((prev) => new Set(prev).add(ntsSendKey));
    try {
      const base64 = await fileToBase64(file);
      // AI 없이 "비고"란 텍스트에서 B/L을 1차 추출해서 같이 보낸다 — 사용자가 화면에서 확인/수정.
      const guess = extractBlNoFromRemark(row.remark1);
      const result = await attachTaxInvoiceFile({
        ntsSendKey,
        direction: dir,
        base64,
        originalName: file.name,
        blNo: guess || null,
        counterpartCorpNum: row.counterpartCorpNum,
      });
      if (!result.ok) {
        setAttachErrors((prev) => ({ ...prev, [ntsSendKey]: result.message }));
        return;
      }
      setAttachments((prev) => ({ ...prev, [ntsSendKey]: result.status }));
      setBlNoInputs((prev) => ({ ...prev, [ntsSendKey]: result.status.blNo ?? guess }));

      // 첨부한 시점에 그 PDF 내용 자체를 바로 확인해둔다(매출·매입 공통) — 비고 텍스트
      // 추측만 믿고 등록까지 가버리지 않도록, 실제 문서에서 인식된 B/L(과 여러 건이면 그
      // 내역)을 이 시점에 확보해서 등록 확인 팝업에 자동으로 보여준다(사용자가 따로 다시
      // 첨부할 필요 없음). 여러 B/L로 나눠 배분하는 팝업은 매입에만 있는 개념(Purchase는
      // 총액을 여러 B/L에 배분할 수 있지만 Sale은 B/L 1개=1행)이라, 매출에서 여러 건이
      // 인식되면 자동으로 나누지 않고 전부 나열만 해서 사용자가 맞는 것을 직접 고르게 한다.
      let multiBlOpened = false;
      // 방금 뽑은 검증 결과를 확인/승인 팝업에 그대로 넘기기 위해 따로 들고 있는다 —
      // setPdfExtracts는 비동기라 이 함수 안에서 pdfExtracts를 다시 읽어도 반영 전 값이 온다.
      let extractForConfirm: PdfExtractResult | undefined;
      let blNoForConfirm = result.status.blNo ?? guess;

      const extractResult = await extractPurchaseStatementPdf(base64);
      if (extractResult.ok && extractResult.data.lines.length > 0) {
        const lines: ExtractedLine[] = extractResult.data.lines.map((l) => ({ blNo: l.refNo, amount: l.supplyAmount ?? l.amount, vat: l.vat ?? 0 }));
        extractForConfirm = { status: "ok", method: extractResult.data.method, lines };
        setPdfExtracts((prev) => ({ ...prev, [ntsSendKey]: { status: "ok", method: extractResult.data.method, lines } }));
        if (lines.length === 1) {
          // 비고 정규식 추측보다 실제 문서 내용이 더 신뢰도 높으므로 이 값으로 덮어쓴다.
          setBlNoInputs((prev) => ({ ...prev, [ntsSendKey]: lines[0].blNo }));
          blNoForConfirm = lines[0].blNo;
        } else if (dir === "purchase") {
          // 실제 문서에서 B/L이 여러 건 확인됨 — 비고에 "외 N건" 표기가 없었더라도 바로
          // 나눠 배분 팝업을 인식된 실제 내용으로 채워서 연다(균등배분 추측 대신).
          setMultiBlError(null);
          setMultiBlFile(null);
          setMultiBlExtractError(null);
          setMultiBlExtractInfo({
            method: extractResult.data.method,
            lineCount: lines.length,
            vatTotal: lines.reduce((sum, l) => sum + l.vat, 0),
          });
          setMultiBlModal({
            row,
            rows: buildRawBlRows(lines),
            registerAs: looksLikeCustoms(row.itemName) ? "customs" : "purchase",
            customsPartyId: null,
            // 명세서의 W/F 금액을 별도 줄로 미리 채워준다(unissuedFromLines 주석 참고).
            unissued: unissuedFromLines(lines),
          });
          multiBlOpened = true;
        }
      } else {
        const failure: PdfExtractResult = {
          status: "error",
          message: extractResult.ok ? "PDF에서 B/L을 찾지 못했습니다 — 직접 입력하세요." : extractResult.message,
        };
        extractForConfirm = failure;
        setPdfExtracts((prev) => ({ ...prev, [ntsSendKey]: failure }));
      }

      // 위에서 실제 문서로 이미 나눠 배분 팝업을 열었다면, 비고의 "외 N건"에 기반한 균등배분
      // 추측(fallback)은 필요 없다 — 문서를 못 읽었을 때만(다른 양식 등) 이 추측을 쓴다.
      if (dir === "purchase" && !multiBlOpened) {
        const extraCount = extractAdditionalBlCount(row.remark1);
        if (extraCount > 0) {
          const total = extraCount + 1;
          const base = Math.floor(row.amountTotal / total);
          const remainder = row.amountTotal - base * (total - 1);
          const modalRows: MultiBlRow[] = Array.from({ length: total }, (_, i) => ({
            blNo: i === 0 ? result.status.blNo ?? guess : "",
            amountDisplay: commaInput(String(i === total - 1 ? remainder : base)),
          }));
          setMultiBlError(null);
          setMultiBlFile(null);
          setMultiBlExtractInfo(null);
          setMultiBlExtractError(null);
          setMultiBlModal({
            row,
            rows: modalRows,
            registerAs: looksLikeCustoms(row.itemName) ? "customs" : "purchase",
            customsPartyId: null,
            unissued: emptyUnissued(),
          });
          multiBlOpened = true;
        }
      }

      // 첨부가 끝나면 **검증 결과 확인/승인 팝업을 바로 띄운다** — "첨부 → 확인 → 승인 →
      // 전표(일반전표/관세전표) 등록"이 한 흐름으로 이어지게. 팝업을 안 띄우면 사용자가 첨부만
      // 하고 등록을 잊거나, 검증 결과를 못 보고 지나칠 수 있다.
      //  - 여러 B/L로 나눠 배분 팝업이 이미 떴으면 띄우지 않는다(팝업이 겹친다).
      //  - **이미 등록된 건("다시 첨부")에는 띄우지 않는다** — 등록 팝업이 다시 열리면 같은
      //    세금계산서를 두 번 등록하는 사고로 이어질 수 있다(전에 실제로 두 번 발생).
      if (!multiBlOpened && !result.status.matched) {
        openConfirmModal(row, dir, blNoForConfirm, extractForConfirm);
      }
    } catch {
      setAttachErrors((prev) => ({ ...prev, [ntsSendKey]: "인보이스 업로드 중 오류가 발생했습니다." }));
    } finally {
      setAttachPending((prev) => {
        const next = new Set(prev);
        next.delete(ntsSendKey);
        return next;
      });
    }
  }

  // 이미 묶여서 등록된 세금계산서들은 개별로 다시 첨부하지 않고, 묶음 전체에 대해서만 한
  // 번에 다시 첨부한다 — 개별로 첨부하면 묶음이 깨진 것처럼 보이거나 다시 등록 후보(체크박스)
  // 로 오해할 수 있기 때문이다.
  async function handleReattachGroup(groupRows: TaxInvoiceRow[], file: File) {
    const ntsSendKeys = groupRows.map((r) => r.ntsSendKey);
    setAttachErrors((prev) => {
      const next = { ...prev };
      ntsSendKeys.forEach((k) => delete next[k]);
      return next;
    });
    setAttachPending((prev) => {
      const next = new Set(prev);
      ntsSendKeys.forEach((k) => next.add(k));
      return next;
    });
    try {
      const base64 = await fileToBase64(file);
      const result = await reattachGroupFile({
        ntsSendKeys,
        base64,
        originalName: file.name,
        counterpartCorpNum: groupRows[0].counterpartCorpNum,
      });
      if (!result.ok) {
        setAttachErrors((prev) => ({ ...prev, [ntsSendKeys[0]]: result.message }));
        return;
      }
      setAttachments((prev) => ({ ...prev, ...result.statuses }));
    } catch {
      setAttachErrors((prev) => ({ ...prev, [ntsSendKeys[0]]: "인보이스 업로드 중 오류가 발생했습니다." }));
    } finally {
      setAttachPending((prev) => {
        const next = new Set(prev);
        ntsSendKeys.forEach((k) => next.delete(k));
        return next;
      });
    }
  }

  // "묶어서 등록"을 취소하고 다시 첨부/등록할 수 있는 상태로 되돌린다 — 실제 매출/매입/관세전표
  // 등록을 지우는 되돌릴 수 없는 동작이라 항상 먼저 확인을 받는다. 행에서 직접(renderGroupRow)
  // 또는 "수정" 팝업(editModal, 2건 이상일 때)에서 호출되므로 TaxInvoiceRow[] 대신 원시값을 받는다.
  // "묶음 풀기" 확인 팝업을 연다 — 사유를 받아야 해서(2026-08-27, 다른 수정 흐름들과
  // 마찬가지로) window.confirm 대신 전용 팝업을 쓴다. 확인 문구에 넣을 합계금액이 필요해서
  // 등록내역을 먼저 조회한다("외 N건" 팝업·B/L 변경 팝업과 같은 조회를 재사용).
  async function handleUnbundleFromRow(ntsSendKeys: string[], counterpartCorpNum: string, blNo: string) {
    setUnbundleError(null);
    const detail = await getRegistrationDetail({ ntsSendKey: ntsSendKeys[0], direction, counterpartCorpNum });
    setUnbundleModal({
      ntsSendKeys,
      counterpartCorpNum,
      blNo,
      combinedAmountTotal: detail.ok ? detail.detail.totalAmount : 0,
      reasonCategory: "재묶음",
      reason: "",
    });
  }

  async function handleSaveUnbundle() {
    if (!unbundleModal) return;
    if (!unbundleModal.reason.trim()) {
      setUnbundleError("묶음 풀기 사유를 입력하세요.");
      return;
    }
    const { ntsSendKeys, counterpartCorpNum, blNo, reasonCategory, reason } = unbundleModal;
    const fullReason = `[${reasonCategory}] ${reason.trim()}`;
    setUnbundleError(null);
    setAttachErrors((prev) => {
      const next = { ...prev };
      ntsSendKeys.forEach((k) => delete next[k]);
      return next;
    });
    setAttachPending((prev) => {
      const next = new Set(prev);
      ntsSendKeys.forEach((k) => next.add(k));
      return next;
    });
    try {
      const result = await unbundleGroup({ ntsSendKeys, counterpartCorpNum, reason: fullReason });
      if (!result.ok) {
        setUnbundleError(result.message);
        return;
      }
      setAttachments((prev) => ({ ...prev, ...result.statuses }));
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.delete(blNo);
        return next;
      });
      setUnbundleModal(null);
    } catch {
      setUnbundleError("묶음 풀기 중 오류가 발생했습니다.");
    } finally {
      setAttachPending((prev) => {
        const next = new Set(prev);
        ntsSendKeys.forEach((k) => next.delete(k));
        return next;
      });
    }
  }

  async function handleRegister(
    row: TaxInvoiceRow,
    dir: TaxInvoiceDirection,
    blNo: string,
    registerAs: RegisterAs,
    customsPartyId: string | null = null,
    // B/L을 2건 이상으로 나눠 등록할 때만 넘긴다(confirmModal의 blRows — PDF 인식이 여러 B/L을
    // 찾아 자동으로 채웠거나, 매출은 "+B/L 추가"로 직접 나눈 경우). 안 넘기면 기존처럼 blNo
    // 하나 + 전체 금액으로 등록한다. registerFromTaxInvoice는 매출·매입 모두 allocations
    // 배열을 받으므로 방향과 무관하게 그대로 쓸 수 있다.
    multiAllocations?: { blNo: string; amount: number }[]
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const ntsSendKey = row.ntsSendKey;
    setRegisterErrors((prev) => {
      const next = { ...prev };
      delete next[ntsSendKey];
      return next;
    });
    setRegisteringKeys((prev) => new Set(prev).add(ntsSendKey));
    try {
      const result = await registerFromTaxInvoice(
        dir === "sales"
          ? {
              ntsSendKey,
              direction: "sales",
              allocations: multiAllocations ?? [{ blNo, amount: row.amountTotal }],
              counterpartName: row.counterpartCorpName,
              counterpartCorpNum: row.counterpartCorpNum,
              writeDate: row.writeDate,
              note: row.itemName,
            }
          : {
              ntsSendKey,
              direction: "purchase",
              registerAs,
              customsPartyId,
              allocations: multiAllocations ?? [{ blNo, amount: row.amountTotal }],
              counterpartName: row.counterpartCorpName,
              counterpartCorpNum: row.counterpartCorpNum,
              writeDate: row.writeDate,
              note: row.itemName,
            }
      );
      if (!result.ok) {
        setRegisterErrors((prev) => ({ ...prev, [ntsSendKey]: result.message }));
        return { ok: false, message: result.message };
      }
      setAttachments((prev) => ({ ...prev, [ntsSendKey]: result.status }));
      return { ok: true };
    } catch {
      const message = "등록 중 오류가 발생했습니다.";
      setRegisterErrors((prev) => ({ ...prev, [ntsSendKey]: message }));
      return { ok: false, message };
    } finally {
      setRegisteringKeys((prev) => {
        const next = new Set(prev);
        next.delete(ntsSendKey);
        return next;
      });
    }
  }

  // "매출/매입 등록" 버튼을 눌러도 바로 등록하지 않고, 등록될 내용(거래처·금액·B/L·기존
  // 반대쪽 거래와의 자동연결 여부)을 먼저 보여주는 확인 팝업을 연다.
  async function openConfirmModal(
    row: TaxInvoiceRow,
    dir: TaxInvoiceDirection,
    blNo: string,
    // 첨부 직후 자동으로 열 때는 방금 뽑은 결과를 직접 넘긴다 — setPdfExtracts가 비동기라
    // 그 시점의 pdfExtracts에는 아직 반영되지 않았기 때문이다.
    extractOverride?: PdfExtractResult
  ) {
    setConfirmError(null);
    setConfirmFile(null);
    // 첨부할 때 이미 PDF 내용을 확인해뒀다면(매출·매입 공통) 다시 첨부하라고 하지 않고 그
    // 결과를 바로 보여준다 — 그래야 사용자가 별도 조치 없이도 실제로 무엇이 등록되는지 알 수 있다.
    const existingExtract = extractOverride ?? pdfExtracts[row.ntsSendKey];
    if (existingExtract) {
      if (existingExtract.status === "ok") {
        setConfirmExtractInfo({ method: existingExtract.method, lines: existingExtract.lines });
        setConfirmExtractError(null);
      } else {
        setConfirmExtractInfo(null);
        setConfirmExtractError(existingExtract.message);
      }
      setConfirmExtractPopupOpen(true);
    } else {
      setConfirmExtractInfo(null);
      setConfirmExtractError(null);
      setConfirmExtractPopupOpen(false);
    }
    setConfirmModal({
      row,
      dir,
      blNo,
      // 매출은 항상 줄(항목+B/L+금액) 형태로 보여준다 — 1건뿐이어도 "항목" 선택이 보여야
      // 한다는 피드백(2026-08-27)에 따름. 매입은 기존처럼 별도 "여러 B/L로 나눠 배분" 팝업이
      // 있어 여기서는 손대지 않는다(null 유지).
      blRows: dir === "sales" ? [{ blNo, amountDisplay: commaInput(String(row.amountTotal)), kind: "bl" }] : null,
      registerAs: looksLikeCustoms(row.itemName) ? "customs" : "purchase",
      customsPartyId: null,
      existingLabel: null,
      loadingPreview: true,
    });
    const preview = await previewTaxInvoiceLink({ direction: dir, blNo });
    setConfirmModal((prev) =>
      prev && prev.row.ntsSendKey === row.ntsSendKey
        ? { ...prev, existingLabel: preview.existingLabel, loadingPreview: false }
        : prev
    );
  }

  // B/L을 수정하면(직접 입력 또는 PDF 인식 결과 반영) 그 값 기준으로 기존 반대쪽 거래
  // 자동연결 미리보기를 다시 확인한다 — 안 그러면 팝업을 연 시점의 B/L 기준 정보가 그대로
  // 남아 혼란을 준다.
  function handleConfirmBlNoChange(blNo: string) {
    setConfirmModal((prev) => (prev ? { ...prev, blNo, loadingPreview: true, existingLabel: null } : prev));
    const dir = confirmModal?.dir;
    if (!dir) return;
    previewTaxInvoiceLink({ direction: dir, blNo }).then((preview) => {
      setConfirmModal((prev) =>
        prev && prev.blNo === blNo ? { ...prev, existingLabel: preview.existingLabel, loadingPreview: false } : prev
      );
    });
  }

  // "+ B/L 추가" — 매출 등록 확인 팝업을 단일 B/L 입력에서 여러 줄(B/L+금액) 입력으로
  // 바꾼다. 처음 누르는 순간 지금까지 입력해둔 B/L 1건 + 전체 공급가액을 첫 줄로 그대로
  // 옮겨서, 사용자가 이미 입력한 값을 잃지 않게 한다.
  function addConfirmBlRow() {
    setConfirmModal((prev) => {
      if (!prev) return prev;
      const rows: SalesBlRow[] = prev.blRows ?? [
        { blNo: prev.blNo, amountDisplay: commaInput(String(prev.row.amountTotal)), kind: "bl" },
      ];
      return { ...prev, blRows: [...rows, { blNo: "", amountDisplay: "", kind: "bl" }] };
    });
  }

  // "차액 추가" — 배분 합계와 공급가액이 안 맞을 때, 그 차액을 값으로 채운 줄을 하나 더
  // 추가한다(항목은 "기타"로 시작 — 특정 B/L이 아니라 남는/모자란 금액이라서). 직접 계산해서
  // 입력하지 않아도 배분 합계가 바로 공급가액과 맞춰진다.
  function addConfirmDifferenceRow() {
    setConfirmModal((prev) => {
      if (!prev || !prev.blRows) return prev;
      const sum = prev.blRows.reduce((s, r) => s + numOf(r.amountDisplay), 0);
      const diff = prev.row.amountTotal - sum;
      if (diff === 0) return prev;
      return {
        ...prev,
        blRows: [...prev.blRows, { blNo: "", amountDisplay: commaInput(String(diff)), kind: "etc" }],
      };
    });
  }

  function removeConfirmBlRow(idx: number) {
    setConfirmModal((prev) => {
      // 항상 줄 형태로 보여주기로 했으니(2026-08-27) 최소 1줄은 남긴다 — 그 아래로는
      // "삭제" 버튼 자체를 안 보여준다(아래 렌더링 부분 참고).
      if (!prev || !prev.blRows || prev.blRows.length <= 1) return prev;
      const rows = prev.blRows.filter((_, i) => i !== idx);
      return { ...prev, blRows: rows };
    });
  }

  function updateConfirmBlRow(idx: number, patch: Partial<SalesBlRow>) {
    setConfirmModal((prev) => {
      if (!prev || !prev.blRows) return prev;
      return { ...prev, blRows: prev.blRows.map((r, i) => (i === idx ? { ...r, ...patch } : r)) };
    });
  }

  function confirmBlRowsSum(): number {
    return confirmModal?.blRows?.reduce((sum, r) => sum + numOf(r.amountDisplay), 0) ?? 0;
  }

  async function handleConfirmRegister() {
    if (!confirmModal) return;
    // 승인이 곧 확정이므로, 검증 실패가 확인된 상태면 여기서 한 번 더 물어본다 — 자동 인식이
    // 틀릴 수도 있어 완전히 막지는 않고 사용자가 알고 넘어가게만 한다.
    if (!confirmDespiteValidation(confirmModal.row)) return;

    // B/L을 여러 줄로 나눴으면(매출·매입 공통 — PDF 인식이 여러 B/L을 찾아 자동으로 나눴거나,
    // 매출은 "+B/L 추가"로 직접 나눈 경우) 여기서 배분 금액 합계를 검증한다 — "여러 B/L로 나눠
    // 배분" 팝업(handleRegisterMulti)과 같은 기준: 합계가 공급가액과 정확히 같아야 한다.
    let multiAllocations: { blNo: string; amount: number }[] | undefined;
    if (confirmModal.blRows) {
      const allocations = confirmModal.blRows
        .filter((r) => r.blNo.trim())
        .map((r) => ({ blNo: r.blNo.trim(), amount: numOf(r.amountDisplay) }));
      if (allocations.length === 0) {
        setConfirmError("B/L을 1건 이상 입력하세요.");
        return;
      }
      const sum = allocations.reduce((s, a) => s + a.amount, 0);
      if (sum !== confirmModal.row.amountTotal) {
        setConfirmError(
          `B/L별 금액 합계(${formatAmount(sum)})가 공급가액(${formatAmount(confirmModal.row.amountTotal)})과 일치해야 합니다.`
        );
        return;
      }
      multiAllocations = allocations;
    }

    setConfirmError(null);
    setConfirmPending(true);
    try {
      const result = await handleRegister(
        confirmModal.row,
        confirmModal.dir,
        confirmModal.blNo,
        confirmModal.registerAs,
        confirmModal.customsPartyId,
        multiAllocations
      );
      if (result.ok) {
        setConfirmModal(null);
      } else {
        setConfirmError(result.message);
      }
    } finally {
      setConfirmPending(false);
    }
  }

  // 승인된 세금계산서의 "수정" 버튼 — B/L·첨부파일을 고치는 팝업을 열고 기존 수정 이력을
  // 함께 불러온다(매출·매입 공통). 묶음이면 ntsSendKeys에 묶음 전체를 담아야 구성원 전부의
  // B/L이 같이 갱신된다 — 하나만 바꾸면 묶음 표시가 깨진다.
  function openEditModal(
    ntsSendKeys: string[],
    counterpartCorpNum: string,
    attachment: AttachmentStatus
  ) {
    setEditError(null);
    setEditModal({
      ntsSendKeys,
      direction,
      counterpartCorpNum,
      currentBlNo: attachment.blNo ?? "",
      currentFileName: attachment.fileName,
      newBlNo: attachment.blNo ?? "",
      reasonCategory: "B/L 오타 정정",
      reason: "",
      file: null,
      history: null,
      historyLoading: true,
      detail: null,
      detailLoading: true,
      detailError: null,
      extract: null,
      extractError: null,
      extractLoading: false,
    });
    const key = ntsSendKeys[0];
    getTaxInvoiceEditHistory(key).then((result) => {
      setEditModal((prev) =>
        prev && prev.ntsSendKeys[0] === key
          ? { ...prev, history: result.ok ? result.entries : [], historyLoading: false }
          : prev
      );
    });
    // 등록내역은 "외 N건" 팝업과 같은 액션을 재사용한다 — 같은 정보를 두 곳에서 다르게 계산하면
    // 어긋난다.
    getRegistrationDetail({ ntsSendKey: key, direction, counterpartCorpNum }).then((result) => {
      setEditModal((prev) =>
        prev && prev.ntsSendKeys[0] === key
          ? result.ok
            ? { ...prev, detail: result.detail, detailLoading: false }
            : { ...prev, detailLoading: false, detailError: result.message }
          : prev
      );
    });
  }

  // 수정 팝업에서 다시 첨부한 PDF의 내용을 읽어 보여준다(등록 흐름과 같은 추출기). 여기서 배분을
  // 다시 짜지는 않는다 — 금액 배분을 바꾸려면 "묶음 풀기"로 등록을 취소하고 다시 등록해야 한다.
  async function handleEditFileChange(file: File | null) {
    setEditModal((prev) =>
      prev ? { ...prev, file, extract: null, extractError: null, extractLoading: Boolean(file) } : prev
    );
    if (!file) return;
    try {
      const base64 = await fileToBase64(file);
      const result = await extractPurchaseStatementPdf(base64);
      setEditModal((prev) => {
        if (!prev) return prev;
        if (!result.ok) return { ...prev, extractLoading: false, extractError: result.message };
        const lines = result.data.lines.map((l) => ({ blNo: l.refNo, amount: l.supplyAmount ?? l.amount, vat: l.vat ?? 0 }));
        if (lines.length === 0) {
          return { ...prev, extractLoading: false, extractError: "PDF에서 B/L별 줄을 찾지 못했습니다." };
        }
        return { ...prev, extractLoading: false, extract: { method: result.data.method, lines } };
      });
    } catch {
      setEditModal((prev) => (prev ? { ...prev, extractLoading: false, extractError: "PDF 처리 중 오류가 발생했습니다." } : prev));
    }
  }

  async function handleSaveEdit() {
    if (!editModal) return;
    setEditError(null);
    setEditPending(true);
    try {
      const file = editModal.file
        ? { base64: await fileToBase64(editModal.file), originalName: editModal.file.name }
        : null;
      const result = await editApprovedTaxInvoice({
        ntsSendKeys: editModal.ntsSendKeys,
        direction: editModal.direction,
        counterpartCorpNum: editModal.counterpartCorpNum,
        newBlNo: editModal.newBlNo,
        reason: `[${editModal.reasonCategory}] ${editModal.reason.trim()}`,
        file,
      });
      if (!result.ok) {
        setEditError(result.message);
        return;
      }
      setAttachments((prev) => ({ ...prev, ...result.statuses }));
      setEditModal(null);
    } catch {
      setEditError("수정 중 오류가 발생했습니다.");
    } finally {
      setEditPending(false);
    }
  }

  // "금액 조정" 팝업을 연다 — B/L은 손대지 않고, 이미 등록된 B/L별 금액만 고칠 수 있게
  // 현재 등록 내역(blRows)을 불러와 그대로 편집 칸의 초기값으로 쓴다.
  function openAmountModal(ntsSendKeys: string[], counterpartCorpNum: string) {
    setAmountError(null);
    setAmountModal({
      ntsSendKeys,
      direction,
      counterpartCorpNum,
      rows: null,
      detailError: null,
      reason: "",
      history: null,
      historyLoading: true,
    });
    const key = ntsSendKeys[0];
    getTaxInvoiceEditHistory(key).then((result) => {
      setAmountModal((prev) =>
        prev && prev.ntsSendKeys[0] === key
          ? { ...prev, history: result.ok ? result.entries : [], historyLoading: false }
          : prev
      );
    });
    getRegistrationDetail({ ntsSendKey: key, direction, counterpartCorpNum }).then((result) => {
      setAmountModal((prev) => {
        if (!prev || prev.ntsSendKeys[0] !== key) return prev;
        if (!result.ok) return { ...prev, rows: [], detailError: result.message };
        const rows: AmountAdjustRow[] = result.detail.blRows.map((b) => ({
          blNo: b.blNo,
          currentAmount: b.amount,
          newAmountDisplay: commaInput(String(Math.round(b.amount))),
        }));
        return { ...prev, rows };
      });
    });
  }

  function updateAmountRow(idx: number, newAmountDisplay: string) {
    setAmountModal((prev) => {
      if (!prev || !prev.rows) return prev;
      return { ...prev, rows: prev.rows.map((r, i) => (i === idx ? { ...r, newAmountDisplay } : r)) };
    });
  }

  async function handleSaveAmountAdjust() {
    if (!amountModal || !amountModal.rows) return;
    if (!amountModal.reason.trim()) {
      setAmountError("수정 사유를 입력하세요.");
      return;
    }
    setAmountError(null);
    setAmountPending(true);
    try {
      const result = await adjustApprovedTaxInvoiceAmount({
        ntsSendKeys: amountModal.ntsSendKeys,
        direction: amountModal.direction,
        counterpartCorpNum: amountModal.counterpartCorpNum,
        amounts: amountModal.rows.map((r) => ({ blNo: r.blNo, amount: numOf(r.newAmountDisplay) })),
        reason: amountModal.reason.trim(),
      });
      if (!result.ok) {
        setAmountError(result.message);
        return;
      }
      setAttachments((prev) => ({ ...prev, ...result.statuses }));
      setAmountModal(null);
    } catch {
      setAmountError("수정 중 오류가 발생했습니다.");
    } finally {
      setAmountPending(false);
    }
  }

  // 단건 등록 확인 팝업에도 실제 인보이스(지출결의서 등) PDF를 첨부해서 내용을 확인할 수 있게
  // 한다. B/L이 1건이면 그대로 입력칸에 채우고, 여러 건이면(이 인보이스가 여러 건을 커버하는
  // 경우) 인식된 줄 전부를 B/L별 배분 목록(blRows)으로 자동 채운다 — 예전엔 목록만 보여주고
  // "직접 입력하세요"라고만 안내해서, 사람이 보이는 번호를 다시 손으로 치거나 하나씩 골라야
  // 했다(2026-09-03 피드백: "2개면 B/L에 2개가 전부나와야지"). registerFromTaxInvoice는
  // 매출·매입 모두 원래 여러 줄 배분(allocations)을 받으므로 방향과 무관하게 그대로 쓸 수 있다.
  async function handleConfirmFileChange(file: File | null) {
    setConfirmFile(file);
    setConfirmExtractInfo(null);
    setConfirmExtractError(null);
    setConfirmExtractPopupOpen(false);
    if (!file) return;

    setConfirmExtractLoading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await extractPurchaseStatementPdf(base64);
      if (!result.ok) {
        setConfirmExtractError(result.message);
        setConfirmExtractPopupOpen(true);
        return;
      }
      if (result.data.lines.length === 0) {
        setConfirmExtractError("PDF에서 B/L을 찾지 못했습니다 — 직접 입력하세요.");
        setConfirmExtractPopupOpen(true);
        return;
      }

      const lines = result.data.lines.map((l) => ({ blNo: l.refNo, amount: l.supplyAmount ?? l.amount, vat: l.vat ?? 0 }));
      if (lines.length === 1) {
        // 줄(항목+B/L+금액) 목록 모드면 confirmModal.blNo가 아니라 첫 줄에 직접 채운다 —
        // 안 그러면 인식 결과 팝업에서 "확인"을 눌러도 화면의 B/L 입력칸은 그대로 비어 있는
        // 것처럼 보인다(2026-08-27, 실제로 그렇게 비어 있었다는 피드백). 금액도 공급가액이
        // 아니라 인식된 금액으로 채운다 — 공급가액과 다르면(위 팝업의 "차액") 배분 합계도
        // 자연히 안 맞게 표시되어, 나머지 차액을 다른 줄에 채워 넣어야 한다는 게 눈에 바로
        // 보인다.
        if (confirmModal?.blRows) {
          updateConfirmBlRow(0, {
            blNo: lines[0].blNo,
            amountDisplay: commaInput(String(Math.round(lines[0].amount))),
          });
        } else {
          handleConfirmBlNoChange(lines[0].blNo);
        }
      } else {
        // 여러 줄이면 전부를 배분 목록으로 바로 채운다 — 방향(매출/매입) 상관없이 같은
        // blRows 메커니즘을 쓴다.
        setConfirmModal((prev) =>
          prev
            ? {
                ...prev,
                blRows: lines.map((l) => ({
                  blNo: l.blNo,
                  amountDisplay: commaInput(String(Math.round(l.amount))),
                  kind: "bl" as const,
                })),
              }
            : prev
        );
      }
      setConfirmExtractInfo({ method: result.data.method, lines });
      setConfirmExtractPopupOpen(true);
    } catch {
      setConfirmExtractError("PDF 처리 중 오류가 발생했습니다.");
      setConfirmExtractPopupOpen(true);
    } finally {
      setConfirmExtractLoading(false);
    }
  }

  function updateMultiBlRow(idx: number, patch: Partial<MultiBlRow>) {
    setMultiBlModal((prev) =>
      prev ? { ...prev, rows: prev.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)) } : prev
    );
  }

  function addMultiBlRow() {
    setMultiBlModal((prev) => (prev ? { ...prev, rows: [...prev.rows, { blNo: "", amountDisplay: "" }] } : prev));
  }

  function removeMultiBlRow(idx: number) {
    setMultiBlModal((prev) => (prev ? { ...prev, rows: prev.rows.filter((_, i) => i !== idx) } : prev));
  }

  // 여러 B/L 배분 팝업에도 묶어서 등록과 동일하게 인보이스(지출결의서 등) 첨부 시 자동 인식을
  // 붙인다 — 관세전표로 등록할 때도(등록 유형과 무관하게 같은 문서 구조이므로) 그대로 쓸 수 있다.
  async function handleMultiBlFileChange(file: File | null) {
    setMultiBlFile(file);
    setMultiBlExtractInfo(null);
    setMultiBlExtractError(null);
    if (!file || !multiBlModal) return;

    setMultiBlExtractLoading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await extractPurchaseStatementPdf(base64);
      if (!result.ok) {
        setMultiBlExtractError(result.message);
        return;
      }
      if (result.data.lines.length === 0) {
        setMultiBlExtractError("PDF에서 B/L별 화물 줄을 찾지 못했습니다 — 직접 입력하세요.");
        return;
      }

      const lines: ExtractedLine[] = result.data.lines.map((l) => ({ blNo: l.refNo, amount: l.supplyAmount ?? l.amount, vat: l.vat ?? 0 }));
      setMultiBlModal((prev) =>
        prev ? { ...prev, rows: buildRawBlRows(lines), unissued: unissuedFromLines(lines) } : prev
      );
      setMultiBlExtractInfo({
        method: result.data.method,
        lineCount: lines.length,
        vatTotal: lines.reduce((sum, l) => sum + l.vat, 0),
      });
    } catch {
      setMultiBlExtractError("PDF 처리 중 오류가 발생했습니다.");
    } finally {
      setMultiBlExtractLoading(false);
    }
  }

  async function handleRegisterMulti() {
    if (!multiBlModal) return;
    const { row, rows: modalRows } = multiBlModal;
    const allocations = modalRows
      .filter((r) => r.blNo.trim() && numOf(r.amountDisplay) !== 0)
      .map((r) => ({ blNo: r.blNo.trim(), amount: numOf(r.amountDisplay), label: "" }));

    if (allocations.length === 0) {
      setMultiBlError("B/L을 1건 이상 입력하세요.");
      return;
    }
    // 세금계산서에 없는(미발행) 금액이 있으면 명칭을 붙여 별도 배분 줄로 함께 보낸다.
    const unissuedAmount = numOf(multiBlModal.unissued.amountDisplay);
    if (unissuedAmount !== 0) {
      const label = unissuedLabelOf(multiBlModal.unissued);
      if (!label) {
        setMultiBlError("미발행 금액의 명칭을 입력하세요.");
        return;
      }
      allocations.push({ blNo: multiBlModal.unissued.blNo.trim(), amount: unissuedAmount, label });
    }
    const allocTotal = allocations.reduce((sum, a) => sum + a.amount, 0);
    const targets = allocationTargets(row.amountTotal, row.totalAmount);
    if (!matchesAnyTarget(allocTotal, targets)) {
      setMultiBlError(
        `배분 합계(${allocTotal.toLocaleString("ko-KR")})가 공급가액(${row.amountTotal.toLocaleString("ko-KR")})` +
          ` 또는 합계금액(${row.totalAmount.toLocaleString("ko-KR")})과 일치해야 합니다.` +
          ` 차액이 세금계산서에 없는 금액이면 아래 "미발행" 줄에 명칭과 함께 적어주세요.`
      );
      return;
    }

    setMultiBlError(null);
    setMultiBlPending(true);
    try {
      const result = await registerFromTaxInvoice({
        ntsSendKey: row.ntsSendKey,
        direction: "purchase",
        registerAs: multiBlModal.registerAs,
        customsPartyId: multiBlModal.customsPartyId,
        allocations,
        counterpartName: row.counterpartCorpName,
        counterpartCorpNum: row.counterpartCorpNum,
        writeDate: row.writeDate,
        note: row.itemName,
      });
      if (!result.ok) {
        setMultiBlError(result.message);
        return;
      }
      setAttachments((prev) => ({ ...prev, [row.ntsSendKey]: result.status }));
      setMultiBlModal(null);
    } catch {
      setMultiBlError("등록 중 오류가 발생했습니다.");
    } finally {
      setMultiBlPending(false);
    }
  }

  function toggleSelected(ntsSendKey: string) {
    setBundleSelectError(null);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(ntsSendKey)) next.delete(ntsSendKey);
      else next.add(ntsSendKey);
      return next;
    });
  }

  // 같은 지출결의서(예: 같은 B/L들)에서 나온 여러 세금계산서(OCEAN FREIGHT + DRAYAGE CHG
  // 등)를 하나의 매입으로 묶는다. 개별 등록은 합계금액(부가세 포함) 기준이지만, 묶음 등록은
  // 공급가액 합계를 기준으로 B/L 배분을 검증한다(사용자 확인된 방식).
  function openBundleModal() {
    const selectedRows = (rows ?? []).filter((r) => selectedKeys.has(r.ntsSendKey));
    if (selectedRows.length < 2) {
      setBundleSelectError("2건 이상 선택하세요.");
      return;
    }
    const names = new Set(selectedRows.map((r) => r.counterpartCorpName));
    if (names.size > 1) {
      setBundleSelectError("선택한 세금계산서들의 거래처가 서로 다릅니다. 같은 거래처끼리만 묶을 수 있습니다.");
      return;
    }
    setBundleSelectError(null);
    setBundleError(null);
    setBundleFile(null);
    setBundleExtractInfo(null);
    setBundleExtractError(null);
    // 행이 1개뿐일 때는 그 B/L 하나로 전액이 들어가는 게 당연하므로 금액을 미리 채워두고,
    // B/L도 (여러 인보이스 대부분 같은 비고를 공유하므로) 첫 번째 선택한 세금계산서의 비고에서
    // 정규식으로 1차 추출해 채워둔다 — 둘 다 그대로 등록해도 되고, 직접 고쳐도 된다. 행을
    // 추가하면(여러 B/L로 쪼개기 시작하면) 그때부터는 자동 채움을 시도하지 않는다.
    const combinedSupplyAmount = selectedRows.reduce((sum, r) => sum + r.amountTotal, 0);
    const guess = extractBlNoFromRemark(selectedRows[0].remark1);
    setBundleModal({
      direction,
      rows: selectedRows,
      blRows: [{ blNo: guess, amountDisplay: commaInput(String(combinedSupplyAmount)) }],
      registerAs: selectedRows.every((r) => looksLikeCustoms(r.itemName)) ? "customs" : "purchase",
      customsPartyId: null,
      unissued: emptyUnissued(),
    });
  }

  function updateBundleBlRow(idx: number, patch: Partial<MultiBlRow>) {
    setBundleModal((prev) =>
      prev ? { ...prev, blRows: prev.blRows.map((r, i) => (i === idx ? { ...r, ...patch } : r)) } : prev
    );
  }

  function addBundleBlRow() {
    setBundleModal((prev) => (prev ? { ...prev, blRows: [...prev.blRows, { blNo: "", amountDisplay: "" }] } : prev));
  }

  function removeBundleBlRow(idx: number) {
    setBundleModal((prev) => (prev ? { ...prev, blRows: prev.blRows.filter((_, i) => i !== idx) } : prev));
  }

  // 묶어서 등록 팝업에 첨부하는 인보이스(지출결의서 등)를 AI 없이(오프라인 파싱 우선) 분석해서
  // House/Master No별 줄이 있으면 B/L 배분 행에 그대로 채워준다 — "직접 입력"이 기본이었던
  // 초기 균등배분/단일guess 대신, 실제 문서 내용을 바로 확인/수정할 수 있게 하기 위함.
  // 인식에 실패해도(다른 양식 등) 기존 입력은 그대로 두고 오류만 알려준다.
  //
  // 명세서 자체의 합계는 보통 부가세(또는 이 묶음에 없는 다른 세금계산서분)까지 섞여 있어
  // 공급가액 합계(묶음 등록의 등록 기준)와 정확히 안 맞을 때가 많다 — House별로 부가세가
  // 얼마씩 들어있는지까지는 문서에서 안전하게 갈라낼 수 없으므로, 인식된 각 줄의 금액을
  // 공급가액 합계에 맞춰 그 비율만큼 균등하게 축소/확대한다(반올림 오차는 마지막 줄에서
  // 흡수해 합계가 정확히 맞게 만든다). 원래 인식 금액과 다르다는 점을 화면에 그대로 알려주고,
  // 어차피 등록 전 확인/수정을 요구한다.
  async function handleBundleFileChange(file: File | null) {
    setBundleFile(file);
    setBundleExtractInfo(null);
    setBundleExtractError(null);
    if (!file || !bundleModal) return;

    setBundleExtractLoading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await extractPurchaseStatementPdf(base64);
      if (!result.ok) {
        setBundleExtractError(result.message);
        return;
      }
      if (result.data.lines.length === 0) {
        setBundleExtractError("PDF에서 B/L별 화물 줄을 찾지 못했습니다 — 직접 입력하세요.");
        return;
      }

      const lines: ExtractedLine[] = result.data.lines.map((l) => ({ blNo: l.refNo, amount: l.supplyAmount ?? l.amount, vat: l.vat ?? 0 }));
      setBundleModal((prev) =>
        prev ? { ...prev, blRows: buildRawBlRows(lines), unissued: unissuedFromLines(lines) } : prev
      );
      setBundleExtractInfo({
        method: result.data.method,
        lineCount: lines.length,
        vatTotal: lines.reduce((sum, l) => sum + l.vat, 0),
      });
    } catch {
      setBundleExtractError("PDF 처리 중 오류가 발생했습니다.");
    } finally {
      setBundleExtractLoading(false);
    }
  }

  async function handleRegisterBundle() {
    if (!bundleModal) return;
    const { rows: bundleRows, blRows } = bundleModal;
    const allocations = blRows
      .filter((r) => r.blNo.trim() && numOf(r.amountDisplay) !== 0)
      .map((r) => ({ blNo: r.blNo.trim(), amount: numOf(r.amountDisplay), label: "" }));

    if (allocations.length === 0) {
      setBundleError("B/L을 1건 이상 입력하세요.");
      return;
    }
    // 미발행 줄과 "합계금액 기준" 검증은 **매입 묶음에만** 적용한다. 매출 묶음은 인보이스에서
    // 금액을 읽어오지 않고 세금계산서 공급가액을 그대로 쓰므로 예전 규칙(공급가액)이 맞다.
    const isPurchase = bundleModal.direction === "purchase";
    if (isPurchase) {
      const unissuedAmount = numOf(bundleModal.unissued.amountDisplay);
      if (unissuedAmount !== 0) {
        const label = unissuedLabelOf(bundleModal.unissued);
        if (!label) {
          setBundleError("미발행 금액의 명칭을 입력하세요.");
          return;
        }
        allocations.push({ blNo: bundleModal.unissued.blNo.trim(), amount: unissuedAmount, label });
      }
    }
    const allocTotal = allocations.reduce((sum, a) => sum + a.amount, 0);
    const supplySum = bundleRows.reduce((sum, r) => sum + r.amountTotal, 0);
    const totalSum = bundleRows.reduce((sum, r) => sum + r.totalAmount, 0);
    // 매출은 세금계산서 공급가액을 그대로 쓰므로 예전 규칙(공급가액)만 정답이다.
    const targets = isPurchase ? allocationTargets(supplySum, totalSum) : [supplySum];
    if (!matchesAnyTarget(allocTotal, targets)) {
      setBundleError(
        `배분 합계(${allocTotal.toLocaleString("ko-KR")})가 ` +
          (isPurchase
            ? `공급가액 합계(${supplySum.toLocaleString("ko-KR")}) 또는 합계금액 합(${totalSum.toLocaleString("ko-KR")})`
            : `공급가액 합계(${supplySum.toLocaleString("ko-KR")})`) +
          `과 일치해야 합니다.` +
          (isPurchase ? ` 차액이 세금계산서에 없는 금액이면 아래 "미발행" 줄에 명칭과 함께 적어주세요.` : "")
      );
      return;
    }

    setBundleError(null);
    setBundlePending(true);
    try {
      const earliest = bundleRows.reduce((min, r) => (r.writeDate < min ? r.writeDate : min), bundleRows[0].writeDate);
      const note = [...new Set(bundleRows.map((r) => r.itemName))].join(" + ");
      const file = bundleFile ? { base64: await fileToBase64(bundleFile), originalName: bundleFile.name } : null;
      const result =
        bundleModal.direction === "sales"
          ? await registerBundledSale({
              ntsSendKeys: bundleRows.map((r) => r.ntsSendKey),
              blNo: allocations[0].blNo,
              amount: allocations[0].amount,
              counterpartName: bundleRows[0].counterpartCorpName,
              counterpartCorpNum: bundleRows[0].counterpartCorpNum,
              writeDate: earliest,
              note,
              file,
            })
          : await registerBundledPurchase({
              ntsSendKeys: bundleRows.map((r) => r.ntsSendKey),
              registerAs: bundleModal.registerAs,
              customsPartyId: bundleModal.customsPartyId,
              allocations,
              counterpartName: bundleRows[0].counterpartCorpName,
              counterpartCorpNum: bundleRows[0].counterpartCorpNum,
              writeDate: earliest,
              note,
              file,
            });
      if (!result.ok) {
        setBundleError(result.message);
        return;
      }
      setAttachments((prev) => ({ ...prev, ...result.statuses }));
      setSelectedKeys(new Set());
      setBundleFile(null);
      setBundleModal(null);
    } catch {
      setBundleError("등록 중 오류가 발생했습니다.");
    } finally {
      setBundlePending(false);
    }
  }

  // 탭을 열자마자 조회조건(URL에서 복원된 값 또는 기본값=이번 달) 기준으로 바로 조회한다 —
  // 다른 목록 화면들처럼 별도 클릭 없이 바로 보이게. eslint 의존성 경고는 무시: 마운트 시
  // 1회만 실행하면 된다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    runSearch();
  }, []);

  // 조회조건이 바뀌면 URL에 반영한다(replace라서 뒤로가기 히스토리를 더럽히지 않고,
  // scroll:false라서 화면이 위로 튀지 않는다). 사이드바가 이 URL을 탭별로 기억해두므로
  // 다른 탭에 갔다 돌아오면 같은 조건이 그대로 복원된다.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set("direction", direction);
    params.set("month", month);
    if (taxType !== 1) params.set("taxType", String(taxType));
    if (dateType !== 1) params.set("dateType", String(dateType));
    const qs = params.toString();
    // 이미 같은 주소면 아무것도 하지 않는다 — 마운트 직후(URL에서 복원된 경우)의 불필요한
    // replace를 막는다.
    if (window.location.search.replace(/^\?/, "") === qs) return;
    router.replace(`${pathname}?${qs}`, { scroll: false });
  }, [direction, month, taxType, dateType, pathname, router]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch();
  }

  async function handlePrintUrl(ntsSendKey: string, counterpartCorpNum: string) {
    setPrintError(null);
    setPrintPending(ntsSendKey);
    const result = await getPrintUrl(ntsSendKey, counterpartCorpNum);
    setPrintPending(null);
    if (!result.ok) {
      setPrintError(result.message);
      return;
    }
    // 반환된 URL은 60초만 유효하므로 받자마자 바로 연다. 새 탭이 아니라 작은 팝업창으로 띄워서
    // 조회 중인 목록 화면과 겹쳐 보이지 않게 한다 — 같은 이름의 창을 재사용해 계속 눌러도
    // 팝업이 쌓이지 않는다.
    const w = 880;
    const h = 1000;
    const left = Math.max(0, Math.round((window.screen.width - w) / 2));
    const top = Math.max(0, Math.round((window.screen.height - h) / 2));
    window.open(
      result.url,
      "taxInvoicePrintPopup",
      `noopener,noreferrer,width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,scrollbars=yes,resizable=yes`
    );
  }

  // 같은 B/L로 묶여 등록된 세금계산서들은(매출·매입 둘 다) 목록에서 대표(합산) 1행으로
  // 보여준다 — 실제 개별 행은 "펼치기"를 눌러야 나타난다. attachments가 비동기로 뒤늦게
  // 채워지므로 매번 다시 계산한다(메모이제이션 없이도 이 앱 규모에서는 비용이 무시할 만하다).
  type DisplayItem =
    | { kind: "single"; row: TaxInvoiceRow }
    | { kind: "group"; blNo: string; rows: TaxInvoiceRow[] };

  function handleSort(key: SortKey) {
    setSort((prev) => toggleSort(prev, key));
  }

  function taxSortValue(r: TaxInvoiceRow, key: SortKey): SortValue {
    const att = attachments[r.ntsSendKey];
    switch (key) {
      case "number":
        return numbers[r.ntsSendKey];
      case "partyCode":
        return partyCodes[bizNoDigits(r.counterpartCorpNum)];
      case "invoiceFileName":
        return att?.fileName;
      case "voucherKind":
        return att?.matched ? voucherKindLabel(att.matchedKind) : null;
      case "approvedAt":
        return att?.approvedAt;
      case "writeDate":
      case "counterpartCorpName":
      case "counterpartCorpNum":
      case "itemName":
      case "ntsSendKey":
        return r[key];
      case "amountTotal":
      case "taxTotal":
      case "totalAmount":
        return r[key];
    }
  }

  function buildDisplayItems(): DisplayItem[] {
    if (!rows) return [];
    const sortedRows = sortRowsBy(rows, sort, taxSortValue);

    const groupsByBlNo = new Map<string, TaxInvoiceRow[]>();
    for (const r of sortedRows) {
      const att = attachments[r.ntsSendKey];
      if (att?.matched && att.bundledCount > 0 && att.blNo) {
        const arr = groupsByBlNo.get(att.blNo) ?? [];
        arr.push(r);
        groupsByBlNo.set(att.blNo, arr);
      }
    }

    const consumed = new Set<string>();
    const items: DisplayItem[] = [];
    for (const r of sortedRows) {
      if (consumed.has(r.ntsSendKey)) continue;
      const att = attachments[r.ntsSendKey];
      // groupsByBlNo를 만들 때 쓴 조건(bundledCount > 0)과 반드시 똑같아야 한다 — 이 행 자신은
      // 묶음이 아닌데(bundledCount === 0) B/L 텍스트만 우연히 같은 묶음과 겹치면, 이미 push된
      // 그룹을 "자기 것"인 것처럼 또 한 번 push해서 같은 blNo 키를 가진 항목이 두 개 생긴다
      // (React key 중복 경고 "group-DSC084969" 두 번 — 실제로 재현됨).
      const group = att?.matched && att.bundledCount > 0 && att.blNo ? groupsByBlNo.get(att.blNo) : undefined;
      if (group && group.length > 1) {
        group.forEach((gr) => consumed.add(gr.ntsSendKey));
        items.push({ kind: "group", blNo: att!.blNo!, rows: group });
      } else {
        consumed.add(r.ntsSendKey);
        items.push({ kind: "single", row: r });
      }
    }
    return items;
  }

  function toggleGroupExpanded(blNo: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(blNo)) next.delete(blNo);
      else next.add(blNo);
      return next;
    });
  }

  // 첨부한 인보이스 PDF의 검증 상태 — "인보이스" 칸에 배지로 보여주고, 확정 전에 경고
  // 근거로도 쓴다. pdfExtracts는 이번 세션에 첨부/재확인한 것만 담기므로(새로고침하면
  // 비어있다) 정보가 없으면 null을 돌려주고 아무것도 표시하지 않는다 — 확정을 막지 않는다.
  function invoiceValidation(
    ntsSendKey: string,
    amountTotal: number
  ): { tone: "pos" | "neg" | "muted"; label: string; detail: string } | null {
    const extract = pdfExtracts[ntsSendKey];
    if (!extract) return null;
    if (extract.status === "error") {
      return { tone: "neg", label: "⚠ 미인식", detail: extract.message };
    }
    if (extract.lines.length !== 1) {
      return {
        tone: "muted",
        label: `B/L ${extract.lines.length}건 인식`,
        detail: extract.lines.map((l) => `${l.blNo} (${formatAmount(l.amount)})`).join(", "),
      };
    }
    const mismatch = amountMismatchWarning(extract.lines, amountTotal);
    if (mismatch) return { tone: "neg", label: "⚠ 금액 불일치", detail: mismatch };
    return {
      tone: "pos",
      label: "검증됨",
      detail: `${extract.lines[0].blNo} · ${formatAmount(extract.lines[0].amount)} — 세금계산서 공급가액과 일치합니다.`,
    };
  }

  // 확정 직전에 검증 실패가 확인된 상태면 한 번 더 물어본다 — 자동 인식이 틀릴 수도 있어
  // 완전히 막지는 않고, 사용자가 알고 넘어가게만 한다.
  function confirmDespiteValidation(r: TaxInvoiceRow): boolean {
    const validation = invoiceValidation(r.ntsSendKey, r.amountTotal);
    if (!validation || validation.tone !== "neg") return true;
    return window.confirm(
      `첨부한 인보이스 검증에서 문제가 발견됐습니다:\n\n${validation.detail}\n\n그래도 승인하고 전표에 등록할까요?`
    );
  }

  // 관세전표로 등록할 때만 뜨는 거래처 선택칸. **거래처 마스터에 이미 있는 거래처만** 고를 수
  // 있다(PartySearchSelect 주석 참고) — 여기서 새로 만들 수 있게 하면 오타로 거래처가 늘어나
  // 손익 집계가 거래처별로 쪼개진다. 일반전표(매입)로 등록할 때는 세금계산서 공급자가 그대로
  // 거래처가 되므로 이 칸이 뜨지 않는다.
  function renderCustomsPartyField(
    partyId: string | null,
    onPick: (id: string | null) => void
  ) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">
          거래처 (선택) — 코드 또는 거래처명으로 검색. 거래처 화면에 등록된 곳만 고를 수 있습니다.
        </span>
        <PartySearchSelect parties={parties} value={partyId} onChange={onPick} />
      </div>
    );
  }

  // 세금계산서에 없는 금액("미발행") 줄. 인보이스 금액을 임의로 안분하지 않는 대신, 세금계산서
  // 합계금액과 맞지 않는 차액을 여기에 명칭과 함께 적어 전표 배분 줄로 그대로 보낸다.
  // 기준을 공급가액이 아니라 **합계금액**으로 잡는 이유: 인보이스 금액에는 부가세가 섞여 있어서
  // 공급가액과 비교하면 부가세만큼이 늘 차액으로 잡힌다("부가세는 상관없다").
  function renderUnissuedRow(
    u: UnissuedRow,
    blSum: number,
    targets: number[],
    onChange: (patch: Partial<UnissuedRow>) => void
  ) {
    const diff = nearestRemaining(blSum + numOf(u.amountDisplay), targets);
    return (
      <div className="flex flex-col gap-1.5 rounded-md bg-gray-95 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-fg">세금계산서 미발행분 (선택)</span>
          {/* 남은 차액을 그대로 채워주는 버튼 — 자동으로 넣지 않는 이유는 "임의 안분"과 같다.
              사용자가 확인하고 넣어야 한다. */}
          {diff !== 0 && (
            <button
              type="button"
              onClick={() => onChange({ amountDisplay: commaInput(String(numOf(u.amountDisplay) + diff)) })}
              className="text-xs text-accent hover:underline"
            >
              남은 차액 {diff.toLocaleString("ko-KR")} 채우기
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={u.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          >
            {UNISSUED_LABELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          {u.label === "기타" && (
            <input
              value={u.custom}
              onChange={(e) => onChange({ custom: e.target.value })}
              placeholder="명칭 직접 입력"
              className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
            />
          )}
          <input
            value={u.blNo}
            onChange={(e) => onChange({ blNo: e.target.value })}
            placeholder="B/L (비워두면 미배분)"
            className="w-40 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          />
          <input
            value={u.amountDisplay}
            onChange={(e) => onChange({ amountDisplay: commaInput(e.target.value) })}
            inputMode="decimal"
            placeholder="금액"
            className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-right text-sm text-fg num"
          />
        </div>
        <span className="text-xs text-muted">
          B/L을 비워두면 특정 B/L에 속하지 않는 줄로 들어가 B/L별 손익에 섞이지 않습니다.
        </span>
      </div>
    );
  }

  // "{B/L} 외 N건" 클릭 → 등록내역 팝업. 목록 칸에는 대표 B/L 하나만 보이는데 매입 한 건은
  // 여러 B/L에 배분될 수 있어서, 어느 B/L에 얼마씩 들어갔는지를 여기서 확인한다.
  async function openDetailModal(r: TaxInvoiceRow, attachment: AttachmentStatus) {
    setDetailModal({
      title: `${attachment.blNo ?? ""}${attachment.blCount > 1 ? ` 외 ${attachment.blCount - 1}건` : ""}`,
      detail: null,
      loading: true,
      error: null,
    });
    const res = await getRegistrationDetail({
      ntsSendKey: r.ntsSendKey,
      direction,
      counterpartCorpNum: r.counterpartCorpNum,
    });
    setDetailModal((prev) =>
      prev
        ? res.ok
          ? { ...prev, detail: res.detail, loading: false }
          : { ...prev, loading: false, error: res.message }
        : prev
    );
  }

  // 등록된 행의 B/L 표시 — 여러 B/L에 걸쳐 있으면 "외 N건"을 붙이고, 누르면 상세 팝업이 뜬다.
  function renderBlNoButton(r: TaxInvoiceRow, attachment: AttachmentStatus) {
    const extra = attachment.blCount > 1 ? ` 외 ${attachment.blCount - 1}건` : "";
    return (
      <button
        type="button"
        onClick={() => openDetailModal(r, attachment)}
        title="등록 내역 보기 (B/L별 배분·묶인 세금계산서)"
        className="num text-xs text-accent hover:underline"
      >
        {attachment.blNo}
        {extra}
      </button>
    );
  }

  // "인보이스" 칸 — 첨부된 PDF 자체를 보여준다(파일명 클릭 시 새 탭에서 열림) + 검증 배지.
  function renderInvoiceCell(r: TaxInvoiceRow, attachment: AttachmentStatus | undefined) {
    const validation = attachment?.fileName ? invoiceValidation(r.ntsSendKey, r.amountTotal) : null;
    return (
      <td className="py-2 pr-3 align-top">
        {attachment?.fileName ? (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <button
              type="button"
              onClick={() => setPdfPreview({ ntsSendKey: r.ntsSendKey, fileName: attachment.fileName })}
              title={attachment.fileName}
              className="inline-block max-w-[130px] truncate align-bottom text-xs text-accent hover:underline"
            >
              {attachment.fileName}
            </button>
            {validation && (
              <span
                title={validation.detail}
                className={`text-xs ${validation.tone === "pos" ? "text-pos" : validation.tone === "neg" ? "text-neg" : "text-muted"}`}
              >
                {validation.label}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </td>
    );
  }

  // 개별 행 렌더링 — 단독으로도, 묶음을 펼쳤을 때 구성원으로도 그대로 재사용한다.
  function renderDataRow(r: TaxInvoiceRow, opts?: { inGroup?: boolean; isLastInGroup?: boolean }) {
    const inGroup = opts?.inGroup ?? false;
    // 묶음의 마지막 구성원 행에는 굵은 밑줄을 줘서 "여기까지가 이 묶음"이라는 경계가 눈에
    // 바로 들어오게 한다 — 다른 행들과 같은 옅은 선이면 묶음이 어디서 끝나는지 훑어보기
    // 어렵다는 피드백(2026-08-27).
    const isLastInGroup = opts?.isLastInGroup ?? false;
    const attachment = attachments[r.ntsSendKey];
    const isAttachPending = attachPending.has(r.ntsSendKey);
    const isSelected = selectedKeys.has(r.ntsSendKey);
    // 승인(전표 등록)이 끝난 행은 매출·매입 구분 없이 초록 음영으로 표시한다.
    const isApproved = Boolean(attachment?.approvedAt);
    // 단, 묶음 구성원 행(inGroup)에는 초록 배경을 주지 않는다 — "확정" 칸의 날짜 표시 자체는
    // 그대로 두고(isApproved는 그 용도로 계속 씀) 행 배경색만 뺀다. 확정 여부는 이미 대표행이
    // 초록으로 보여주고 있어서, 펼쳤을 때 구성원 행까지 전부 초록이면 화면이 무거워지고 "몇
    // 건이 묶였는지" 읽기도 더 어려워진다는 피드백(2026-08-27)에 따름.
    const showApprovedTint = isApproved && !inGroup;
    // 묶음 표시는 "N건 묶음" 뱃지(대표행)와 ↳ + "묶음 소속"(구성원행)만으로 충분하다 — 첫 열을
    // 색으로 채우는 시도는 실제 데이터에서 묶음 비중이 높은 달(예: 27건 중 21건)에는 표 전체가
    // 파랗게 뒤덮여 오히려 구분이 안 되는 역효과가 나서 제거함(2026-08-27, 실사용 데이터로 확인
    // 후 되돌림).
    return (
      <tr
        key={r.ntsSendKey}
        className={`${isLastInGroup ? "border-b-2 border-accent/50" : "border-b border-border/60"} ${isSelected ? "bg-accent/10" : ""} ${showApprovedTint ? "bg-pos/10" : ""}`}
      >
        {/* 체크박스 전용 칸. 이미 등록된 행에는 체크박스를 아예 두지 않는다 — 다시 체크해서 새
            묶음에 넣으면 같은 세금계산서가 두 번 등록되는 사고로 이어진다. 묶음 구성원 행은
            체크박스 대신 소속 표시(↳)만 보여준다. */}
        <td className="w-8 py-2 pr-2 whitespace-nowrap">
          {inGroup ? (
            <IconTreeConnector className="ml-2 h-4 w-4 text-accent" />
          ) : attachment?.matched ? null : (
            <input
              type="checkbox"
              checked={selectedKeys.has(r.ntsSendKey)}
              onChange={() => toggleSelected(r.ntsSendKey)}
            />
          )}
        </td>
        {/* 전표종류 — 등록된 건에만 값이 있다. 관세전표는 일반전표(초록)와 헷갈리지 않도록
            노란 계열(text-warn)로 구별한다. 연결된 전표의 거래처·날짜(matchedLabel)는 title로만
            붙인다. */}
        <td className="py-2 pr-3 align-top whitespace-nowrap">
          {attachment?.matched ? (
            <span
              className={`text-xs ${attachment.matchedKind === "customs" ? "text-warn" : "text-pos"}`}
              title={attachment.matchedLabel ?? undefined}
            >
              {voucherKindLabel(attachment.matchedKind)}
            </span>
          ) : (
            <span className="text-xs text-muted">-</span>
          )}
        </td>
        <td className="py-2 pr-3 whitespace-nowrap num text-muted">{numbers[r.ntsSendKey] ?? "-"}</td>
        <td className="py-2 pr-3 whitespace-nowrap text-muted">{formatYmd(r.writeDate)}</td>
        <td className="py-2 pr-3 whitespace-nowrap num text-muted">
          {partyCodes[bizNoDigits(r.counterpartCorpNum)] ?? "-"}
        </td>
        <td className="py-2 pr-3 text-fg">{r.counterpartCorpName}</td>
        <td className="py-2 pr-3 whitespace-nowrap num text-muted">{formatBizNo(r.counterpartCorpNum)}</td>
        <td className="max-w-[160px] truncate py-2 pr-3 text-muted" title={r.counterpartEmail || undefined}>
          {r.counterpartEmail || "-"}
        </td>
        <td className="py-2 pr-3 text-right num text-fg">{formatAmount(r.amountTotal)}</td>
        <td className="py-2 pr-3 text-right num text-muted">{formatAmount(r.taxTotal)}</td>
        <td className="py-2 pr-3 text-right num font-medium text-fg">{formatAmount(r.totalAmount)}</td>
        <td className="py-2 pr-3 text-muted">{r.itemName}</td>
        <td className="max-w-[90px] truncate py-2 pr-3 text-muted" title={r.ntsSendKey}>
          {r.ntsSendKey}
        </td>
        <td className="py-2 pr-3 whitespace-nowrap">
          <button
            type="button"
            disabled={printPending === r.ntsSendKey}
            onClick={() => handlePrintUrl(r.ntsSendKey, r.counterpartCorpNum)}
            className="text-xs text-accent hover:underline disabled:opacity-50"
          >
            {printPending === r.ntsSendKey ? "여는 중..." : "보기"}
          </button>
        </td>
        {renderInvoiceCell(r, attachment)}
        <td className="py-2 pr-3 align-top">
          {isAttachPending ? (
            <span className="text-xs text-muted">처리 중...</span>
          ) : attachment?.matched ? (
            <div className="flex items-center gap-2 whitespace-nowrap">
              {renderBlNoButton(r, attachment)}
              {/* 연결된 전표의 거래처·날짜(matchedLabel)는 title로만 보여준다 — 거래처명은 이미
                  왼쪽 "공급자" 열에 있고, 이 칸이 길어지면 오른쪽 "확정" 열이 화면 밖으로 밀린다. */}
              {/* 묶인 세금계산서 건수("외 N건")는 여기 붙이지 않는다 — 바로 왼쪽 B/L 버튼에 이미
                  "외 N건"(B/L 수)이 붙어서, 두 개가 나란히 있으면 무엇의 N건인지 헷갈린다.
                  묶인 세금계산서 목록은 B/L 버튼을 눌러 팝업에서 확인한다. */}
              {/* 확정된 건에는 첨부 수단을 아무것도 두지 않는다(안내 문구조차 없이 빈 칸) —
                  인보이스 교체는 "확정" 칸의 "수정"으로만 한다. 여기서 바로 바꿀 수 있으면 사유도
                  이력도 없이 첨부파일이 갈리기 때문이다(수정 흐름은 사유 필수 +
                  TaxInvoiceEditHistory 기록). 아직 확정되지 않은 상태(전표는 있는데 승인기록이
                  없는 경우 — markVouchersWithoutAttachment 참고)에는 "수정" 버튼이 없으므로
                  첨부 수단을 남겨둔다. */}
              {inGroup ? (
                <span className="text-xs text-muted" title="묶음 전체는 대표행에서만 바꿀 수 있습니다.">
                  묶음 소속
                </span>
              ) : isApproved ? null : (
                <label className="cursor-pointer text-xs text-muted hover:underline">
                  {attachment.fileName ? "다시 첨부" : "첨부"}
                  <input
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) handleAttachFile(r, direction, file);
                    }}
                  />
                </label>
              )}
            </div>
          ) : (
            // B/L 번호도, 인보이스 첨부도 전부 "등록" 팝업 안에서 한다 — 표 안에 별도 "첨부"
            // 링크를 남겨두면 등록 팝업의 첨부 칸과 똑같은 일을 하는 버튼이 두 개가 돼서
            // 헷갈린다는 피드백(2026-08-27)에 따라 "등록" 하나로 합침.
            <div className="flex items-center gap-2 whitespace-nowrap">
              <button
                type="button"
                disabled={registeringKeys.has(r.ntsSendKey)}
                onClick={() => openConfirmModal(r, direction, blNoInputs[r.ntsSendKey] ?? attachment?.blNo ?? "")}
                className="text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
              >
                {registeringKeys.has(r.ntsSendKey) ? "등록 중..." : "등록"}
              </button>
            </div>
          )}
          {attachErrors[r.ntsSendKey] && <div className="mt-0.5 text-xs text-neg">{attachErrors[r.ntsSendKey]}</div>}
          {registerErrors[r.ntsSendKey] && (
            <div className="mt-0.5 text-xs text-neg">{registerErrors[r.ntsSendKey]}</div>
          )}
        </td>
        {/* "확정" 칸 — 등록(승인)이 곧 확정이므로 별도 확정 버튼은 없고, 확정 여부와 확정 시각을
            눈으로 확인하는 칸이다. "수정"도 여기 둔다(등록/첨부 칸이 이미 빽빽해서). 묶음 구성원
            행(inGroup)에는 수정 버튼을 두지 않는다 — 대표행에서만 고쳐야 묶음 전체의 B/L을 한 번에
            갱신할 수 있다(개별 행만 갱신하면 구성원끼리 B/L이 어긋나 묶음 표시가 깨진다). */}
        <td className="py-2 pr-3 align-top">
          {isApproved && attachment?.approvedAt ? (
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-xs text-pos" title={formatApprovedFull(attachment.approvedAt)}>
                확정 {formatApprovedShort(attachment.approvedAt)}
              </span>
              {!inGroup && (
                <button
                  type="button"
                  onClick={() =>
                    setEditChoice({
                      ntsSendKeys: [r.ntsSendKey],
                      counterpartCorpNum: r.counterpartCorpNum,
                      attachment,
                      blNo: attachment.blNo ?? "",
                      isGroup: false,
                    })
                  }
                  className="text-xs text-accent hover:underline"
                >
                  수정
                </button>
              )}
            </div>
          ) : (
            <span className="text-xs text-muted">—</span>
          )}
        </td>
      </tr>
    );
  }

  // 묶음 대표행 — 구성원들의 금액을 합산해서 세금계산서 1건처럼 보여준다.
  function renderGroupRow(blNo: string, groupRows: TaxInvoiceRow[]) {
    const first = groupRows[0];
    const attachment = attachments[first.ntsSendKey];
    const isExpanded = expandedGroups.has(blNo);
    const isReattachPending = groupRows.some((r) => attachPending.has(r.ntsSendKey));
    const sum = groupRows.reduce(
      (acc, r) => ({
        amountTotal: acc.amountTotal + r.amountTotal,
        taxTotal: acc.taxTotal + r.taxTotal,
        totalAmount: acc.totalAmount + r.totalAmount,
      }),
      { amountTotal: 0, taxTotal: 0, totalAmount: 0 }
    );
    const itemNames = [...new Set(groupRows.map((r) => r.itemName))].join(" + ");
    const earliestDate = groupRows.reduce((min, r) => (r.writeDate < min ? r.writeDate : min), first.writeDate);
    // 묶음 대표행도 승인되면 초록 음영(매출·매입 공통).
    const isApproved = Boolean(attachment?.approvedAt);

    return (
      // 묶음은 대표행 + (펼쳤을 때) 구성원 행들 = 여러 <tr>을 한 논리행으로 낸다. 이때 key는
      // 배열에 들어가는 최상위 노드(Fragment)에 있어야 한다 — 안쪽 <tr>에만 달면 React가
      // key 경고를 낸다.
      <Fragment key={`group-${blNo}`}>
        <tr className={`border-b border-border/60 bg-gray-95/60 ${isApproved ? "bg-pos/10" : ""}`}>
          {/* 대표행은 이미 등록된 상태라 체크박스가 없다(위 renderDataRow 주석 참고) — 칸만 비운다. */}
          <td className="w-8 py-2 pr-2" />
          {/* 전표종류 — 묶음도 전표 1건으로 등록되므로 종류는 하나다(대표행에만 값이 있다). 관세전표는
              일반전표(초록)와 헷갈리지 않도록 노란 계열(text-warn)로 구별한다. */}
          <td className="py-2 pr-3 align-top whitespace-nowrap">
            {attachment?.matched ? (
              <span
                className={`text-xs ${attachment.matchedKind === "customs" ? "text-warn" : "text-pos"}`}
                title={attachment.matchedLabel ?? undefined}
              >
                {voucherKindLabel(attachment.matchedKind)}
              </span>
            ) : (
              <span className="text-xs text-muted">-</span>
            )}
          </td>
          {/* 묶음 대표행의 번호는 구성원들의 번호를 모두 보여준다(예: "O00003, O00004") —
              합산 1행이라 대표 하나만 보이면 어느 세금계산서들이 묶였는지 알 수 없다. */}
          <td className="py-2 pr-3 whitespace-nowrap num text-muted">
            {groupRows
              .map((r) => numbers[r.ntsSendKey])
              .filter(Boolean)
              .join(", ") || "-"}
          </td>
          <td className="py-2 pr-3 whitespace-nowrap text-muted">{formatYmd(earliestDate)}</td>
          <td className="py-2 pr-3 whitespace-nowrap num text-muted">
            {partyCodes[bizNoDigits(first.counterpartCorpNum)] ?? "-"}
          </td>
          <td className="py-2 pr-3 text-fg">{first.counterpartCorpName}</td>
          <td className="py-2 pr-3 whitespace-nowrap num text-muted">
            {formatBizNo(first.counterpartCorpNum)}
          </td>
          <td className="max-w-[160px] truncate py-2 pr-3 text-muted" title={first.counterpartEmail || undefined}>
            {first.counterpartEmail || "-"}
          </td>
          <td className="py-2 pr-3 text-right num text-fg">{formatAmount(sum.amountTotal)}</td>
          <td className="py-2 pr-3 text-right num text-muted">{formatAmount(sum.taxTotal)}</td>
          <td className="py-2 pr-3 text-right num font-medium text-fg">{formatAmount(sum.totalAmount)}</td>
          <td className="py-2 pr-3 text-muted">{itemNames}</td>
          {/* 묶음 뱃지 자체가 펼치기/접기 버튼이다 — 왼쪽의 작은 +/− 원이 상태를 보여주고,
              뱃지 전체가 클릭 영역이라 굳이 "펼치기"라는 글자를 따로 안 읽어도 된다.
              "묶음 풀기"는 여기 두지 않는다 — 실수로 누르면 등록이 지워지는 되돌릴 수 없는
              동작이라, 수정 사유를 남기는 "수정" 팝업 안으로만 옮겼다(아래 editModal 참고). */}
          <td className="py-2 pr-3">
            {/* 묶음 배지는 접혀 있을 때가 기본 상태라, 그때도 눈에 확 띄어야 "여러 줄이 안 보이게
                접혀 있다"는 걸 놓치지 않는다 — 회색 톤 대신 항상 강조색을 쓴다(2026-08-27). */}
            <button
              type="button"
              onClick={() => toggleGroupExpanded(blNo)}
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
              {groupRows.length}건 묶음
            </button>
          </td>
          <td className="py-2 pr-3" />
          {renderInvoiceCell(first, attachment)}
          <td className="py-2 pr-3 align-top">
            <div className="flex items-center gap-2 whitespace-nowrap">
              {attachment ? (
                renderBlNoButton(first, attachment)
              ) : (
                <span className="num text-xs text-fg">{blNo}</span>
              )}
              {/* 단건과 같은 이유로, 확정된 묶음의 인보이스 교체도 "확정" 칸의 "수정"으로만 한다
                  (editApprovedTaxInvoice가 구성원 전체의 파일명을 한 번에 갱신하고 이력도
                  구성원별로 남긴다). "다시 첨부"는 아직 확정되지 않은 묶음에만 남겨둔다. */}
              {isReattachPending ? (
                <span className="text-xs text-muted">처리 중...</span>
              ) : isApproved ? null : (
                <label className="cursor-pointer text-xs text-muted hover:underline">
                  다시 첨부
                  <input
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) handleReattachGroup(groupRows, file);
                    }}
                  />
                </label>
              )}
            </div>
            {attachErrors[first.ntsSendKey] && (
              <div className="mt-0.5 text-xs text-neg">{attachErrors[first.ntsSendKey]}</div>
            )}
          </td>
          {/* 묶음의 "확정"·"수정"은 항상 대표행에만 둔다 — 수정은 구성원 승인번호 전부를 한 번에
              고친다(`editApprovedTaxInvoice`가 배열을 받는 이유). */}
          <td className="py-2 pr-3 align-top">
            {isApproved && attachment?.approvedAt ? (
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span className="text-xs text-pos" title={formatApprovedFull(attachment.approvedAt)}>
                  확정 {formatApprovedShort(attachment.approvedAt)}
                </span>
                {/* "수정"을 누르면 묶음풀기/B/L변경/금액조정 세 선택지가 있는 작은 팝업이
                    뜬다(2026-08-27) — 행에 셋을 다 늘어놓으면 복잡하다는 피드백에 따름. */}
                {isReattachPending ? (
                  <span className="text-xs text-muted">처리 중...</span>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setEditChoice({
                        ntsSendKeys: groupRows.map((r) => r.ntsSendKey),
                        counterpartCorpNum: first.counterpartCorpNum,
                        attachment,
                        blNo,
                        isGroup: true,
                      })
                    }
                    className="text-xs text-accent hover:underline"
                  >
                    수정
                  </button>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
          </td>
        </tr>
        {isExpanded &&
          groupRows.map((r, idx) =>
            renderDataRow(r, { inGroup: true, isLastInGroup: idx === groupRows.length - 1 })
          )}
        {/* 묶음과 묶음(또는 묶음과 다음 건) 사이를 살짝 띄워서 어디까지가 한 묶음인지 더 잘
            보이게 한다 — 표라 margin을 못 쓰니 테두리 없는 빈 행으로 높이만 흉내낸다. 접혀
            있을 때도(대표행 한 줄만 보일 때도) 다음 건과는 살짝 떨어져 보이도록 항상 넣는다. */}
        <tr aria-hidden="true">
          <td colSpan={17} className="h-2" />
        </tr>
      </Fragment>
    );
  }

  // 체크한 행들의 공급가액 합계 — 묶음 등록의 기준 금액이라 버튼에 미리 표시한다.
  const selectedSupplyTotal = (rows ?? [])
    .filter((r) => selectedKeys.has(r.ntsSendKey))
    .reduce((sum, r) => sum + r.amountTotal, 0);

  // B/L 입력창 자동완성 후보 — 지금 화면에 이미 붙어 있는(등록됐거나 확정 첨부의) B/L
  // 번호들이다. 서버를 다시 안 불러오고 이미 받아둔 attachments에서만 뽑아서, 입력하는
  // 순간 바로 후보가 뜨게 한다(전체 DB가 아니라 "지금 조회 중인 목록에 보이는 B/L"로 범위를
  // 좁힌 것 — 실제로 같은 배치의 다른 세금계산서와 B/L이 겹치는 경우가 많아 이걸로 충분하다).
  const blNoCandidates = Array.from(
    new Set(Object.values(attachments).map((a) => a.blNo).filter((v): v is string => Boolean(v)))
  ).sort();

  return (
    <div className="flex flex-col gap-4">
      <datalist id="bl-no-candidates">
        {blNoCandidates.map((bl) => (
          <option key={bl} value={bl} />
        ))}
      </datalist>
      {/* 제목과 업데이트 시각은 한 덩어리로 붙여서 보여준다 — page.tsx의 h1과 분리돼 있으면
          바깥 flex 컨테이너의 큰 간격(gap-6)이 둘 사이에도 그대로 적용돼 버려서 여기로 옮김. */}
      <div>
        <h1 className="text-lg font-semibold text-fg">세금계산서</h1>
        {lastUpdatedAt && (
          <div className="mt-1 text-xs text-muted">
            세금계산서 업데이트{" "}
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
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">구분</label>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as TaxInvoiceDirection)}
            className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          >
            <option value="sales">매출</option>
            <option value="purchase">매입</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">조회년월</label>
          <input
            type="month"
            required
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">기준일자</label>
          <select
            value={dateType}
            onChange={(e) => setDateType(Number(e.target.value))}
            className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          >
            <option value={1}>작성일자</option>
            <option value={2}>발급일자</option>
            <option value={3}>전송일자</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">과세유형</label>
          <select
            value={taxType}
            onChange={(e) => setTaxType(Number(e.target.value))}
            className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
          >
            <option value={1}>과세+영세</option>
            <option value={3}>면세</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? "조회 중..." : "조회"}
        </button>

        {/* 홈택스 엑셀 업로드 — 자주 쓰는 기능이 아니라 큰 카드로 자리를 차지하던 것을 조회
            줄 오른쪽 끝의 작은 버튼으로 옮겼다(ml-auto). **관리자만** 보인다: 업로드한 내용은
            DB에 남아 이후 모든 조회 결과에 섞여 나오므로 사실상 원본 데이터를 추가하는
            행위다(서버 액션에서도 다시 막는다). */}
        {isAdmin && (
          <div className="ml-auto flex flex-col items-end gap-1">
            <label
              className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs text-fg hover:bg-gray-95"
              title={
                '바로빌에 아직 없는 기간은, 홈택스에서 받은 "전자(수정) 세금계산서 목록조회" ' +
                "다운로드 파일(.xls)을 올리면 그 내용을 여기 그대로 보여줍니다 — 매출/매입 구분은 " +
                "파일에서 자동 인식합니다. 업로드한 내용은 DB에 저장되어, 다음에 같은 구분/월로 " +
                '"조회"하면 바로빌 API 결과와 합쳐서 계속 나옵니다.'
              }
            >
              {uploadPending ? "업로드 중..." : "홈택스 엑셀 업로드"}
              <input
                type="file"
                accept=".xls,.xlsx"
                disabled={uploadPending}
                onChange={handleUpload}
                className="hidden"
              />
            </label>
            {uploadFileName && !uploadError && (
              <span className="max-w-[220px] truncate text-xs text-muted" title={uploadFileName}>
                {uploadFileName}
              </span>
            )}
            {uploadError && <span className="max-w-[260px] text-xs text-neg">{uploadError}</span>}
          </div>
        )}
      </form>

      {error && <div className="card p-4 text-sm text-neg">{error}</div>}

      {truncated && (
        <div className="text-xs text-neg">
          결과가 많아 최초 2,000건까지만 불러왔습니다. 기간을 좁혀서 다시 조회해주세요.
        </div>
      )}

      {rows && (
        <div className="card overflow-x-auto p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs text-muted">
              {source === "upload" ? (
                <span>
                  업로드한 파일 기준 ({uploadFileName}) — {rows.length}건
                </span>
              ) : (
                <span>{rows.length}건 조회됨</span>
              )}
              {printError && <span className="ml-2 text-neg">{printError}</span>}
            </div>
            <div className="flex items-center gap-2">
              {selectedKeys.size > 0 && (
                <button
                  type="button"
                  onClick={openBundleModal}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  {/* 묶음 등록의 기준 금액은 공급가액 합계이므로, 버튼에서 미리 보여준다 —
                      팝업을 열기 전에 "얼마로 묶이는지"를 바로 확인할 수 있게(매출·매입 공통). */}
                  선택한 {selectedKeys.size}건 묶어서 등록 (공급가액{" "}
                  {formatAmount(selectedSupplyTotal)}원)
                </button>
              )}
              <button
                type="button"
                disabled={rows.length === 0}
                onClick={() =>
                  downloadTaxInvoicesCsv(
                    rows,
                    direction,
                    source === "upload" ? "업로드" : month.replace("-", ""),
                    numbers,
                    partyCodes
                  )
                }
                className="rounded-md bg-gray-95 px-3 py-1.5 text-xs font-medium text-fg hover:bg-gray-90 disabled:opacity-50"
              >
                엑셀 다운로드
              </button>
            </div>
          </div>
          {bundleSelectError && <div className="mb-2 text-xs text-neg">{bundleSelectError}</div>}
          <table className="w-full min-w-[1140px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                {/* 묶음 선택용 체크박스 전용 열 — 예전엔 "작성일자" 칸 안에 체크박스를 끼워
                    넣었는데, 날짜를 읽을 때 눈에 걸려서 맨 왼쪽 독립 열로 뺐다. 헤더에 글자를
                    두지 않는 이유는 체크박스 열 관례를 따른 것이고, 전체선택은 두지 않았다 —
                    묶음은 같은 거래처끼리만 되므로 전체선택이 유용한 경우가 거의 없다. */}
                <th className="w-8 py-2 pr-2" />
                {/* 어느 전표로 등록됐는지 — 매입 세금계산서는 일반전표(매입)로도, 관세전표로도
                    등록될 수 있어서 등록 여부만으로는 어디를 봐야 하는지 알 수 없다. 체크박스
                    바로 옆(맨 왼쪽)에 둬서 훑어볼 때 가장 먼저 보이게 했다. */}
                <SortableTh label="전표종류" sortKey="voucherKind" state={sort} onSort={handleSort} />
                <SortableTh label="번호" sortKey="number" state={sort} onSort={handleSort} />
                <SortableTh label="작성일자" sortKey="writeDate" state={sort} onSort={handleSort} />
                <SortableTh label="코드" sortKey="partyCode" state={sort} onSort={handleSort} />
                <SortableTh
                  label={direction === "sales" ? "공급받는자" : "공급자"}
                  sortKey="counterpartCorpName"
                  state={sort}
                  onSort={handleSort}
                />
                <SortableTh label="사업자번호" sortKey="counterpartCorpNum" state={sort} onSort={handleSort} />
                {/* 바로빌 조회로 받은 건에만 있다(엑셀 업로드본·저장된 기록에는 없어 "-") — 정렬
                    대상에서 뺀 이유도 같다. */}
                <th className="py-2 pr-3">거래처 이메일</th>
                <SortableTh label="공급가액" sortKey="amountTotal" state={sort} onSort={handleSort} align="right" />
                <SortableTh label="세액" sortKey="taxTotal" state={sort} onSort={handleSort} align="right" />
                <SortableTh label="합계금액" sortKey="totalAmount" state={sort} onSort={handleSort} align="right" />
                <SortableTh label="품목" sortKey="itemName" state={sort} onSort={handleSort} />
                <SortableTh label="승인번호" sortKey="ntsSendKey" state={sort} onSort={handleSort} />
                {/* "세금계산서"(원문보기 버튼)와 "등록/첨부"(동작 버튼)는 데이터가 아니라 버튼 열이라
                    정렬 대상이 아니다. 인보이스는 파일명, 확정은 확정시각으로 정렬한다. */}
                <th className="py-2 pr-3">세금계산서</th>
                <SortableTh label="인보이스" sortKey="invoiceFileName" state={sort} onSort={handleSort} />
                <th className="py-2 pr-3">등록</th>
                <SortableTh label="확정" sortKey="approvedAt" state={sort} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {/* 헤더와 첫 줄 사이도 다른 줄 사이 간격과 똑같이 살짝 띄운다. */}
              <tr aria-hidden="true">
                <td colSpan={17} className="h-2" />
              </tr>
              {buildDisplayItems().map((item) =>
                item.kind === "single" ? (
                  // 묶음 사이에만 여백이 있으면 "묶음만 특별하다"는 인상을 줘서, 묶이지 않은
                  // 건들 사이에도 같은 빈 행으로 똑같이 살짝 띄워준다(renderGroupRow 끝의
                  // 여백행과 동일한 방식).
                  <Fragment key={item.row.ntsSendKey}>
                    {renderDataRow(item.row)}
                    <tr aria-hidden="true">
                      <td colSpan={17} className="h-2" />
                    </tr>
                  </Fragment>
                ) : (
                  renderGroupRow(item.blNo, item.rows)
                )
              )}
            </tbody>
          </table>

          {rows.length === 0 && source === "api" && (
            <div className="py-8 text-center text-sm text-muted">
              {month} 기간에는 국세청 전송완료된 세금계산서가 없습니다. 조회년월을 바꿔서
              다시 확인해보세요.
            </div>
          )}
        </div>
      )}

      {multiBlModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-lg flex-col gap-3 p-5">
            <div>
              <h3 className="text-sm font-semibold text-fg">
                여러 B/L로 나눠 배분 — {multiBlModal.row.counterpartCorpName}
              </h3>
              <p className="mt-1 text-xs text-muted">
                비고에 "외 {multiBlModal.rows.length - 1}건"이 있어 이 인보이스가 B/L{" "}
                {multiBlModal.rows.length}개를 커버하는 것으로 보입니다. 각 B/L과 배분금액을
                확인/수정하세요 — 합계는 공급가액({formatAmount(multiBlModal.row.amountTotal)})과
                같아야 합니다.
              </p>
            </div>

            <div className="flex items-center gap-3 text-sm">
              <span className="text-xs text-muted">등록 유형</span>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={multiBlModal.registerAs === "purchase"}
                  onChange={() => setMultiBlModal((prev) => (prev ? { ...prev, registerAs: "purchase" } : prev))}
                />
                일반전표(매입)
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={multiBlModal.registerAs === "customs"}
                  onChange={() => setMultiBlModal((prev) => (prev ? { ...prev, registerAs: "customs" } : prev))}
                />
                관세전표
              </label>
            </div>
            {multiBlModal.registerAs === "customs" &&
              renderCustomsPartyField(multiBlModal.customsPartyId, (id) =>
                setMultiBlModal((prev) => (prev ? { ...prev, customsPartyId: id } : prev))
              )}

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">
                인보이스 첨부 (선택 — 올리면 B/L별 내용을 자동으로 읽어와 아래 배분 행에 채워봅니다)
              </label>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => handleMultiBlFileChange(e.target.files?.[0] ?? null)}
                className="text-xs text-fg file:mr-2 file:rounded-md file:border-0 file:bg-gray-95 file:px-2 file:py-1 file:text-xs"
              />
              {multiBlFile && <span className="text-xs text-muted">{multiBlFile.name}</span>}
              {multiBlExtractLoading && <span className="text-xs text-muted">PDF 분석 중...</span>}
              {multiBlExtractInfo && (
                <span className="text-xs text-pos">
                  {multiBlExtractInfo.method === "offline" ? "오프라인 파싱" : "AI로 추출됨"}으로 B/L{" "}
                  {multiBlExtractInfo.lineCount}건을 인식해 아래에 채웠습니다
                  {multiBlExtractInfo.vatTotal > 0 &&
                    ` (문서의 부가세 ${formatAmount(multiBlExtractInfo.vatTotal)}원은 제외해 공급가액으로 읽었습니다)`}
                  . 등록 전에 반드시 확인/수정하세요.
                </span>
              )}
              {multiBlExtractError && <span className="text-xs text-neg">{multiBlExtractError}</span>}
            </div>

            <div className="flex flex-col gap-2">
              {multiBlModal.rows.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    value={row.blNo}
                    onChange={(e) => updateMultiBlRow(idx, { blNo: e.target.value })}
                    placeholder="B/L 번호"
                    list="bl-no-candidates"
                    className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
                  />
                  <input
                    value={row.amountDisplay}
                    onChange={(e) => updateMultiBlRow(idx, { amountDisplay: commaInput(e.target.value) })}
                    inputMode="decimal"
                    placeholder="배분금액"
                    className="w-32 rounded-md border border-border bg-surface px-2 py-1.5 text-right text-sm text-fg num"
                  />
                  {multiBlModal.rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeMultiBlRow(idx)}
                      className="text-xs text-neg hover:underline"
                    >
                      삭제
                    </button>
                  )}
                </div>
              ))}
              <div className="flex items-center justify-between">
                <button type="button" onClick={addMultiBlRow} className="text-xs text-accent hover:underline">
                  + B/L 추가
                </button>
                <div className="text-xs text-muted">
                  B/L 합계:{" "}
                  <span className="num">
                    {multiBlModal.rows.reduce((sum, r) => sum + numOf(r.amountDisplay), 0).toLocaleString("ko-KR")}
                  </span>
                  {" + 미발행 "}
                  <span className="num">{numOf(multiBlModal.unissued.amountDisplay).toLocaleString("ko-KR")}</span>
                  {" / 공급가액 "}
                  <span className="num">{multiBlModal.row.amountTotal.toLocaleString("ko-KR")}</span>
                  {multiBlModal.row.totalAmount !== multiBlModal.row.amountTotal && (
                    <>
                      {" 또는 합계금액 "}
                      <span className="num">{multiBlModal.row.totalAmount.toLocaleString("ko-KR")}</span>
                    </>
                  )}
                </div>
              </div>
              {renderUnissuedRow(
                multiBlModal.unissued,
                multiBlModal.rows.reduce((sum, r) => sum + numOf(r.amountDisplay), 0),
                allocationTargets(multiBlModal.row.amountTotal, multiBlModal.row.totalAmount),
                (patch) =>
                  setMultiBlModal((prev) => (prev ? { ...prev, unissued: { ...prev.unissued, ...patch } } : prev))
              )}
            </div>

            {multiBlError && <div className="text-sm text-neg">{multiBlError}</div>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setMultiBlModal(null);
                  setMultiBlFile(null);
                }}
                className="rounded-md px-4 py-1.5 text-sm text-muted hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                disabled={multiBlPending}
                onClick={handleRegisterMulti}
                className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {multiBlPending ? "등록 중..." : multiBlModal.registerAs === "customs" ? "관세 등록" : "매입 등록"}
              </button>
            </div>
          </div>
        </div>
      )}

      {bundleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-2xl flex-col gap-5 p-8">
            <div>
              <h3 className="text-xl font-semibold text-fg">
                여러 건 묶어서 {bundleModal.direction === "sales" ? "매출" : "매입"} 등록
              </h3>
            </div>

            {bundleModal.direction === "purchase" && (
              <div className="flex items-center gap-4 text-base">
                <span className="text-sm text-muted">등록 유형</span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={bundleModal.registerAs === "purchase"}
                    onChange={() => setBundleModal((prev) => (prev ? { ...prev, registerAs: "purchase" } : prev))}
                    className="h-4 w-4 accent-accent"
                  />
                  일반전표(매입)
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={bundleModal.registerAs === "customs"}
                    onChange={() => setBundleModal((prev) => (prev ? { ...prev, registerAs: "customs" } : prev))}
                    className="h-4 w-4 accent-accent"
                  />
                  관세전표
                </label>
              </div>
            )}
            {bundleModal.direction === "purchase" &&
              bundleModal.registerAs === "customs" &&
              renderCustomsPartyField(bundleModal.customsPartyId, (id) =>
                setBundleModal((prev) => (prev ? { ...prev, customsPartyId: id } : prev))
              )}

            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-muted">
                {bundleModal.direction === "purchase"
                  ? "인보이스 첨부 (선택, 묶음 전체에 공통으로 연결됨 — 올리면 B/L별 내용을 자동으로 읽어와 아래 배분 행에 채워줍니다)"
                  : "인보이스 첨부 (선택, 묶음 전체에 공통으로 연결됨)"}
              </label>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) =>
                  bundleModal.direction === "purchase"
                    ? handleBundleFileChange(e.target.files?.[0] ?? null)
                    : setBundleFile(e.target.files?.[0] ?? null)
                }
                className="text-sm text-fg file:mr-2 file:rounded-md file:border-0 file:bg-gray-95 file:px-3 file:py-1.5 file:text-sm"
              />
              {bundleFile && <span className="text-sm text-muted">{bundleFile.name}</span>}
              {bundleModal.direction === "purchase" && bundleExtractLoading && (
                <span className="text-sm text-muted">PDF 분석 중...</span>
              )}
              {bundleModal.direction === "purchase" && bundleExtractInfo && (
                <span className="text-sm text-pos">
                  {bundleExtractInfo.method === "offline" ? "오프라인 파싱" : "AI로 추출됨"}으로 B/L{" "}
                  {bundleExtractInfo.lineCount}건을 인식해 아래에 채웠습니다
                  {bundleExtractInfo.vatTotal > 0 &&
                    ` (문서의 부가세 ${formatAmount(bundleExtractInfo.vatTotal)}원은 제외해 공급가액으로 읽었습니다)`}
                  . 등록 전에 반드시 확인/수정하세요.
                </span>
              )}
              {bundleModal.direction === "purchase" && bundleExtractError && (
                <span className="text-sm text-neg">{bundleExtractError}</span>
              )}
            </div>

            <dl className="flex flex-col gap-2 text-base">
              <div className="flex justify-between">
                <dt className="text-muted">거래처</dt>
                <dd className="text-fg">{bundleModal.rows[0].counterpartCorpName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">작성일자</dt>
                <dd className="text-fg">{formatYmd(bundleModal.rows[0].writeDate)}</dd>
              </div>
              <div className="flex justify-between gap-6">
                <dt className="shrink-0 text-muted">대상 세금계산서</dt>
                <dd className="flex flex-col items-end gap-0.5 text-right text-fg">
                  {bundleModal.rows.map((r) => (
                    <span key={r.ntsSendKey}>
                      {r.itemName} <span className="num text-muted">{formatAmount(r.amountTotal)}</span>
                    </span>
                  ))}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">금액(공급가액) 합계</dt>
                <dd className="num font-medium text-fg">
                  {formatAmount(bundleModal.rows.reduce((sum, r) => sum + r.amountTotal, 0))}
                </dd>
              </div>
            </dl>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">B/L</span>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted">
                    {bundleModal.direction === "sales" ? "금액" : "B/L 합계"}{" "}
                    <span
                      className={`num ${
                        bundleModal.blRows.reduce((sum, r) => sum + numOf(r.amountDisplay), 0) +
                          (bundleModal.direction === "purchase" ? numOf(bundleModal.unissued.amountDisplay) : 0) ===
                        bundleModal.rows.reduce((sum, r) => sum + r.amountTotal, 0)
                          ? "text-pos"
                          : "text-neg"
                      }`}
                    >
                      {formatAmount(
                        bundleModal.blRows.reduce((sum, r) => sum + numOf(r.amountDisplay), 0) +
                          (bundleModal.direction === "purchase" ? numOf(bundleModal.unissued.amountDisplay) : 0)
                      )}
                    </span>{" "}
                    / {formatAmount(bundleModal.rows.reduce((sum, r) => sum + r.amountTotal, 0))}
                  </span>
                  {bundleModal.direction === "purchase" && (
                    <button
                      type="button"
                      onClick={addBundleBlRow}
                      className="flex items-center gap-1 text-sm text-accent hover:underline"
                    >
                      <IconPlus className="h-3.5 w-3.5" />
                      B/L 추가
                    </button>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {bundleModal.blRows.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      value={row.blNo}
                      onChange={(e) => updateBundleBlRow(idx, { blNo: e.target.value })}
                      placeholder="B/L 번호"
                      list="bl-no-candidates"
                      className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                    />
                    <input
                      value={row.amountDisplay}
                      onChange={(e) => updateBundleBlRow(idx, { amountDisplay: commaInput(e.target.value) })}
                      inputMode="decimal"
                      placeholder={bundleModal.direction === "sales" ? "금액" : "배분금액"}
                      className="num w-32 rounded-lg border border-border bg-surface px-3 py-2 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                    />
                    {bundleModal.direction === "purchase" && bundleModal.blRows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeBundleBlRow(idx)}
                        title="이 줄 삭제"
                        className="text-muted hover:text-neg"
                      >
                        <IconMinus className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {bundleModal.direction === "purchase" &&
                renderUnissuedRow(
                  bundleModal.unissued,
                  bundleModal.blRows.reduce((sum, r) => sum + numOf(r.amountDisplay), 0),
                  allocationTargets(
                    bundleModal.rows.reduce((sum, r) => sum + r.amountTotal, 0),
                    bundleModal.rows.reduce((sum, r) => sum + r.totalAmount, 0)
                  ),
                  (patch) =>
                    setBundleModal((prev) => (prev ? { ...prev, unissued: { ...prev.unissued, ...patch } } : prev))
                )}
            </div>

            {bundleError && <div className="text-base text-neg">{bundleError}</div>}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setBundleModal(null);
                  setBundleFile(null);
                }}
                className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                disabled={bundlePending}
                onClick={handleRegisterBundle}
                className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {bundlePending
                  ? "등록 중..."
                  : bundleModal.direction === "sales"
                    ? "매출 등록"
                    : bundleModal.registerAs === "customs"
                      ? "관세 등록"
                      : "매입 등록"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-2xl flex-col gap-5 p-8">
            <div>
              <h3 className="text-xl font-semibold text-fg">
                {confirmModal.dir === "sales" ? "매출" : confirmModal.registerAs === "customs" ? "관세" : "매입"} 등록
                확인
              </h3>
            </div>
            {confirmModal.dir === "purchase" && (
              <div className="flex items-center gap-4 text-base">
                <span className="text-sm text-muted">등록 유형</span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={confirmModal.registerAs === "purchase"}
                    onChange={() => setConfirmModal((prev) => (prev ? { ...prev, registerAs: "purchase" } : prev))}
                    className="h-4 w-4 accent-accent"
                  />
                  일반전표(매입)
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={confirmModal.registerAs === "customs"}
                    onChange={() => setConfirmModal((prev) => (prev ? { ...prev, registerAs: "customs" } : prev))}
                    className="h-4 w-4 accent-accent"
                  />
                  관세전표
                </label>
              </div>
            )}
            {confirmModal.dir === "purchase" &&
              confirmModal.registerAs === "customs" &&
              renderCustomsPartyField(confirmModal.customsPartyId, (id) =>
                setConfirmModal((prev) => (prev ? { ...prev, customsPartyId: id } : prev))
              )}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm text-muted">
                {confirmExtractInfo || confirmExtractError ? "인보이스 재확인 (선택)" : "인보이스 첨부 (선택)"}
              </label>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => handleConfirmFileChange(e.target.files?.[0] ?? null)}
                className="text-sm text-fg file:mr-2 file:rounded-md file:border-0 file:bg-gray-95 file:px-3 file:py-1.5 file:text-sm"
              />
              {confirmFile && <span className="text-sm text-muted">{confirmFile.name}</span>}
              {confirmExtractLoading && <span className="text-sm text-muted">PDF 분석 중...</span>}
              {/* 인식 결과 본문은 여기 안 두고 별도 팝업(confirmExtractPopupOpen)으로 띄운다 —
                  안내문이 첨부 칸 옆 작은 글씨로만 있으면 놓치기 쉽다는 피드백(2026-08-27).
                  이미 닫은 뒤 다시 보고 싶으면 아래 링크로 다시 연다. */}
              {(confirmExtractInfo || confirmExtractError) && !confirmExtractPopupOpen && (
                <button
                  type="button"
                  onClick={() => setConfirmExtractPopupOpen(true)}
                  className="w-fit text-sm text-accent hover:underline"
                >
                  인식 결과 다시 보기
                </button>
              )}
            </div>
            <dl className="flex flex-col gap-2 text-base">
              <div className="flex justify-between">
                <dt className="text-muted">거래처</dt>
                <dd className="text-fg">{confirmModal.row.counterpartCorpName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">작성일자</dt>
                <dd className="text-fg">{formatYmd(confirmModal.row.writeDate)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">품목</dt>
                <dd className="text-fg">{confirmModal.row.itemName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">금액(공급가액)</dt>
                <dd className="num text-fg">{formatAmount(confirmModal.row.amountTotal)}</dd>
              </div>
            </dl>

            {/* B/L — 매출은 원래 1건만 입력했지만, "+ B/L 추가"를 누르면 이 세금계산서 금액을
                여러 B/L로 나눠 각각 매출로 등록할 수 있다(2026-08-27). 매입은 이미 "여러 B/L로
                나눠 배분" 팝업이 따로 있어 여기에는 추가하지 않는다. */}
            <div className="flex flex-col gap-2">
              {/* "+ B/L 추가"와 "배분 합계"는 항상 이 상단 줄에 고정한다 — 예전엔 여러 줄
                  모드로 바뀌면 목록 아래로 밀려 내려가서, 줄을 추가할 때마다 버튼 위치가 계속
                  바뀌는 게 불편하다는 피드백(2026-08-27)에 따라 고정 위치로 옮김. */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">B/L</span>
                <div className="flex items-center gap-3">
                  {confirmModal.blRows && (
                    <span className="text-sm text-muted">
                      배분 합계{" "}
                      <span
                        className={`num ${
                          confirmBlRowsSum() === confirmModal.row.amountTotal ? "text-pos" : "text-neg"
                        }`}
                      >
                        {formatAmount(confirmBlRowsSum())} / {formatAmount(confirmModal.row.amountTotal)}
                      </span>
                    </span>
                  )}
                  {confirmModal.blRows && confirmBlRowsSum() !== confirmModal.row.amountTotal && (
                    <button
                      type="button"
                      onClick={addConfirmDifferenceRow}
                      className="flex items-center gap-1 text-sm text-neg hover:underline"
                    >
                      <IconPlus className="h-3.5 w-3.5" />
                      차액 추가
                    </button>
                  )}
                  {confirmModal.dir === "sales" && (
                    <button
                      type="button"
                      onClick={addConfirmBlRow}
                      className="flex items-center gap-1 text-sm text-accent hover:underline"
                    >
                      <IconPlus className="h-3.5 w-3.5" />
                      B/L 추가
                    </button>
                  )}
                </div>
              </div>
              {confirmModal.blRows ? (
                <div className="flex flex-col gap-2">
                  {confirmModal.blRows.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      {/* 항목: 실제 B/L 번호가 있는 줄인지, 아니면 B/L 없이 W/F(부대비용 등)나
                          기타 명칭으로 남길 줄인지 — 바꾸면 오른쪽 입력칸의 쓰임새도 같이
                          바뀌므로 값을 비워서(W/F는 기본 문구로 채워서) 새로 입력받는다. */}
                      <select
                        value={row.kind}
                        onChange={(e) => {
                          const kind = e.target.value as SalesBlRowKind;
                          updateConfirmBlRow(idx, { kind, blNo: kind === "wf" ? "W/F" : "" });
                        }}
                        className="w-20 shrink-0 rounded-lg border border-border bg-surface px-2 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                      >
                        <option value="bl">B/L</option>
                        <option value="wf">W/F</option>
                        <option value="etc">기타</option>
                      </select>
                      <input
                        value={row.blNo}
                        onChange={(e) => updateConfirmBlRow(idx, { blNo: e.target.value })}
                        placeholder={row.kind === "bl" ? "B/L 번호" : row.kind === "wf" ? "W/F" : "기타 명칭"}
                        list={row.kind === "bl" ? "bl-no-candidates" : undefined}
                        className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                      />
                      <input
                        value={row.amountDisplay}
                        onChange={(e) => updateConfirmBlRow(idx, { amountDisplay: commaInput(e.target.value) })}
                        inputMode="decimal"
                        placeholder="금액"
                        className="num w-32 rounded-lg border border-border bg-surface px-3 py-2 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                      />
                      {confirmModal.blRows!.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeConfirmBlRow(idx)}
                          title="이 줄 삭제"
                          className="text-muted hover:text-neg"
                        >
                          <IconMinus className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <input
                  value={confirmModal.blNo}
                  onChange={(e) => handleConfirmBlNoChange(e.target.value)}
                  placeholder="B/L 번호"
                  list="bl-no-candidates"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              )}
            </div>

            {!confirmModal.blRows && (confirmModal.loadingPreview || confirmModal.existingLabel) && (
              <div className="rounded-lg bg-gray-95 px-4 py-3 text-sm">
                {confirmModal.loadingPreview ? (
                  <span className="text-muted">
                    이 B/L로 이미 등록된 {confirmModal.dir === "sales" ? "매입" : "매출"}이 있는지 확인 중...
                  </span>
                ) : (
                  <span className="text-pos">
                    이 B/L로 이미 등록된 {confirmModal.dir === "sales" ? "매입" : "매출"}과 자동 연결됩니다:{" "}
                    {confirmModal.existingLabel}
                  </span>
                )}
              </div>
            )}

            {confirmError && <div className="text-base text-neg">{confirmError}</div>}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setConfirmModal(null);
                  setConfirmFile(null);
                }}
                className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                disabled={
                  confirmPending ||
                  (confirmModal.blRows
                    ? confirmModal.blRows.some((r) => !r.blNo.trim()) ||
                      confirmBlRowsSum() !== confirmModal.row.amountTotal
                    : !confirmModal.blNo.trim())
                }
                onClick={handleConfirmRegister}
                className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {confirmPending ? "승인 중..." : "승인"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 인보이스 PDF 인식 결과 팝업 — 등록 확인 팝업 위에 한 번 더 뜬다(z-index를 더 높게).
          성공(초록: 인식된 B/L·금액)과 실패(빨강: 에러 메시지·B/L 못 찾음)를 같은 팝업에서
          보여주고, 금액이 세금계산서와 다르면 그 안에 경고도 함께 넣는다 — "확인"을 눌러야
          닫혀서 놓치지 않게 한다. */}
      {confirmModal && confirmExtractPopupOpen && (confirmExtractInfo || confirmExtractError) && (() => {
        const single = confirmExtractInfo?.lines.length === 1 ? confirmExtractInfo.lines[0] : null;
        const mismatch = single ? amountMismatchWarning(confirmExtractInfo!.lines, confirmModal.row.amountTotal) : null;
        const isTrouble = Boolean(confirmExtractError || mismatch);
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
            <div className="card flex w-full max-w-md flex-col gap-4 p-7">
              <h3 className="flex items-center gap-2 text-base font-semibold text-fg">
                {isTrouble ? (
                  <IconAlertCircle className="h-5 w-5 text-neg" />
                ) : (
                  <IconCheckCircle className="h-5 w-5 text-pos" />
                )}
                인보이스 인식 결과
              </h3>
              {confirmExtractInfo && (
                <>
                  {/* "인식된 내용" 박스 — B/L이 1건이든 여러 건이든 같은 모양으로 보여준다
                      (2026-08-27: 1건일 때만 문장으로 두면 여러 건일 때랑 생김새가 달라져서
                      통일). 여러 건이면 이 목록에 있는 값이 그대로 아래 배분 목록에 자동으로
                      채워져 있다 — 이 박스는 그 내용을 다시 확인하는 용도라 읽기 전용이다. */}
                  <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-gray-95 px-4 py-3 text-sm">
                    <div className="flex items-center gap-1.5 font-medium text-pos">
                      <IconCheckCircle className="h-4 w-4 shrink-0" />
                      인식된 내용
                    </div>
                    {confirmExtractInfo.lines.map((l, i) => (
                      <div key={i} className="flex justify-between">
                        <span className="text-fg">B/L {l.blNo}</span>
                        <span className="num text-fg">{formatAmount(l.amount)}원</span>
                      </div>
                    ))}
                  </div>
                  {single && mismatch && (
                    <>
                      <p className="flex items-center gap-1.5 text-sm text-neg">
                        <IconAlertCircle className="h-4 w-4 shrink-0" />
                        공급가액과 차이가 있습니다.
                      </p>
                      <div className="flex flex-col gap-1.5 rounded-xl border border-neg/20 bg-neg/5 px-4 py-3 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted">인식된 금액</span>
                          <span className="num text-fg">{formatAmount(single.amount)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">공급가액</span>
                          <span className="num text-fg">{formatAmount(confirmModal.row.amountTotal)}</span>
                        </div>
                        <div className="flex justify-between border-t border-neg/20 pt-1.5 font-medium">
                          <span className="text-neg">차액</span>
                          <span className="num text-neg">
                            {single.amount - confirmModal.row.amountTotal > 0 ? "+" : ""}
                            {formatAmount(single.amount - confirmModal.row.amountTotal)}
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                  {!single && (
                    <p className="text-sm text-muted">
                      이 인보이스는 여러 B/L을 커버하는 것으로 보여, 인식된 {confirmExtractInfo.lines.length}건을
                      아래 B/L 목록에 전부 자동으로 나눠 채웠습니다. 확인하고 필요하면 직접
                      수정하세요(세금계산서 여러 건을 하나로 묶으려면 취소 후{" "}
                      {confirmModal.dir === "purchase" ? '"묶어서 등록" 또는 "여러 B/L로 나눠 배분"' : '"묶어서 등록"'}
                      을 이용하세요).
                      {/* 명세서에서 부가세를 빼서 읽었다는 사실을 알려준다 — 화면 금액이 문서에
                          인쇄된 B/L 합계와 다른 이유가 여기 있다. */}
                      {confirmExtractInfo.lines.some((l) => l.vat > 0) &&
                        ` (문서의 부가세 ${formatAmount(
                          confirmExtractInfo.lines.reduce((sum, l) => sum + l.vat, 0)
                        )}원은 제외해 공급가액으로 읽었습니다)`}
                    </p>
                  )}
                </>
              )}
              {confirmExtractError && (
                <p className="flex items-center gap-1.5 text-sm text-neg">
                  <IconAlertCircle className="h-4 w-4 shrink-0" />
                  {confirmExtractError}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmExtractPopupOpen(false)}
                  className="rounded-xl bg-accent px-5 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover"
                >
                  확인
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 등록내역 팝업 — 읽기 전용이다. 여기서 값을 고치지 않는 이유: 수정은 사유+이력이 필요한
          별도 흐름("확정" 칸의 수정 버튼)이고, 두 곳에서 고칠 수 있으면 이력이 갈린다. */}
      {detailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-lg flex-col gap-3 p-5">
            <div>
              <h3 className="num text-sm font-semibold text-fg">{detailModal.title}</h3>
            </div>

            {detailModal.loading ? (
              <div className="py-6 text-center text-sm text-muted">불러오는 중...</div>
            ) : detailModal.error ? (
              <div className="text-sm text-neg">{detailModal.error}</div>
            ) : detailModal.detail ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5 rounded-md bg-gray-95 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted">등록 유형</span>
                    <span className="text-fg">
                      {detailModal.detail.kind === "sale"
                        ? "매출전표"
                        : detailModal.detail.kind === "customs"
                          ? "관세전표 (관세대납)"
                          : "매입전표 (일반전표)"}
                    </span>
                  </div>
                  {/* 관세대납은 거래처를 따로 두지 않아 이름이 빈 값으로 온다 — 줄 자체를 숨긴다. */}
                  {detailModal.detail.partyName && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted">거래처</span>
                      <span className="text-fg">{detailModal.detail.partyName}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted">
                      {detailModal.detail.kind === "customs" ? "대납일" : "일자"}
                    </span>
                    <span className="num text-fg">{detailModal.detail.date}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted">금액 (공급가액 기준)</span>
                    <span className="num font-medium text-fg">
                      {formatAmount(detailModal.detail.totalAmount)}원
                    </span>
                  </div>
                  {detailModal.detail.note && (
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0 text-xs text-muted">품목</span>
                      <span className="text-right text-fg">{detailModal.detail.note}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">
                    B/L별 배분 ({detailModal.detail.blRows.length}건)
                  </span>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="py-1.5 pr-3">B/L</th>
                        <th className="py-1.5 pr-3 text-right">배분 금액</th>
                        <th className="py-1.5">매출 연결</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailModal.detail.blRows.map((b, idx) => (
                        <tr key={`${b.blNo}-${idx}`} className="border-b border-border/60">
                          <td className="py-1.5 pr-3 num text-fg">
                            {b.blNo || <span className="text-muted">(B/L 없음)</span>}
                            {/* 세금계산서에 없는 금액 줄은 명칭을 함께 보여준다. */}
                            {b.label && (
                              <span className="ml-1.5 rounded bg-gray-95 px-1.5 py-0.5 text-xs text-muted">
                                {b.label}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-right num text-fg">{formatAmount(b.amount)}</td>
                          {/* 매출이 아직 등록되지 않은 B/L은 "미연결" — 나중에 그 B/L로 매출이
                              등록되면 자동으로 연결된다(PurchaseAllocation.saleId). */}
                          <td className="py-1.5">
                            <span className={`text-xs ${b.saleLinked ? "text-pos" : "text-muted"}`}>
                              {b.saleLinked ? "연결됨" : "미연결"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {detailModal.detail.blRows.length > 1 && (
                      <tfoot>
                        <tr className="border-t border-border font-medium">
                          <td className="py-1.5 pr-3 text-fg">합계</td>
                          <td className="py-1.5 pr-3 text-right num text-fg">
                            {formatAmount(
                              detailModal.detail.blRows.reduce((sum, b) => sum + b.amount, 0)
                            )}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted">
                    함께 등록된 세금계산서 ({detailModal.detail.invoices.length}건)
                  </span>
                  <div className="max-h-40 overflow-y-auto rounded-md bg-gray-95 px-2 py-1.5">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted">
                          <th className="py-1.5 pr-3">번호</th>
                          <th className="py-1.5 pr-3">승인번호</th>
                          <th className="py-1.5 pr-3 text-right">청구금액</th>
                          <th className="py-1.5">인보이스</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailModal.detail.invoices.map((inv) => {
                          const invoiceAmount = rows?.find((r) => r.ntsSendKey === inv.ntsSendKey)?.amountTotal;
                          return (
                            <tr key={inv.ntsSendKey} className="border-b border-border/60 last:border-0">
                              <td className="py-1.5 pr-3 num text-fg">{numbers[inv.ntsSendKey] ?? "-"}</td>
                              <td className="py-1.5 pr-3 num text-fg">{inv.ntsSendKey}</td>
                              <td className="py-1.5 pr-3 text-right num text-fg">
                                {invoiceAmount != null ? formatAmount(invoiceAmount) : "-"}
                              </td>
                              <td className="py-1.5">
                                {inv.fileName ? (
                                  <button
                                    type="button"
                                    onClick={() => setPdfPreview({ ntsSendKey: inv.ntsSendKey, fileName: inv.fileName! })}
                                    className="max-w-[160px] truncate text-left text-accent hover:underline"
                                    title={inv.fileName}
                                  >
                                    {inv.fileName}
                                  </button>
                                ) : (
                                  <span className="text-muted">미첨부</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setDetailModal(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-fg hover:bg-gray-95"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {editModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          {/* 인보이스를 다시 첨부해 여러 B/L이 인식되면(새 파일에서 읽은 내용) + 현재 등록
              내역 + 수정 사유 + 수정 이력까지 한 번에 다 펼쳐져서, 화면이 작으면 아래
              저장/취소 버튼이 뷰포트 밖으로 밀려나 있었다(2026-09-03 피드백). 카드 자체에
              최대 높이를 주고 내부 스크롤로 바꿨다. */}
          <div className="card flex max-h-[90vh] w-full max-w-2xl flex-col gap-5 overflow-y-auto p-8">
            <h3 className="text-xl font-semibold text-fg">
              승인된 {editModal.direction === "sales" ? "매출" : "매입"} 세금계산서 수정
              {editModal.ntsSendKeys.length > 1 && ` — 묶음 ${editModal.ntsSendKeys.length}건`}
            </h3>

            <div className="flex flex-col gap-3 text-base">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">현재 B/L</span>
                <span className="num text-fg">{editModal.currentBlNo || "-"}</span>
              </div>
              <label className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted">새 B/L</span>
                <input
                  value={editModal.newBlNo}
                  onChange={(e) => setEditModal((prev) => (prev ? { ...prev, newBlNo: e.target.value } : prev))}
                  placeholder="B/L 번호"
                  className="w-60 rounded-xl border border-border bg-surface px-3 py-2 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              </label>

              {/* 다시 첨부 — 고르지 않으면 기존 파일을 그대로 유지한다. 고르면 그 PDF에서 읽어낸
                  내용을 바로 아래에 보여줘서, 저장 전에 "맞는 파일인지" 확인할 수 있게 한다. */}
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-muted">인보이스 다시 첨부 (선택)</span>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => handleEditFileChange(e.target.files?.[0] ?? null)}
                  className="text-sm text-fg file:mr-2 file:rounded-md file:border-0 file:bg-gray-95 file:px-3 file:py-1.5 file:text-sm"
                />
                <span className="text-sm break-all text-muted">
                  {editModal.file ? (
                    `새 파일: ${editModal.file.name}`
                  ) : editModal.currentFileName ? (
                    <>
                      현재 파일:{" "}
                      <button
                        type="button"
                        onClick={() =>
                          setPdfPreview({ ntsSendKey: editModal.ntsSendKeys[0], fileName: editModal.currentFileName })
                        }
                        className="text-accent hover:underline"
                      >
                        {editModal.currentFileName}
                      </button>{" "}
                      — 고르지 않으면 그대로 유지됩니다
                    </>
                  ) : (
                    "현재 파일: (없음) — 고르지 않으면 그대로 유지됩니다"
                  )}
                </span>
                {editModal.extractLoading && <span className="text-sm text-muted">PDF 분석 중...</span>}
                {editModal.extractError && <span className="text-sm text-neg">{editModal.extractError}</span>}
                {editModal.extract && (
                  <div className="flex flex-col gap-1.5 rounded-xl bg-gray-95 px-4 py-3 text-sm">
                    <span className="text-muted">
                      새 파일에서 읽은 내용 ({editModal.extract.method === "ai" ? "AI" : "자동"} 인식,{" "}
                      {editModal.extract.lines.length}줄)
                    </span>
                    {editModal.extract.lines.map((l, i) => (
                      <span key={`${l.blNo}-${i}`} className="flex justify-between gap-3">
                        <span className="num text-fg">{l.blNo || "(B/L 없음)"}</span>
                        <span className="num text-fg">{formatAmount(Math.round(l.amount))}</span>
                      </span>
                    ))}
                    <span className="flex justify-between gap-3 border-t border-border pt-1 font-medium">
                      <span className="text-fg">합계</span>
                      <span className="num text-fg">
                        {formatAmount(
                          Math.round(editModal.extract.lines.reduce((sum, l) => sum + l.amount, 0))
                        )}
                      </span>
                    </span>
                    {/* 이 팝업에서는 배분을 다시 짜지 않는다 — 금액 구성을 바꾸려면 등록을 취소하고
                        다시 등록해야 하므로, 여기서는 "읽힌 값"만 보여주고 그 사실을 알려준다. */}
                    <span className="text-muted">
                      금액 배분은 이 팝업에서 바꾸지 않습니다 — 구성을 바꾸려면 아래 "묶음 풀기"로
                      등록을 취소하고 다시 등록하세요.
                    </span>
                  </div>
                )}
              </div>

              {/* 지금 등록돼 있는 전표 내역 — B/L을 고치기 전에 무엇이 등록됐는지 확인하는 부분. */}
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-muted">현재 등록 내역</span>
                {editModal.detailLoading ? (
                  <span className="text-sm text-muted">불러오는 중...</span>
                ) : editModal.detailError ? (
                  <span className="text-sm text-neg">{editModal.detailError}</span>
                ) : editModal.detail ? (
                  <div className="flex flex-col gap-1.5 rounded-xl bg-gray-95 px-4 py-3 text-sm">
                    <span className="flex justify-between gap-3">
                      <span className="text-muted">
                        {editModal.detail.kind === "sale"
                          ? "매출전표"
                          : editModal.detail.kind === "customs"
                            ? "관세전표"
                            : "매입전표"}
                        {editModal.detail.partyName ? ` · ${editModal.detail.partyName}` : ""} ·{" "}
                        {editModal.detail.date}
                      </span>
                      <span className="num font-medium text-fg">
                        {formatAmount(editModal.detail.totalAmount)}
                      </span>
                    </span>
                    {editModal.detail.blRows.map((b, i) => (
                      <span key={`${b.blNo}-${i}`} className="flex justify-between gap-3">
                        <span className="num text-fg">
                          {b.blNo || "(B/L 없음)"}
                          {b.label && (
                            <span className="ml-1 rounded bg-surface px-1 text-muted">{b.label}</span>
                          )}
                        </span>
                        <span className="num text-fg">
                          {formatAmount(b.amount)}
                          <span className={`ml-1.5 ${b.saleLinked ? "text-pos" : "text-muted"}`}>
                            {b.saleLinked ? "연결됨" : "미연결"}
                          </span>
                        </span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-muted">수정 사유 (필수)</span>
                <div className="flex gap-3">
                  <select
                    value={editModal.reasonCategory}
                    onChange={(e) =>
                      setEditModal((prev) =>
                        prev ? { ...prev, reasonCategory: e.target.value as EditReasonCategory } : prev
                      )
                    }
                    className="w-36 shrink-0 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  >
                    {EDIT_REASON_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={editModal.reason}
                    onChange={(e) => setEditModal((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
                    rows={2}
                    placeholder="예: B/L 오타 정정, 인보이스 재발행분으로 교체 등"
                    className="flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">수정 이력</span>
              {editModal.historyLoading ? (
                <span className="text-sm text-muted">불러오는 중...</span>
              ) : editModal.history && editModal.history.length > 0 ? (
                <div className="max-h-40 overflow-y-auto rounded-xl bg-gray-95 px-4 py-2">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="py-1.5 pr-3">일시</th>
                        <th className="py-1.5 pr-3">수정자</th>
                        <th className="py-1.5 pr-3">사유</th>
                        <th className="py-1.5">변경 내용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editModal.history.map((h, idx) => (
                        <tr key={idx} className="border-b border-border/60 align-top last:border-0">
                          <td className="py-1.5 pr-3 whitespace-nowrap text-muted">
                            {h.createdAt.slice(0, 16).replace("T", " ")}
                          </td>
                          <td className="py-1.5 pr-3 whitespace-nowrap text-fg">{h.changedByEmail}</td>
                          <td className="py-1.5 pr-3 text-muted">{h.reason}</td>
                          <td className="py-1.5 text-muted">
                            <div className="flex flex-col gap-0.5">
                              {h.previousBlNo !== h.newBlNo && (
                                <span>
                                  B/L: {h.previousBlNo || "(없음)"} → {h.newBlNo || "(없음)"}
                                </span>
                              )}
                              {h.previousFileName !== h.newFileName && (
                                <span className="break-all">
                                  파일: {h.previousFileName || "(없음)"} → {h.newFileName || "(없음)"}
                                </span>
                              )}
                              {h.previousAmount !== null &&
                                h.newAmount !== null &&
                                h.previousAmount !== h.newAmount && (
                                  <span className="num">
                                    금액: {formatAmount(h.previousAmount)} → {formatAmount(h.newAmount)}
                                  </span>
                                )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <span className="text-sm text-muted">아직 수정 이력이 없습니다.</span>
              )}
            </div>

            {editError && <div className="text-base text-neg">{editError}</div>}

            <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
              {/* "묶음 풀기"는 여기 없다 — 이제 "수정" 옆의 독립된 선택지다(2026-08-27). B/L
                  변경과 같이 두면 등록을 지우는 되돌릴 수 없는 동작인지 헷갈렸다. */}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setEditModal(null)}
                  className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={editPending || !editModal.newBlNo.trim() || !editModal.reason.trim()}
                  onClick={handleSaveEdit}
                  className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
                >
                  {editPending ? "저장 중..." : "수정 저장"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* "수정" 선택 팝업 — 묶음풀기/B/L변경/금액조정 셋은 서로 겹치지 않는 별개 동작이라
          (묶음풀기: 묶음 구성만 되돌림 / B/L변경: B/L만 / 금액조정: B/L은 그대로 두고 금액만)
          행에 링크 세 개를 늘어놓는 대신 "수정" 하나를 누르면 여기서 고르게 한다(2026-08-27). */}
      {editChoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-sm flex-col gap-1.5 p-6">
            <h3 className="mb-1 text-base font-semibold text-fg">수정</h3>
            {editChoice.isGroup && (
              <button
                type="button"
                onClick={() => {
                  const { ntsSendKeys, counterpartCorpNum, blNo } = editChoice;
                  setEditChoice(null);
                  handleUnbundleFromRow(ntsSendKeys, counterpartCorpNum, blNo);
                }}
                className="flex flex-col rounded-xl px-4 py-3 text-left hover:bg-gray-95"
              >
                <span className="text-sm font-medium text-neg">묶음 풀기</span>
                <span className="text-xs text-muted">묶어서 등록한 것을 취소하고 다시 미등록 상태로 되돌립니다.</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const { ntsSendKeys, counterpartCorpNum, attachment } = editChoice;
                setEditChoice(null);
                openEditModal(ntsSendKeys, counterpartCorpNum, attachment);
              }}
              className="flex flex-col rounded-xl px-4 py-3 text-left hover:bg-gray-95"
            >
              <span className="text-sm font-medium text-fg">B/L 변경</span>
              <span className="text-xs text-muted">B/L 번호를 고치거나 인보이스를 다시 첨부합니다.</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const { ntsSendKeys, counterpartCorpNum } = editChoice;
                setEditChoice(null);
                openAmountModal(ntsSendKeys, counterpartCorpNum);
              }}
              className="flex flex-col rounded-xl px-4 py-3 text-left hover:bg-gray-95"
            >
              <span className="text-sm font-medium text-fg">금액 조정</span>
              <span className="text-xs text-muted">B/L은 그대로 두고 등록된 금액만 고칩니다.</span>
            </button>
            <button
              type="button"
              onClick={() => setEditChoice(null)}
              className="mt-2 self-end rounded-xl px-4 py-2 text-sm text-muted hover:text-fg"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* "묶음 풀기" 확인 팝업 — 사유를 받아야 실제로 지울 수 있다(2026-08-27, window.confirm
          대신). 등록을 지우는 되돌릴 수 없는 동작이라 무엇이 삭제되는지 다시 한번 보여준다. */}
      {unbundleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-4xl flex-col gap-4 p-7">
            <h3 className="text-xl font-semibold text-fg">
              &quot;{unbundleModal.blNo}&quot; 묶음 풀기
            </h3>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted marker:text-fg [&>li]:whitespace-nowrap">
              <li>
                묶음 등록을 취소하면 공급가액 합계{" "}
                <span className="num font-medium text-fg">{formatAmount(unbundleModal.combinedAmountTotal)}</span>
                원으로 등록된 {direction === "sales" ? "매출" : "내용"}이 삭제됩니다.
              </li>
              <li>
                해당 묶음의 세금계산서 {unbundleModal.ntsSendKeys.length}건은 첨부된 인보이스 파일과 함께
                삭제되며, 상태가 &quot;미등록&quot;으로 돌아갑니다.
              </li>
              <li>
                {direction === "sales"
                  ? "해당 B/L에 매입배분·관세대납이 매출과 연결되어 있다면 함께 삭제됩니다."
                  : "해당 B/L에 다른 배분(다른 B/L과 함께 등록된 경우)이 더 있다면 함께 삭제됩니다."}
              </li>
            </ol>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">풀기 사유 (필수)</span>
              <div className="flex gap-3">
                <select
                  value={unbundleModal.reasonCategory}
                  onChange={(e) =>
                    setUnbundleModal((prev) =>
                      prev ? { ...prev, reasonCategory: e.target.value as UnbundleReasonCategory } : prev
                    )
                  }
                  className="w-40 shrink-0 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                >
                  {UNBUNDLE_REASON_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <textarea
                  value={unbundleModal.reason}
                  onChange={(e) => setUnbundleModal((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
                  rows={2}
                  placeholder="예: 잘못 묶여 등록됨, 세금계산서 재발행으로 다시 등록 필요 등"
                  className="flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                />
              </div>
            </div>
            {unbundleError && <div className="text-base text-neg">{unbundleError}</div>}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setUnbundleModal(null)}
                className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
              >
                취소
              </button>
              <button
                type="button"
                disabled={unbundleModal.ntsSendKeys.some((k) => attachPending.has(k)) || !unbundleModal.reason.trim()}
                onClick={handleSaveUnbundle}
                className="rounded-xl bg-neg px-6 py-2.5 text-base font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {unbundleModal.ntsSendKeys.some((k) => attachPending.has(k)) ? "묶음 푸는 중..." : "확인"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 인보이스 PDF 미리보기 팝업 — 파일명을 누르면 새 탭 대신 여기서 바로 본다
          (2026-08-27). z-index를 다른 팝업들보다 높여서 수정/상세 팝업 위에서도 뜰 수 있게
          한다("현재 파일" 링크가 그런 팝업들 안에도 있어서). */}
      {pdfPreview && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <div className="card flex h-[85vh] w-full max-w-4xl flex-col gap-3 p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="truncate text-base font-semibold text-fg" title={pdfPreview.fileName}>
                {pdfPreview.fileName}
              </h3>
              <div className="flex shrink-0 items-center gap-3">
                <a
                  href={`/api/tax-invoice-file/${encodeURIComponent(pdfPreview.ntsSendKey)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-accent hover:underline"
                >
                  새 탭에서 열기
                </a>
                <button
                  type="button"
                  onClick={() => setPdfPreview(null)}
                  className="rounded-xl px-4 py-1.5 text-sm text-muted hover:text-fg"
                >
                  닫기
                </button>
              </div>
            </div>
            <iframe
              src={`/api/tax-invoice-file/${encodeURIComponent(pdfPreview.ntsSendKey)}`}
              title={pdfPreview.fileName}
              className="min-h-0 w-full flex-1 rounded-lg border border-border bg-gray-95"
            />
          </div>
        </div>
      )}

      {/* "금액 조정" 팝업 — B/L 변경 팝업과 형태는 비슷하지만 B/L 입력칸이 없다(읽기 전용으로만
          보여준다). 대신 등록된 B/L마다 새 금액을 따로 입력받는다(2026-08-27). */}
      {amountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card flex w-full max-w-2xl flex-col gap-5 p-8">
            <h3 className="text-xl font-semibold text-fg">
              {amountModal.direction === "sales" ? "매출" : "매입"} 금액 조정
              {amountModal.ntsSendKeys.length > 1 && ` — 묶음 ${amountModal.ntsSendKeys.length}건`}
            </h3>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">등록된 B/L별 금액</span>
              {amountModal.rows === null ? (
                <span className="text-sm text-muted">불러오는 중...</span>
              ) : amountModal.detailError ? (
                <span className="text-sm text-neg">{amountModal.detailError}</span>
              ) : (
                <div className="flex flex-col gap-2 rounded-xl bg-gray-95 px-4 py-3">
                  {amountModal.rows.map((r, idx) => (
                    <div key={`${r.blNo}-${idx}`} className="flex items-center justify-between gap-3 text-sm">
                      <span className="num text-fg">{r.blNo || "(B/L 없음)"}</span>
                      <span className="num text-muted">{formatAmount(r.currentAmount)} →</span>
                      <input
                        value={r.newAmountDisplay}
                        onChange={(e) => updateAmountRow(idx, commaInput(e.target.value))}
                        inputMode="decimal"
                        className="num w-40 rounded-lg border border-border bg-surface px-3 py-1.5 text-right text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                      />
                    </div>
                  ))}
                  {amountModal.rows.length === 0 && (
                    <span className="text-sm text-muted">조정할 등록 내역을 찾지 못했습니다.</span>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">수정 사유 (필수)</span>
              <textarea
                value={amountModal.reason}
                onChange={(e) => setAmountModal((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
                rows={2}
                placeholder="예: 세금계산서 재발행으로 공급가액 변경, 입력 오류 정정 등"
                className="rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">수정 이력</span>
              {amountModal.historyLoading ? (
                <span className="text-sm text-muted">불러오는 중...</span>
              ) : amountModal.history && amountModal.history.length > 0 ? (
                <div className="max-h-40 overflow-y-auto rounded-xl bg-gray-95 px-4 py-2">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="py-1.5 pr-3">일시</th>
                        <th className="py-1.5 pr-3">수정자</th>
                        <th className="py-1.5 pr-3">사유</th>
                        <th className="py-1.5">변경 내용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {amountModal.history.map((h, idx) => (
                        <tr key={idx} className="border-b border-border/60 align-top last:border-0">
                          <td className="py-1.5 pr-3 whitespace-nowrap text-muted">
                            {h.createdAt.slice(0, 16).replace("T", " ")}
                          </td>
                          <td className="py-1.5 pr-3 whitespace-nowrap text-fg">{h.changedByEmail}</td>
                          <td className="py-1.5 pr-3 text-muted">{h.reason}</td>
                          <td className="py-1.5 text-muted">
                            <div className="flex flex-col gap-0.5">
                              {h.previousAmount !== null &&
                                h.newAmount !== null &&
                                h.previousAmount !== h.newAmount && (
                                  <span className="num">
                                    금액: {formatAmount(h.previousAmount)} → {formatAmount(h.newAmount)}
                                  </span>
                                )}
                              {h.previousBlNo !== h.newBlNo && (
                                <span>
                                  B/L: {h.previousBlNo || "(없음)"} → {h.newBlNo || "(없음)"}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <span className="text-sm text-muted">아직 수정 이력이 없습니다.</span>
              )}
            </div>

            {amountError && <div className="text-base text-neg">{amountError}</div>}

            <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setAmountModal(null)}
                  className="rounded-xl px-5 py-2.5 text-base text-muted hover:text-fg"
                >
                  취소
                </button>
                <button
                  type="button"
                  disabled={amountPending || !amountModal.rows?.length || !amountModal.reason.trim()}
                  onClick={handleSaveAmountAdjust}
                  className="rounded-xl bg-accent px-6 py-2.5 text-base font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
                >
                  {amountPending ? "저장 중..." : "수정 저장"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
