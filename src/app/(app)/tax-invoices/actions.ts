"use server";

import { revalidatePath } from "next/cache";
import {
  getMonthlyTaxInvoices,
  getTaxInvoicePrintUrl,
  type TaxInvoiceDirection,
  type TaxInvoiceRow,
} from "@/lib/barobill";
import { getCurrentUserFresh } from "@/lib/session";
import { parseHometaxTaxInvoiceExcel } from "@/lib/taxInvoiceExcel";
import {
  saveTaxInvoiceAttachmentPdf,
  saveBundledTaxInvoiceAttachmentPdf,
  deleteUploadedFile,
} from "@/lib/fileStorageActions";
import { getAttachmentStatuses as getAttachmentStatusesLib, type AttachmentStatus } from "@/lib/taxInvoiceAttachments";
import { saveTaxInvoiceRecords, getSavedTaxInvoiceRecords, mergeTaxInvoiceRows } from "@/lib/taxInvoiceRecords";
import { assignTaxInvoiceNumbers } from "@/lib/taxInvoiceNumbers";
import { ensurePartyByName, ensurePartiesFromTaxInvoiceRows } from "@/app/(app)/parties/actions";
import { getAccessibleEmails } from "@/lib/email-groups";
import { resolveCustomsPartyId } from "@/app/(app)/customs/actions";
import { parseDateInput, formatDate, formatBizNo, bizNoDigits } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export type SearchTaxInvoicesResult =
  // numbers: 승인번호 → 내부 관리번호(매출 I00001 / 매입 O00001) 맵
  // partyCodes: 사업자등록번호(숫자만) → 거래처 코드 맵 — 목록에 "[0001] 거래처명"으로 보여준다
  | {
      ok: true;
      rows: TaxInvoiceRow[];
      truncated: boolean;
      numbers: Record<string, string>;
      partyCodes: Record<string, string>;
    }
  | { ok: false; message: string };

// 세금계산서 상대방(공급자/공급받는자)의 거래처 코드를 사업자등록번호로 찾아온다. 세금계산서
// 자체엔 거래처 코드가 없고 Party와는 사업자번호로만 연결되므로, 화면에 "[0001] 거래처명"을
// 보여주려면 이 맵이 필요하다. 키는 숫자만 남긴 사업자번호 — 세금계산서 쪽 형식(하이픈 유무)이
// 경로에 따라 달라서다(formatBizNo 주석 참고).
async function getPartyCodesByBizNo(rows: TaxInvoiceRow[]): Promise<Record<string, string>> {
  const bizNos = [...new Set(rows.map((r) => formatBizNo(r.counterpartCorpNum)).filter(Boolean))];
  if (bizNos.length === 0) return {};
  const parties = await prisma.party.findMany({
    where: { bizNo: { in: bizNos } },
    select: { bizNo: true, code: true },
  });
  const map: Record<string, string> = {};
  for (const p of parties) {
    if (p.bizNo && p.code) map[bizNoDigits(p.bizNo)] = p.code;
  }
  return map;
}

type TaxInvoiceUser = { email: string; role: string };

// proxy.ts는 "로그인 됐는가"만 확인하므로, 세금계산서 열람 권한은 Server Action 안에서도
// 다시 확인한다 (Next.js 공식 안내: Server Action은 proxy matcher로 걸러지지 않을 수 있음).
async function getTaxInvoiceUser(): Promise<TaxInvoiceUser | null> {
  const user = await getCurrentUserFresh();
  if (!user?.canViewTaxInvoices) return null;
  return { email: user.email, role: user.role };
}

async function hasTaxInvoiceAccess(): Promise<boolean> {
  return Boolean(await getTaxInvoiceUser());
}

// admin은 전부 보고, 그 외에는 세금계산서 상대방(사업자등록번호로 매칭된 거래처)의 담당자
// 이메일이 로그인 이메일과 같거나, 그 이메일과 같은 이메일 그룹에 속해 있을 때 볼 수 있다
// (2026-08-27, sol-mate의 이메일 그룹관리 기능 이식 — 같은 팀 여러 명이 서로의 거래처를
// 같이 볼 수 있게). 거래처에 이메일이 아직 없으면(자동생성 직후 등) admin에게만 보인다.
// 거래처 bizNo는 000-00-00000으로 저장되지만 세금계산서 쪽 corpNum은 경로에 따라 하이픈이
// 있을 수도(엑셀) 없을 수도(바로빌 API) 있다 — 그래서 대조는 항상 formatBizNo/bizNoDigits로
// 형식을 맞춘 뒤에 한다. 예전엔 문자열을 그대로 비교해서, 형식이 어긋나면 담당자 이메일이
// 설정돼 있어도 열람이 막히는 문제가 있었다.
async function hasCorpNumAccess(user: TaxInvoiceUser, corpNum: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const normalized = formatBizNo(corpNum);
  if (!normalized) return false;
  const party = await prisma.party.findUnique({ where: { bizNo: normalized } });
  if (!party?.email) return false;
  const accessible = await getAccessibleEmails(user.email);
  return accessible.has(party.email.trim().toLowerCase());
}

async function filterRowsByAccess(rows: TaxInvoiceRow[], user: TaxInvoiceUser): Promise<TaxInvoiceRow[]> {
  if (user.role === "admin") return rows;
  const bizNos = [...new Set(rows.map((r) => formatBizNo(r.counterpartCorpNum)).filter(Boolean))];
  if (bizNos.length === 0) return [];
  const accessible = await getAccessibleEmails(user.email);
  const parties = await prisma.party.findMany({
    where: { bizNo: { in: bizNos } },
    select: { bizNo: true, email: true },
  });
  const allowed = new Set(
    parties.filter((p) => p.email && accessible.has(p.email.trim().toLowerCase())).map((p) => bizNoDigits(p.bizNo))
  );
  return rows.filter((r) => allowed.has(bizNoDigits(r.counterpartCorpNum)));
}

export async function searchTaxInvoices(input: {
  direction: TaxInvoiceDirection;
  baseMonth: string;
  taxType: number;
  dateType: number;
}): Promise<SearchTaxInvoicesResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!/^\d{6}$/.test(input.baseMonth)) {
    return { ok: false, message: "조회년월 형식이 올바르지 않습니다 (YYYYMM)." };
  }

  // 엑셀 업로드로 저장해둔 내역(있다면)은 바로빌 API 결과와 항상 합쳐서 보여준다 — 업로드가
  // "그 순간만 보이고 사라지는" 게 아니라 이후 같은 구분/월을 조회할 때 계속 나오게 하기 위함.
  const saved = await getSavedTaxInvoiceRecords(input.direction, input.baseMonth);

  try {
    const { rows, truncated } = await getMonthlyTaxInvoices(input);
    // API로 받은 행도 사본으로 남긴다. 화면에는 매번 새로 조회한 값을 쓰지만, **다른 화면이
    // 세금계산서 금액을 알아야 할 때**(전표에 실제 입출금을 붙일 때 부가세가 필요하다 —
    // src/lib/bankAllocation.ts) API를 다시 부를 수는 없다. 은행거래 사본(BankTransaction)과
    // 같은 이유이고, 그래서 **한 번이라도 조회한 세금계산서만** 그 매칭에 쓸 수 있다.
    await saveTaxInvoiceRecords(input.direction, rows);
    const merged = mergeTaxInvoiceRows(rows, saved);
    // 목록에 뜬 사업자등록번호 중 거래처 마스터에 없는 곳은 자동으로 등록한다.
    await ensurePartiesFromTaxInvoiceRows(
      merged.map((r) => ({
        corpNum: r.counterpartCorpNum,
        corpName: r.counterpartCorpName,
        staffEmail: r.ourStaffEmail,
        writeDate: r.writeDate,
      }))
    );
    // 내부 관리번호(I/O + 순번)를 부여한다 — 볼 수 있는 행에만 매긴다(권한 없는 건에까지
    // 번호를 소모하지 않도록 filterRowsByAccess 뒤에 호출).
    const visible = await filterRowsByAccess(merged, user);
    const numbers = await assignTaxInvoiceNumbers(input.direction, visible);
    const partyCodes = await getPartyCodesByBizNo(visible);
    return { ok: true, rows: visible, truncated, numbers, partyCodes };
  } catch (err) {
    // 바로빌 조회 자체가 실패해도(자격정보 미설정 등) 저장된 업로드 내역만으로는 보여줄 수 있다.
    if (saved.length > 0) {
      await ensurePartiesFromTaxInvoiceRows(
        saved.map((r) => ({
          corpNum: r.counterpartCorpNum,
          corpName: r.counterpartCorpName,
          staffEmail: r.ourStaffEmail,
          writeDate: r.writeDate,
        }))
      );
      const visible = await filterRowsByAccess(saved, user);
      const numbers = await assignTaxInvoiceNumbers(input.direction, visible);
      const partyCodes = await getPartyCodesByBizNo(visible);
      return { ok: true, rows: visible, truncated: false, numbers, partyCodes };
    }
    return { ok: false, message: err instanceof Error ? err.message : "조회 중 오류가 발생했습니다." };
  }
}

export type UploadTaxInvoiceExcelResult =
  | {
      ok: true;
      direction: TaxInvoiceDirection;
      rows: TaxInvoiceRow[];
      numbers: Record<string, string>;
      partyCodes: Record<string, string>;
    }
  | { ok: false; message: string };

// 바로빌에 아직 없거나 조회량이 적을 때, 홈택스에서 직접 받은 "전자(수정) 세금계산서
// 목록조회" 엑셀(.xls)을 업로드해서 같은 화면에 띄운다. 승인번호 기준으로 DB에 저장해서,
// 이후 같은 구분/월을 "조회"하면 바로빌 API 결과와 합쳐서 계속 보인다(searchTaxInvoices
// 참고) — 새로고침하거나 다시 들어와도 매번 파일을 다시 올릴 필요가 없다.
export async function uploadTaxInvoiceExcel(base64: string): Promise<UploadTaxInvoiceExcelResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  // 엑셀 업로드는 관리자만 — 업로드한 내용은 DB(TaxInvoiceRecord)에 남아 이후 모든 조회에
  // 섞여 나오므로, 사실상 원본 데이터를 추가하는 행위다. 화면에서도 버튼을 숨기지만 Server
  // Action은 직접 호출될 수 있어 여기서도 반드시 막는다.
  if (user.role !== "admin") {
    return { ok: false, message: "엑셀 업로드는 관리자만 할 수 있습니다." };
  }

  try {
    const buffer = Buffer.from(base64, "base64");
    const { direction, rows } = parseHometaxTaxInvoiceExcel(buffer);
    await saveTaxInvoiceRecords(direction, rows);
    await ensurePartiesFromTaxInvoiceRows(
      rows.map((r) => ({
        corpNum: r.counterpartCorpNum,
        corpName: r.counterpartCorpName,
        staffEmail: r.ourStaffEmail,
        writeDate: r.writeDate,
      }))
    );
    const visible = await filterRowsByAccess(rows, user);
    const numbers = await assignTaxInvoiceNumbers(direction, visible);
    const partyCodes = await getPartyCodesByBizNo(visible);
    return { ok: true, direction, rows: visible, numbers, partyCodes };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "엑셀 파일을 처리하지 못했습니다." };
  }
}

export async function getAttachmentStatuses(
  entries: { ntsSendKey: string; direction: TaxInvoiceDirection }[]
): Promise<Record<string, AttachmentStatus>> {
  if (!(await hasTaxInvoiceAccess())) return {};
  return getAttachmentStatusesLib(entries);
}

export type AttachTaxInvoiceFileResult = { ok: true; status: AttachmentStatus } | { ok: false; message: string };

// 세금계산서 행에 실제 인보이스 PDF를 첨부한다. B/L은 AI 없이 클라이언트가 "비고"란에서
// 정규식으로 1차 추출해 넘겨준 값을 그대로 저장한다(src/lib/blNoExtract.ts) — 사용자가
// 화면에서 확인/수정한 뒤 registerFromTaxInvoice로 실제 매출/매입을 등록한다. 같은
// 승인번호로 다시 올리면 덮어쓴다(upsert).
export async function attachTaxInvoiceFile(input: {
  ntsSendKey: string;
  direction: TaxInvoiceDirection;
  base64: string;
  originalName: string;
  blNo: string | null;
  counterpartCorpNum: string;
}): Promise<AttachTaxInvoiceFileResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }

  const saved = await saveTaxInvoiceAttachmentPdf({
    base64: input.base64,
    originalName: input.originalName,
    ntsSendKey: input.ntsSendKey,
    blNo: input.blNo,
  });
  if (!saved.ok) {
    return { ok: false, message: saved.message };
  }

  // 이미 확정된 B/L이 있으면(등록까지 끝난 건 등) "다시 첨부"로 그 값을 지우지 않는다.
  // input.blNo는 비고 텍스트에서 뽑은 **추측값**이라 비고에 B/L이 없으면 null로 들어오는데,
  // 그대로 덮어쓰면 등록 연결이 끊겨 화면에서 "미등록"으로 보이고 — 그 상태로 다시 등록하면
  // 같은 세금계산서가 중복 등록된다(실제로 이 경로로 재현됨). 파일만 바꾸는 게 "다시 첨부"의
  // 목적이므로 확정된 B/L은 그대로 둔다. B/L을 바꿔야 하면 묶음 풀기/수정 흐름을 쓴다.
  const existing = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey: input.ntsSendKey } });
  const blNo = existing?.blNo ?? input.blNo;

  await prisma.taxInvoiceAttachment.upsert({
    where: { ntsSendKey: input.ntsSendKey },
    create: { ntsSendKey: input.ntsSendKey, direction: input.direction, blNo, fileName: saved.filename },
    update: { direction: input.direction, blNo, fileName: saved.filename },
  });

  const statuses = await getAttachmentStatusesLib([{ ntsSendKey: input.ntsSendKey, direction: input.direction }]);
  const status = statuses[input.ntsSendKey] ?? {
    blNo,
    fileName: saved.filename,
    matched: false,
    matchedKind: null,
    matchedLabel: null,
    bundledCount: 0,
    saleId: null,
    saleConfirmedAt: null,
  };
  return { ok: true, status };
}

export type ReattachGroupFileResult =
  | { ok: true; statuses: Record<string, AttachmentStatus> }
  | { ok: false; message: string };

// 이미 묶여서 등록된(같은 B/L을 공유하는) 세금계산서들의 인보이스 파일을 한 번에 다시
// 첨부한다 — B/L·등록 내용(Sale/Purchase/CustomsAdvance)은 건드리지 않고 파일명만 갱신한다.
// 개별 승인번호 단위로 다시 첨부하면 묶음이 깨진 것처럼 보일 수 있어, 묶음은 항상 이
// 액션으로만 파일을 바꾼다.
export async function reattachGroupFile(input: {
  ntsSendKeys: string[];
  base64: string;
  originalName: string;
  counterpartCorpNum: string;
}): Promise<ReattachGroupFileResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }
  if (input.ntsSendKeys.length === 0) {
    return { ok: false, message: "대상 승인번호가 없습니다." };
  }

  const primary = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey: input.ntsSendKeys[0] } });
  const saved = await saveBundledTaxInvoiceAttachmentPdf({
    base64: input.base64,
    originalName: input.originalName,
    ntsSendKeys: input.ntsSendKeys,
    blNo: primary?.blNo ?? null,
  });
  if (!saved.ok) {
    return { ok: false, message: saved.message };
  }

  for (const ntsSendKey of input.ntsSendKeys) {
    await prisma.taxInvoiceAttachment.update({ where: { ntsSendKey }, data: { fileName: saved.filename } });
  }

  const direction = (primary?.direction as TaxInvoiceDirection) ?? "purchase";
  const statuses = await getAttachmentStatusesLib(
    input.ntsSendKeys.map((ntsSendKey) => ({ ntsSendKey, direction }))
  );
  return { ok: true, statuses };
}

export type UnbundleGroupResult =
  | { ok: true; statuses: Record<string, AttachmentStatus> }
  | { ok: false; message: string };

// "묶어서 등록"으로 만들어진 매출(Sale)/매입(Purchase)/관세전표(CustomsAdvance) 등록을
// 통째로 취소하고, 묶음에 속한 세금계산서들을 "미등록" 상태로 되돌린다 — 다시 첨부하고 B/L을
// 입력해서 재등록할 수 있게. 첨부된 인보이스 파일도 함께 지운다(2026-08-27 — 예전엔 파일은
// 남기고 B/L만 비웠는데, "첨부도 없던 걸로 해달라"는 요청에 따름). 매입 묶음이면 그 B/L에 다른
// 배분(예: 인보이스 한 건이 여러 B/L을 커버해서 같은 Purchase 안에 다른 B/L 배분도 같이 있는
// 경우)이 더 있으면 그것도 함께 지워진다. 매출 묶음이면 Sale 자체를 지우는데, 스키마상 그
// Sale에 걸린 매입배분·관세대납(및 그 회수내역)도 함께 cascade 삭제된다 — 둘 다 화면에서 이
// 사실을 미리 경고한 뒤에만 호출해야 한다.
export async function unbundleGroup(input: {
  ntsSendKeys: string[];
  counterpartCorpNum: string;
  reason: string;
}): Promise<UnbundleGroupResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }
  if (input.ntsSendKeys.length === 0) {
    return { ok: false, message: "대상 승인번호가 없습니다." };
  }
  const reason = input.reason.trim();
  if (!reason) return { ok: false, message: "묶음 풀기 사유를 입력하세요." };

  const attachment = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey: input.ntsSendKeys[0] } });
  if (!attachment?.blNo) {
    return { ok: false, message: "이미 등록이 풀려 있습니다." };
  }
  const oldBlNo = attachment.blNo;
  const direction = attachment.direction as TaxInvoiceDirection;

  if (direction === "sales") {
    // 같은 B/L로 세금계산서별 Sale이 각각 따로 등록됐을 수 있어(묶음 구성원 수만큼) 전부 지운다
    // — findFirst로 하나만 지우면 나머지가 고아로 남아 "묶음 풀기" 후에도 등록된 것처럼 보인다
    // (2026-08-27, 실사용 중 I00043/I00044 묶음에서 실제로 발견된 버그).
    const sales = await prisma.sale.findMany({ where: { blNo: attachment.blNo } });
    if (sales.length > 0) {
      await prisma.sale.deleteMany({ where: { id: { in: sales.map((s) => s.id) } } }); // 매입배분·관세대납·수정이력도 cascade로 함께 삭제됨
    }
  } else {
    const allocs = await prisma.purchaseAllocation.findMany({ where: { blNo: attachment.blNo } });
    const purchaseIds = [...new Set(allocs.map((a) => a.purchaseId))];
    if (purchaseIds.length > 0) {
      await prisma.purchase.deleteMany({ where: { id: { in: purchaseIds } } }); // 배분(PurchaseAllocation)도 cascade로 함께 삭제됨
    } else {
      await prisma.customsAdvance.deleteMany({ where: { blNo: attachment.blNo } });
    }
  }

  // 첨부 파일도 함께 지운다(2026-08-27) — 예전엔 파일은 남기고 B/L만 비웠는데("다시
  // 첨부하지 않아도 되게"), 실제로는 "묶음을 풀면 첨부도 같이 없던 걸로 하자"는 요청.
  // 묶음 구성원끼리 같은 파일명을 공유하므로(saveBundledTaxInvoiceAttachmentPdf) 중복 없이
  // 한 번씩만 지운다.
  const attachmentsInGroup = await prisma.taxInvoiceAttachment.findMany({
    where: { ntsSendKey: { in: input.ntsSendKeys } },
    select: { fileName: true },
  });
  const fileNames = new Set(attachmentsInGroup.map((a) => a.fileName).filter((f) => f));
  await Promise.all([...fileNames].map((f) => deleteUploadedFile(f)));

  await prisma.taxInvoiceAttachment.updateMany({
    where: { ntsSendKey: { in: input.ntsSendKeys } },
    data: { blNo: null, fileName: "", approvedAt: null },
  });

  // B/L 변경·금액 조정과 같은 이력 테이블에 남긴다 — "누가 왜 묶음을 풀었는지"도 나중에
  // 찾아볼 수 있어야 한다. newBlNo를 비워서(→ "(없음)") 수정 이력 목록에서 그대로 "풀렸다"로
  // 읽힌다.
  for (const ntsSendKey of input.ntsSendKeys) {
    await prisma.taxInvoiceEditHistory.create({
      data: { ntsSendKey, previousBlNo: oldBlNo, newBlNo: null, reason, changedByEmail: user.email },
    });
  }

  revalidatePath("/vouchers");
  revalidatePath("/customs");
  revalidatePath("/pnl");
  revalidatePath("/dashboard");

  const statuses = await getAttachmentStatusesLib(
    input.ntsSendKeys.map((ntsSendKey) => ({ ntsSendKey, direction }))
  );
  return { ok: true, statuses };
}

// ===== 승인(=확정)된 세금계산서 수정 =====
//
// 승인은 별도 버튼이 아니라 **확인/승인 팝업의 "승인"이 곧 확정**이다(등록되는 순간
// TaxInvoiceAttachment.approvedAt이 찍힌다). 그래서 여기엔 "확정" 액션이 없고, 승인 이후
// **고칠 때 필요한 것들만** 있다 — 매출·매입 공통이다.

export type TaxInvoiceEditHistoryEntry = {
  previousBlNo: string | null;
  newBlNo: string | null;
  previousFileName: string | null;
  newFileName: string | null;
  previousAmount: number | null;
  newAmount: number | null;
  reason: string;
  changedByEmail: string;
  createdAt: string;
};

export type EditApprovedTaxInvoiceResult =
  | { ok: true; statuses: Record<string, AttachmentStatus> }
  | { ok: false; message: string };

// 승인된 세금계산서의 B/L과 첨부파일을 고친다 — **사유가 반드시 있어야** 하고, 바뀔 때마다
// 수정 전/후 값을 TaxInvoiceEditHistory에 남긴다.
//
// ntsSendKeys는 묶어서 등록된 건이면 묶음 전체를 담아야 한다 — 하나만 바꾸면 같은 B/L을
// 공유해야 하는 구성원들끼리 값이 어긋나 묶음 표시가 깨진다(매출 B/L 수정에서 이미 겪은 문제).
//
// 실제 전표(Sale/Purchase/CustomsAdvance)의 B/L까지 함께 옮긴다 — 첨부의 B/L만 바꾸면
// 화면에는 새 B/L이 보이는데 전표는 옛 B/L에 남아 매칭이 깨진다.
export async function editApprovedTaxInvoice(input: {
  ntsSendKeys: string[];
  direction: TaxInvoiceDirection;
  counterpartCorpNum: string;
  newBlNo: string;
  reason: string;
  file?: { base64: string; originalName: string } | null;
}): Promise<EditApprovedTaxInvoiceResult> {
  const user = await getTaxInvoiceUser();
  if (!user) return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }
  if (input.ntsSendKeys.length === 0) return { ok: false, message: "대상 승인번호가 없습니다." };

  const newBlNo = input.newBlNo.trim();
  const reason = input.reason.trim();
  if (!newBlNo) return { ok: false, message: "B/L 번호를 입력하세요." };
  if (!reason) return { ok: false, message: "수정 사유를 입력하세요." };

  const primary = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey: input.ntsSendKeys[0] } });
  if (!primary) return { ok: false, message: "첨부 정보를 찾을 수 없습니다." };
  if (!primary.approvedAt) return { ok: false, message: "승인된 건만 이 화면에서 수정할 수 있습니다." };

  const oldBlNo = primary.blNo;

  // 파일을 새로 올렸으면 저장한다(선택) — 안 올리면 기존 파일명을 그대로 유지한다.
  let newFileName = primary.fileName;
  if (input.file) {
    const saved =
      input.ntsSendKeys.length > 1
        ? await saveBundledTaxInvoiceAttachmentPdf({
            base64: input.file.base64,
            originalName: input.file.originalName,
            ntsSendKeys: input.ntsSendKeys,
            blNo: newBlNo,
          })
        : await saveTaxInvoiceAttachmentPdf({
            base64: input.file.base64,
            originalName: input.file.originalName,
            ntsSendKey: input.ntsSendKeys[0],
            blNo: newBlNo,
          });
    if (!saved.ok) return { ok: false, message: saved.message };
    newFileName = saved.filename;
  }

  const nothingChanged = newBlNo === oldBlNo && newFileName === primary.fileName;
  if (nothingChanged) return { ok: false, message: "변경된 내용이 없습니다." };

  // 전표 쪽 B/L도 함께 옮긴다(B/L이 바뀐 경우에만).
  if (oldBlNo && newBlNo !== oldBlNo) {
    if (input.direction === "sales") {
      const sale = await prisma.sale.findFirst({ where: { blNo: oldBlNo, ntsSendKey: { not: null } } });
      if (sale) {
        await prisma.sale.update({ where: { id: sale.id }, data: { blNo: newBlNo } });
        await prisma.purchaseAllocation.updateMany({ where: { blNo: newBlNo, saleId: null }, data: { saleId: sale.id } });
        await prisma.customsAdvance.updateMany({ where: { blNo: newBlNo, saleId: null }, data: { saleId: sale.id } });
      }
    } else {
      await prisma.purchaseAllocation.updateMany({ where: { blNo: oldBlNo }, data: { blNo: newBlNo } });
      await prisma.customsAdvance.updateMany({ where: { blNo: oldBlNo }, data: { blNo: newBlNo } });
    }
  }

  await prisma.taxInvoiceAttachment.updateMany({
    where: { ntsSendKey: { in: input.ntsSendKeys } },
    data: { blNo: newBlNo, fileName: newFileName },
  });
  for (const ntsSendKey of input.ntsSendKeys) {
    await prisma.taxInvoiceEditHistory.create({
      data: {
        ntsSendKey,
        previousBlNo: oldBlNo,
        newBlNo,
        previousFileName: primary.fileName || null,
        newFileName: newFileName || null,
        reason,
        changedByEmail: user.email,
      },
    });
  }

  revalidatePath("/vouchers");
  revalidatePath("/customs");
  revalidatePath("/pnl");
  revalidatePath("/dashboard");

  const statuses = await getAttachmentStatusesLib(
    input.ntsSendKeys.map((ntsSendKey) => ({ ntsSendKey, direction: input.direction }))
  );
  return { ok: true, statuses };
}

export async function getTaxInvoiceEditHistory(
  ntsSendKey: string
): Promise<{ ok: true; entries: TaxInvoiceEditHistoryEntry[] } | { ok: false; message: string }> {
  if (!(await hasTaxInvoiceAccess())) return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  const rows = await prisma.taxInvoiceEditHistory.findMany({
    where: { ntsSendKey },
    orderBy: { createdAt: "desc" },
  });
  return {
    ok: true,
    entries: rows.map((r) => ({
      previousBlNo: r.previousBlNo,
      newBlNo: r.newBlNo,
      previousFileName: r.previousFileName,
      newFileName: r.newFileName,
      previousAmount: r.previousAmount,
      newAmount: r.newAmount,
      reason: r.reason,
      changedByEmail: r.changedByEmail,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export type AdjustApprovedTaxInvoiceAmountResult =
  | { ok: true; statuses: Record<string, AttachmentStatus> }
  | { ok: false; message: string };

// 승인된 세금계산서의 "금액 조정" — B/L은 절대 안 바꾸고, 이미 등록된 B/L들의 금액만 고친다
// (2026-08-27 추가). B/L 변경(editApprovedTaxInvoice)과 분리한 이유: 이건 B/L을 매개로
// 하지 않고 곧장 "이 B/L의 금액을 얼마로"만 받아서, B/L도 같이 바뀐 건지 헷갈릴 일이 없다.
// 매출은 B/L별로 각각 별도 Sale이라 그 Sale.amount만 바꾸면 되고, 매입은 PurchaseAllocation
// 금액을 고친 뒤 부모 Purchase.amount를 배분 합계로 다시 맞춘다.
export async function adjustApprovedTaxInvoiceAmount(input: {
  ntsSendKeys: string[];
  direction: TaxInvoiceDirection;
  counterpartCorpNum: string;
  amounts: { blNo: string; amount: number }[];
  reason: string;
}): Promise<AdjustApprovedTaxInvoiceAmountResult> {
  const user = await getTaxInvoiceUser();
  if (!user) return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }
  if (input.ntsSendKeys.length === 0) return { ok: false, message: "대상 승인번호가 없습니다." };

  const reason = input.reason.trim();
  if (!reason) return { ok: false, message: "수정 사유를 입력하세요." };

  const primary = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey: input.ntsSendKeys[0] } });
  if (!primary) return { ok: false, message: "첨부 정보를 찾을 수 없습니다." };
  if (!primary.approvedAt) return { ok: false, message: "승인된 건만 이 화면에서 수정할 수 있습니다." };

  const rows = input.amounts.map((a) => ({ blNo: a.blNo.trim(), amount: a.amount })).filter((a) => a.blNo);
  if (rows.length === 0) return { ok: false, message: "조정할 B/L이 없습니다." };

  let previousTotal = 0;
  let newTotal = 0;

  if (input.direction === "sales") {
    for (const r of rows) {
      const sale = await prisma.sale.findFirst({ where: { blNo: r.blNo } });
      if (!sale) continue;
      previousTotal += sale.amount;
      newTotal += r.amount;
      if (sale.amount !== r.amount) {
        await prisma.sale.update({ where: { id: sale.id }, data: { amount: r.amount } });
      }
    }
  } else {
    const purchaseIds = new Set<string>();
    for (const r of rows) {
      const alloc = await prisma.purchaseAllocation.findFirst({ where: { blNo: r.blNo } });
      if (!alloc) continue;
      previousTotal += alloc.amount;
      newTotal += r.amount;
      if (alloc.amount !== r.amount) {
        await prisma.purchaseAllocation.update({ where: { id: alloc.id }, data: { amount: r.amount } });
      }
      purchaseIds.add(alloc.purchaseId);
    }
    // 배분 하나를 고쳤으면 그 부모 매입 총액(Purchase.amount)도 배분 합계와 다시 맞춰야
    // 어긋나지 않는다 — 대시보드/손익 집계가 Purchase.amount를 그대로 쓰기 때문이다.
    for (const purchaseId of purchaseIds) {
      const allocs = await prisma.purchaseAllocation.findMany({ where: { purchaseId } });
      const total = allocs.reduce((sum, a) => sum + a.amount, 0);
      await prisma.purchase.update({ where: { id: purchaseId }, data: { amount: total } });
    }
  }

  if (rows.every((r) => r.amount === 0) && previousTotal === 0 && newTotal === 0) {
    return { ok: false, message: "조정할 B/L을 찾을 수 없습니다." };
  }
  if (previousTotal === newTotal) return { ok: false, message: "변경된 내용이 없습니다." };

  for (const ntsSendKey of input.ntsSendKeys) {
    await prisma.taxInvoiceEditHistory.create({
      data: {
        ntsSendKey,
        previousAmount: previousTotal,
        newAmount: newTotal,
        reason,
        changedByEmail: user.email,
      },
    });
  }

  revalidatePath("/vouchers");
  revalidatePath("/customs");
  revalidatePath("/pnl");
  revalidatePath("/dashboard");

  const statuses = await getAttachmentStatusesLib(
    input.ntsSendKeys.map((ntsSendKey) => ({ ntsSendKey, direction: input.direction }))
  );
  return { ok: true, statuses };
}

// 목록의 "{B/L} 외 N건"을 눌렀을 때 보여줄 등록 내역. 목록 칸에는 대표 B/L 하나만 보이는데
// 매입 한 건은 여러 B/L에 걸쳐 배분될 수 있어(PurchaseAllocation) 정작 "어느 B/L에 얼마씩
// 들어갔는지"가 화면에 전혀 안 보였다 — 그걸 팝업으로 꺼내 보여준다. 저장하지 않고 매번 다시
// 조회한다(getAttachmentStatuses와 같은 이유: 나중에 매출이 붙으면 연결이 달라진다).
export type RegistrationDetail = {
  kind: "sale" | "purchase" | "customs";
  partyName: string;
  date: string; // "YYYY-MM-DD"
  totalAmount: number;
  note: string;
  // label: 세금계산서에 없는 금액 줄의 명칭(부가세·영세율 등). 세금계산서 대상 줄은 빈 값.
  blRows: { blNo: string; amount: number; saleLinked: boolean; label: string }[];
  // 이 전표에 함께 묶여 등록된 세금계산서들(자기 자신 포함)
  invoices: { ntsSendKey: string; fileName: string }[];
};

export type GetRegistrationDetailResult =
  | { ok: true; detail: RegistrationDetail }
  | { ok: false; message: string };

export async function getRegistrationDetail(input: {
  ntsSendKey: string;
  direction: TaxInvoiceDirection;
  counterpartCorpNum: string;
}): Promise<GetRegistrationDetailResult> {
  const user = await getTaxInvoiceUser();
  if (!user) return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }

  const attachment = await prisma.taxInvoiceAttachment.findUnique({
    where: { ntsSendKey: input.ntsSendKey },
  });
  const blNo = attachment?.blNo ?? null;
  if (!blNo) return { ok: false, message: "아직 등록되지 않은 세금계산서입니다." };

  // 같은 B/L·같은 구분으로 묶인 세금계산서 목록 — 대표행/구성원행 어디서 눌러도 같게 보인다.
  const siblings = await prisma.taxInvoiceAttachment.findMany({
    where: { blNo, direction: input.direction },
    orderBy: { ntsSendKey: "asc" },
    select: { ntsSendKey: true, fileName: true },
  });

  if (input.direction === "sales") {
    // 이 승인번호로 직접 등록된 매출(들) — B/L을 여러 건으로 나눠 등록했으면(2026-08-27) 이
    // 승인번호를 공유하는 Sale이 여러 행일 수 있다. 묶음(registerBundledSale) 구성원
    // 승인번호로 눌렀을 때는 대표만 자기 승인번호로 Sale.ntsSendKey를 갖고 있어 여기선 못
    // 찾으므로, 그때는 attachment의 대표 B/L로 다시 찾는다(기존 방식 그대로 유지).
    let sales = await prisma.sale.findMany({ where: { ntsSendKey: input.ntsSendKey }, include: { party: true } });
    if (sales.length === 0) {
      const bySingleBlNo = await prisma.sale.findFirst({ where: { blNo }, include: { party: true } });
      if (bySingleBlNo) sales = [bySingleBlNo];
    }
    if (sales.length === 0) return { ok: false, message: "연결된 매출을 찾을 수 없습니다." };
    return {
      ok: true,
      detail: {
        kind: "sale",
        partyName: sales[0].party.name,
        date: formatDate(sales[0].date),
        totalAmount: sales.reduce((sum, s) => sum + s.amount, 0),
        note: sales[0].note,
        blRows: sales.map((s) => ({ blNo: s.blNo, amount: s.amount, saleLinked: true, label: "" })),
        invoices: siblings,
      },
    };
  }

  const alloc = await prisma.purchaseAllocation.findFirst({
    where: { blNo },
    include: { purchase: { include: { party: true, allocations: true } } },
  });
  if (alloc) {
    const p = alloc.purchase;
    return {
      ok: true,
      detail: {
        kind: "purchase",
        partyName: p.party.name,
        date: formatDate(p.date),
        totalAmount: p.amount,
        note: p.note,
        blRows: p.allocations.map((x) => ({
          blNo: x.blNo,
          amount: x.amount,
          saleLinked: Boolean(x.saleId),
          label: x.label,
        })),
        invoices: siblings,
      },
    };
  }

  const customs = await prisma.customsAdvance.findFirst({ where: { blNo } });
  if (!customs) return { ok: false, message: "연결된 매입/관세대납을 찾을 수 없습니다." };
  return {
    ok: true,
    detail: {
      kind: "customs",
      partyName: "", // 관세대납은 거래처를 따로 두지 않는다(B/L 기준으로만 관리)
      date: formatDate(customs.paidDate),
      totalAmount: customs.amount,
      note: customs.note,
      // 관세대납은 B/L별로 각각 별도 행이라, 이 첨부와 확실히 묶인 것은 이 1건뿐이다.
      blRows: [{ blNo: customs.blNo, amount: customs.amount, saleLinked: Boolean(customs.saleId), label: "" }],
      invoices: siblings,
    },
  };
}

export type PreviewTaxInvoiceLinkResult = {
  existingLabel: string | null; // 이 B/L으로 이미 등록된 반대쪽(매출↔매입) 거래처·날짜
};

// "매출/매입 등록" 버튼을 실제로 누르기 전에 확인 팝업에 보여줄 정보 — 이 B/L로 이미 등록된
// 반대쪽 거래(매출 등록이면 매입, 매입 등록이면 매출)가 있는지 미리 알려준다. 저장하지 않고
// 매번 다시 조회한다(getAttachmentStatuses와 같은 이유).
export async function previewTaxInvoiceLink(input: {
  direction: TaxInvoiceDirection;
  blNo: string;
}): Promise<PreviewTaxInvoiceLinkResult> {
  if (!(await hasTaxInvoiceAccess())) return { existingLabel: null };
  const blNo = input.blNo.trim();
  if (!blNo) return { existingLabel: null };

  if (input.direction === "purchase") {
    const sale = await prisma.sale.findFirst({ where: { blNo }, include: { party: true } });
    return { existingLabel: sale ? `${sale.party.name} · ${formatDate(sale.date)}` : null };
  }
  const alloc = await prisma.purchaseAllocation.findFirst({
    where: { blNo },
    include: { purchase: { include: { party: true } } },
  });
  return { existingLabel: alloc ? `${alloc.purchase.party.name} · ${formatDate(alloc.purchase.date)}` : null };
}

// 같은 세금계산서(승인번호)로 이미 전표가 있으면 등록을 막는 하드 가드. 화면 표시
// (getAttachmentStatuses)만으로는 부족해서 액션에서 한 번 더 막는다 — 화면이 "미등록"으로
// 보이는 순간이 있으면 그 사이에 등록 액션이 호출될 수 있고, 결과는 같은 매입/매출의
// **이중 계상**이다. 2026-08-19에 프로라인해운 6,129,097원이 실제로 두 번 잡혔다.
// 되돌리려면 "묶음 풀기"로 전표를 지우면 된다 — 그러면 이 가드도 자연히 풀린다.
async function findDuplicateVoucherMessage(ntsSendKeys: string[]): Promise<string | null> {
  const [purchase, sale, customs] = await Promise.all([
    prisma.purchase.findFirst({ where: { ntsSendKey: { in: ntsSendKeys } }, include: { party: true } }),
    prisma.sale.findFirst({ where: { ntsSendKey: { in: ntsSendKeys } }, include: { party: true } }),
    // 관세전표도 확인한다 — 예전에는 CustomsAdvance에 승인번호가 없어서 이 가드가 관세 등록에는
    // 적용되지 않는 구멍이 있었다.
    prisma.customsAdvance.findFirst({
      where: { ntsSendKey: { in: ntsSendKeys } },
      include: { party: true },
    }),
  ]);
  const found = purchase
    ? { kind: "매입전표", party: purchase.party.name, date: purchase.date }
    : sale
      ? { kind: "매출전표", party: sale.party.name, date: sale.date }
      : customs
        ? { kind: "관세전표", party: customs.party?.name ?? customs.blNo, date: customs.paidDate }
        : null;
  if (!found) return null;
  return `이미 ${found.kind}로 등록된 세금계산서가 선택에 포함되어 있습니다 (${found.party} · ${formatDate(found.date)}). 이중 계상을 막기 위해 등록하지 않았습니다 — 다시 등록해야 한다면 기존 전표를 "묶음 풀기"로 먼저 지워주세요.`;
}

type RegisterFromTaxInvoiceCommon = {
  ntsSendKey: string;
  counterpartName: string;
  counterpartCorpNum: string;
  writeDate: string; // "YYYYMMDD"
  note: string; // TaxInvoiceRow.itemName
};

export type RegisterFromTaxInvoiceInput =
  | (RegisterFromTaxInvoiceCommon & {
      direction: "sales";
      // 매출은 원래 Sale=B/L 1건이라 값 하나였지만, 인보이스 한 건이 여러 B/L을 커버하는
      // 경우도 등록할 수 있도록(2026-08-27) 매입과 같은 배열 형태로 받는다 — B/L이 1개뿐이면
      // 배열에 1건만 넣어서 기존과 동일하게 동작한다.
      allocations: { blNo: string; amount: number }[];
    })
  | (RegisterFromTaxInvoiceCommon & {
      direction: "purchase";
      registerAs: "purchase" | "customs"; // 일반전표(매입) 또는 관세전표(관세대납)
      // label: 세금계산서에 없는 금액 줄의 명칭("부가세"/"영세율"/... ). 세금계산서 대상 금액은 빈 값.
      allocations: { blNo: string; amount: number; label?: string }[];
      // 관세전표로 등록할 때만 쓰는 거래처(선택). 일반전표(매입)는 세금계산서 공급자를 그대로
      // 거래처로 쓰므로 이 값이 필요 없다 — 관세대납은 모델에 거래처가 따로 있어서 받는다.
      customsPartyId?: string | null;
    });

export type RegisterFromTaxInvoiceResult =
  | { ok: true; status: AttachmentStatus }
  | { ok: false; message: string };

// 세금계산서 행 자체에 이미 있는 데이터(거래처명·작성일자·품목)와 사용자가 확인한 B/L로 실제
// Sale 또는 Purchase+PurchaseAllocation을 만든다 — "인보이스 첨부"가 매출/매입 등록의
// 시작점이 되도록. createSale/createPurchase(src/app/(app)/sales|purchases/actions.ts)와
// 같은 Prisma 호출을 그대로 재현한다. 매출·매입 모두 인보이스 한 건이 여러 B/L을 커버할 수
// 있어(비고의 "외 N건", 또는 사용자가 직접 "+"로 나눔) 배열로 받는다. Sale 모델 자체는 여전히
// "B/L 1건 = 1행"이라, B/L이 여럿이면 그 개수만큼 Sale을 각각 만든다(2026-08-27 추가).
export async function registerFromTaxInvoice(
  input: RegisterFromTaxInvoiceInput
): Promise<RegisterFromTaxInvoiceResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }
  if (!/^\d{8}$/.test(input.writeDate)) {
    return { ok: false, message: "작성일자 형식이 올바르지 않습니다." };
  }
  const duplicate = await findDuplicateVoucherMessage([input.ntsSendKey]);
  if (duplicate) return { ok: false, message: duplicate };

  try {
    const partyResult = await ensurePartyByName(input.counterpartName);
    if (!partyResult.ok) {
      return { ok: false, message: partyResult.message };
    }
    const date = parseDateInput(
      `${input.writeDate.slice(0, 4)}-${input.writeDate.slice(4, 6)}-${input.writeDate.slice(6, 8)}`
    );

    let primaryBlNo: string;

    if (input.direction === "sales") {
      const allocations = input.allocations
        .map((a) => ({ blNo: a.blNo.trim(), amount: a.amount }))
        .filter((a) => a.blNo);
      if (allocations.length === 0) return { ok: false, message: "B/L 번호를 입력하세요." };
      primaryBlNo = allocations[0].blNo;

      // B/L 하나면 기존과 동일하게 Sale 1건, 여러 개면 B/L마다 별도 Sale을 만든다 — Sale
      // 모델 자체는 여전히 "B/L 1건 = 1행"을 유지한다(전체 프로젝트 규칙 그대로). 이 승인번호
      // (ntsSendKey)로 묶여 있다는 사실만으로 "한 세금계산서에서 나온 매출들"임을 안다
      // (findVoucherByNtsSendKey/getRegistrationDetail이 ntsSendKey로 함께 조회한다).
      // 여러 건을 개별 Prisma 호출로 만들기 때문에(매입처럼 nested create로 한 번에 묶을 부모
      // 레코드가 없다), 트랜잭션으로 감싸서 중간에 하나가 실패해도 일부만 커밋되지 않게 한다.
      await prisma.$transaction(async (tx) => {
        for (const a of allocations) {
          const sale = await tx.sale.create({
            data: {
              blNo: a.blNo,
              date,
              partyId: partyResult.party.id,
              amount: a.amount,
              note: input.note,
              ntsSendKey: input.ntsSendKey,
            },
          });
          // 매입/관세대납이 이 B/L보다 먼저 등록됐을 수 있다 — createSale과 동일한 자동연결.
          await tx.purchaseAllocation.updateMany({
            where: { blNo: a.blNo, saleId: null },
            data: { saleId: sale.id },
          });
          await tx.customsAdvance.updateMany({ where: { blNo: a.blNo, saleId: null }, data: { saleId: sale.id } });
        }
      });
    } else {
      // 미발행 줄은 특정 B/L에 속하지 않아 blNo가 비어 있을 수 있다 — 금액이 0이 아닌 줄은 모두 남긴다.
      const allocations = input.allocations
        .map((a) => ({ blNo: a.blNo.trim(), amount: a.amount, label: (a.label ?? "").trim() }))
        .filter((a) => a.blNo || a.amount !== 0);
      if (allocations.length === 0) return { ok: false, message: "B/L을 1건 이상 입력하세요." };
      const firstWithBl = allocations.find((a) => a.blNo);
      if (!firstWithBl) return { ok: false, message: "B/L을 1건 이상 입력하세요." };
      primaryBlNo = firstWithBl.blNo;

      const blNos = [...new Set(allocations.map((a) => a.blNo))];
      const sales = await prisma.sale.findMany({ where: { blNo: { in: blNos } }, select: { id: true, blNo: true } });
      const saleIdByBlNo = new Map(sales.map((s) => [s.blNo, s.id]));

      if (input.registerAs === "customs") {
        const customsParty = await resolveCustomsPartyId(input.customsPartyId);
        if (!customsParty.ok) return { ok: false, message: customsParty.message };
        // 관세전표 — B/L별로 각각 별도의 CustomsAdvance를 만든다(일반전표와 달리 하나로
        // 묶이는 개념이 없다). 거래처는 B/L마다 나누지 않고 전부 같은 값을 넣는다(세금계산서
        // 1건에서 나온 대납이라 상대는 하나다).
        for (const a of allocations) {
          await prisma.customsAdvance.create({
            data: {
              blNo: a.blNo,
              saleId: saleIdByBlNo.get(a.blNo) ?? null,
              partyId: customsParty.partyId,
              // 지급처(실제로 돈을 받는 곳)는 이 세금계산서의 공급자(partyResult.party)를 그대로
              // 쓴다 — 이 인보이스를 발행한 회사가 곧 우리가 돈을 지급할 대상이다(위에서 고른
              // customsParty는 "회수 대상 고객사"라 서로 다른 개념 — payeePartyId 주석 참고).
              payeePartyId: partyResult.party.id,
              // 어느 세금계산서에서 등록됐는지 남긴다 — 목록의 "등록" 열과 중복등록 가드에 쓴다.
              ntsSendKey: input.ntsSendKey,
              paidDate: date,
              amount: a.amount,
              note: input.note,
            },
          });
        }
      } else {
        const totalAmount = allocations.reduce((sum, a) => sum + a.amount, 0);
        await prisma.purchase.create({
          data: {
            date,
            partyId: partyResult.party.id,
            amount: totalAmount,
            note: input.note,
            ntsSendKey: input.ntsSendKey,
            allocations: {
              create: allocations.map((a) => ({
                blNo: a.blNo,
                saleId: saleIdByBlNo.get(a.blNo) ?? null,
                amount: a.amount,
                label: a.label,
              })),
            },
          },
        });
      }
    }

    // 인보이스를 먼저 첨부하지 않고 B/L만 입력해 바로 등록하는 경우, 이 승인번호의
    // TaxInvoiceAttachment 행이 아직 없을 수 있다 — update 대신 upsert로 그 경우도 만든다.
    await prisma.taxInvoiceAttachment.upsert({
      where: { ntsSendKey: input.ntsSendKey },
      create: {
        ntsSendKey: input.ntsSendKey,
        direction: input.direction,
        blNo: primaryBlNo,
        fileName: "",
        approvedAt: new Date(),
      },
      // 승인 = 확정 — 등록되는 순간 승인 시각을 남긴다(목록에서 초록 음영 + "수정"만 가능).
      update: { blNo: primaryBlNo, approvedAt: new Date() },
    });

    revalidatePath("/vouchers");
    revalidatePath("/customs");
    revalidatePath("/pnl");
    revalidatePath("/dashboard");

    const statuses = await getAttachmentStatusesLib([{ ntsSendKey: input.ntsSendKey, direction: input.direction }]);
    const fallbackKind = input.direction === "sales" ? "sale" : input.registerAs === "customs" ? "customs" : "purchase";
    return {
      ok: true,
      status: statuses[input.ntsSendKey] ?? {
        blNo: primaryBlNo,
        fileName: "",
        matched: true,
        matchedKind: fallbackKind,
        matchedLabel: null,
        bundledCount: 0,
        saleId: null,
        saleConfirmedAt: null,
      },
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "등록 중 오류가 발생했습니다." };
  }
}

export type RegisterBundledPurchaseInput = {
  ntsSendKeys: string[]; // 묶어서 등록할 세금계산서들의 승인번호(2건 이상)
  registerAs: "purchase" | "customs"; // 일반전표(매입) 또는 관세전표(관세대납)
  allocations: { blNo: string; amount: number; label?: string }[];
  counterpartName: string;
  counterpartCorpNum: string;
  writeDate: string; // "YYYYMMDD"
  note: string;
  file?: { base64: string; originalName: string } | null; // 묶음 전체에 공통으로 붙일 인보이스(선택)
  customsPartyId?: string | null; // 관세전표로 등록할 때만 쓰는 거래처(선택)
};

export type RegisterBundledPurchaseResult =
  | { ok: true; statuses: Record<string, AttachmentStatus> }
  | { ok: false; message: string };

// 여러 세금계산서(예: 같은 지출결의서에서 나온 OCEAN FREIGHT + DRAYAGE CHG)를 하나의
// Purchase로 묶어 등록한다. 합계금액(부가세 포함) 대신 공급가액 합계를 기준으로 배분을
// 검증한다 — 개별(단일) 등록은 지금처럼 합계금액 기준을 그대로 유지하고, 이 묶음 등록만
// 공급가액 기준을 쓴다(사용자 확인됨). 등록 후 선택된 승인번호 전부의 TaxInvoiceAttachment를
// 같은 대표 B/L로 갱신해, 화면에서 모두 "매입 연결됨"으로 보이게 한다.
export async function registerBundledPurchase(
  input: RegisterBundledPurchaseInput
): Promise<RegisterBundledPurchaseResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }
  if (input.ntsSendKeys.length < 2) {
    return { ok: false, message: "묶어서 등록하려면 2건 이상 선택하세요." };
  }
  if (!/^\d{8}$/.test(input.writeDate)) {
    return { ok: false, message: "작성일자 형식이 올바르지 않습니다." };
  }
  const duplicate = await findDuplicateVoucherMessage(input.ntsSendKeys);
  if (duplicate) return { ok: false, message: duplicate };

  const allocations = input.allocations
    .map((a) => ({ blNo: a.blNo.trim(), amount: a.amount, label: (a.label ?? "").trim() }))
    .filter((a) => a.blNo || a.amount !== 0);
  if (allocations.length === 0 || !allocations.some((a) => a.blNo)) {
    return { ok: false, message: "B/L을 1건 이상 입력하세요." };
  }

  try {
    const partyResult = await ensurePartyByName(input.counterpartName);
    if (!partyResult.ok) {
      return { ok: false, message: partyResult.message };
    }
    const date = parseDateInput(
      `${input.writeDate.slice(0, 4)}-${input.writeDate.slice(4, 6)}-${input.writeDate.slice(6, 8)}`
    );

    const primaryBlNo = allocations[0].blNo;
    const blNos = [...new Set(allocations.map((a) => a.blNo))];
    const sales = await prisma.sale.findMany({ where: { blNo: { in: blNos } }, select: { id: true, blNo: true } });
    const saleIdByBlNo = new Map(sales.map((s) => [s.blNo, s.id]));

    if (input.registerAs === "customs") {
      const customsParty = await resolveCustomsPartyId(input.customsPartyId);
      if (!customsParty.ok) return { ok: false, message: customsParty.message };
      for (const a of allocations) {
        await prisma.customsAdvance.create({
          data: {
            blNo: a.blNo,
            saleId: saleIdByBlNo.get(a.blNo) ?? null,
            partyId: customsParty.partyId,
            // 묶음이면 대표 1건의 승인번호를 남긴다(Purchase와 같은 규칙).
            ntsSendKey: input.ntsSendKeys[0],
            paidDate: date,
            amount: a.amount,
            note: input.note,
          },
        });
      }
    } else {
      const totalAmount = allocations.reduce((sum, a) => sum + a.amount, 0);
      await prisma.purchase.create({
        data: {
          date,
          partyId: partyResult.party.id,
          amount: totalAmount,
          note: input.note,
          ntsSendKey: input.ntsSendKeys[0],
          allocations: {
            create: allocations.map((a) => ({
              blNo: a.blNo,
              saleId: saleIdByBlNo.get(a.blNo) ?? null,
              amount: a.amount,
              label: a.label,
            })),
          },
        },
      });
    }

    // 묶음 전체에 공통으로 붙는 인보이스(예: 지출결의서)가 있으면 한 번만 저장하고, 선택한
    // 세금계산서 전부에 같은 파일명을 연결한다.
    let bundledFileName: string | null = null;
    if (input.file) {
      const saved = await saveBundledTaxInvoiceAttachmentPdf({
        base64: input.file.base64,
        originalName: input.file.originalName,
        ntsSendKeys: input.ntsSendKeys,
        blNo: primaryBlNo,
      });
      if (!saved.ok) return { ok: false, message: saved.message };
      bundledFileName = saved.filename;
    }

    for (const ntsSendKey of input.ntsSendKeys) {
      const existing = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey } });
      const fileName = bundledFileName ?? existing?.fileName ?? "";
      await prisma.taxInvoiceAttachment.upsert({
        where: { ntsSendKey },
        create: { ntsSendKey, direction: "purchase", blNo: primaryBlNo, fileName, approvedAt: new Date() },
        update: { blNo: primaryBlNo, fileName, approvedAt: new Date() },
      });
    }

    revalidatePath("/vouchers");
    revalidatePath("/customs");
    revalidatePath("/pnl");
    revalidatePath("/dashboard");

    const statuses = await getAttachmentStatusesLib(
      input.ntsSendKeys.map((ntsSendKey) => ({ ntsSendKey, direction: "purchase" as const }))
    );
    return { ok: true, statuses };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "등록 중 오류가 발생했습니다." };
  }
}

export type RegisterBundledSaleInput = {
  ntsSendKeys: string[]; // 묶어서 등록할 세금계산서들의 승인번호(2건 이상)
  blNo: string;
  amount: number; // 공급가액 합계
  counterpartName: string;
  counterpartCorpNum: string;
  writeDate: string; // "YYYYMMDD"
  note: string;
  file?: { base64: string; originalName: string } | null; // 묶음 전체에 공통으로 붙일 인보이스(선택)
};

export type RegisterBundledSaleResult =
  | { ok: true; statuses: Record<string, AttachmentStatus> }
  | { ok: false; message: string };

// 매입처럼 한 거래처가 같은 화물 건을 품목별로 나눠 여러 장의 매출 세금계산서로 끊는
// 경우가 있어(예: 운임 세금계산서 + 취급수수료 세금계산서가 같은 B/L 한 건을 커버), 그런
// 경우를 위한 매출판 묶어서 등록. `Sale`은 원래 B/L 1건 = 1행이라 매입처럼 여러 B/L로
// 나눠 배분할 필요는 없다 — 선택한 세금계산서들의 공급가액을 합쳐서 B/L 1개짜리 `Sale`
// 하나만 만든다. 등록 후 선택된 승인번호 전부의 TaxInvoiceAttachment를 같은 대표 B/L로
// 갱신해, 화면에서 모두 "매출연결"로 묶여 보이게 한다.
export async function registerBundledSale(input: RegisterBundledSaleInput): Promise<RegisterBundledSaleResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!(await hasCorpNumAccess(user, input.counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }
  if (input.ntsSendKeys.length < 2) {
    return { ok: false, message: "묶어서 등록하려면 2건 이상 선택하세요." };
  }
  if (!/^\d{8}$/.test(input.writeDate)) {
    return { ok: false, message: "작성일자 형식이 올바르지 않습니다." };
  }
  const blNo = input.blNo.trim();
  if (!blNo) {
    return { ok: false, message: "B/L 번호를 입력하세요." };
  }
  const duplicate = await findDuplicateVoucherMessage(input.ntsSendKeys);
  if (duplicate) return { ok: false, message: duplicate };

  try {
    const partyResult = await ensurePartyByName(input.counterpartName);
    if (!partyResult.ok) {
      return { ok: false, message: partyResult.message };
    }
    const date = parseDateInput(
      `${input.writeDate.slice(0, 4)}-${input.writeDate.slice(4, 6)}-${input.writeDate.slice(6, 8)}`
    );

    const sale = await prisma.sale.create({
      data: {
        blNo,
        date,
        partyId: partyResult.party.id,
        amount: input.amount,
        note: input.note,
        ntsSendKey: input.ntsSendKeys[0],
      },
    });
    // 매입/관세대납이 이 B/L보다 먼저 등록됐을 수 있다 — createSale과 동일한 자동연결.
    await prisma.purchaseAllocation.updateMany({ where: { blNo, saleId: null }, data: { saleId: sale.id } });
    await prisma.customsAdvance.updateMany({ where: { blNo, saleId: null }, data: { saleId: sale.id } });

    // 묶음 전체에 공통으로 붙는 인보이스가 있으면 한 번만 저장하고, 선택한 세금계산서 전부에
    // 같은 파일명을 연결한다.
    let bundledFileName: string | null = null;
    if (input.file) {
      const saved = await saveBundledTaxInvoiceAttachmentPdf({
        base64: input.file.base64,
        originalName: input.file.originalName,
        ntsSendKeys: input.ntsSendKeys,
        blNo,
      });
      if (!saved.ok) return { ok: false, message: saved.message };
      bundledFileName = saved.filename;
    }

    for (const ntsSendKey of input.ntsSendKeys) {
      const existing = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey } });
      const fileName = bundledFileName ?? existing?.fileName ?? "";
      await prisma.taxInvoiceAttachment.upsert({
        where: { ntsSendKey },
        create: { ntsSendKey, direction: "sales", blNo, fileName, approvedAt: new Date() },
        update: { blNo, fileName, approvedAt: new Date() },
      });
    }

    revalidatePath("/vouchers");
    revalidatePath("/customs");
    revalidatePath("/pnl");
    revalidatePath("/dashboard");

    const statuses = await getAttachmentStatusesLib(
      input.ntsSendKeys.map((ntsSendKey) => ({ ntsSendKey, direction: "sales" as const }))
    );
    return { ok: true, statuses };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "등록 중 오류가 발생했습니다." };
  }
}

export type GetPrintUrlResult = { ok: true; url: string } | { ok: false; message: string };

export async function getPrintUrl(ntsSendKey: string, counterpartCorpNum: string): Promise<GetPrintUrlResult> {
  const user = await getTaxInvoiceUser();
  if (!user) {
    return { ok: false, message: "세금계산서 열람 권한이 없습니다." };
  }
  if (!(await hasCorpNumAccess(user, counterpartCorpNum))) {
    return { ok: false, message: "이 거래처의 세금계산서에 대한 권한이 없습니다." };
  }

  try {
    const url = await getTaxInvoicePrintUrl(ntsSendKey);
    return { ok: true, url };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "원문 URL을 가져오지 못했습니다." };
  }
}
