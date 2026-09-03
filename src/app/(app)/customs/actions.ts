"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { parseDateInput } from "@/lib/format";
import type { DeleteActionResult } from "@/components/DeleteButton";
import { extractCustomsInvoice, type ExtractedCustomsInvoice, type ExtractResult } from "@/lib/invoiceExtract";
import { getCurrentUserFresh } from "@/lib/session";
import {
  getAllocationsByTargets,
  getFxAdjustmentsByTargets,
  sumAllocated,
  sumFxAdjusted,
  isFullyAllocated,
  searchMatchCandidates as searchMatchCandidatesLib,
  createManualAllocation as createManualAllocationLib,
  deleteAllocation as deleteAllocationLib,
  createFxAdjustment as createFxAdjustmentLib,
  deleteFxAdjustment as deleteFxAdjustmentLib,
  type MatchCandidate,
} from "@/lib/bankAllocation";

// proxy.ts는 "로그인 됐는가"만 확인하므로, 관세전표 열람 권한은 Server Action 안에서도
// 다시 확인한다(세금계산서 쪽 getTaxInvoiceUser와 같은 이유). resolveCustomsPartyId는 여기
// 포함하지 않는다 — tax-invoices/actions.ts에서도 그대로 가져다 쓰는 내부 헬퍼라, 여기서
// canViewCustoms를 강제하면 세금계산서 화면에서 "관세전표"로 등록하는 흐름이 깨진다.
async function requireCustomsAccess() {
  const user = await getCurrentUserFresh();
  if (!user?.canViewCustoms) throw new Error("관세전표 열람 권한이 없습니다.");
  return user;
}

export async function extractCustomsInvoicePdf(
  base64: string
): Promise<ExtractResult<ExtractedCustomsInvoice>> {
  await requireCustomsAccess();
  try {
    return { ok: true, data: await extractCustomsInvoice(base64) };
  } catch {
    return { ok: false, message: "PDF에서 정보를 추출하지 못했습니다. 값을 직접 입력해주세요." };
  }
}

function revalidateAll() {
  revalidatePath("/customs");
}

export type CustomsAdvanceInput = {
  blNo: string;
  paidDate: string;
  // KRW면 이 값을 그대로 쓰고, 외화면 fxAmount*fxRate를 서버에서 다시 계산해 덮어쓴다(화면
  // 값을 신뢰하지 않는다 — 금액 계산은 항상 서버가 최종 확정).
  amount: number;
  currency: string; // "KRW" | "USD" | "JPY" | ... — 항상 필수, 기본값은 화면에서 "KRW"
  fxAmount?: number | null; // currency가 KRW가 아니면 필수(외화 금액)
  fxRate?: number | null; // currency가 KRW가 아니면 필수(적용 환율, 외화 1단위당 원화)
  note: string;
  partyId?: string | null; // 선택 — 거래처 마스터에 이미 있는 거래처만 지정할 수 있다
  payeePartyId?: string | null; // 선택 — 실제로 돈을 지급받는 대상(관세사·포워더 등, partyId와 다를 수 있다)
};
export type CustomsAdvanceActionResult = { ok: true } | { ok: false; message: string };

// 관세전표의 거래처는 **거래처 마스터에 이미 있는 것만** 허용한다. 화면에서 검색으로만 고르게
// 해뒀지만 Server Action은 직접 호출될 수 있으니 여기서도 존재 여부를 확인한다 — 없는 id가
// 들어오면 외래키 오류로 터지는 대신 사람이 읽을 수 있는 메시지로 돌려준다.
export async function resolveCustomsPartyId(
  partyId: string | null | undefined
): Promise<{ ok: true; partyId: string | null } | { ok: false; message: string }> {
  const id = (partyId ?? "").trim();
  if (!id) return { ok: true, partyId: null };
  const party = await prisma.party.findUnique({ where: { id }, select: { id: true } });
  if (!party) {
    return { ok: false, message: "거래처를 찾을 수 없습니다 — 거래처 화면에서 먼저 등록해주세요." };
  }
  return { ok: true, partyId: party.id };
}

// blNo가 진짜 식별자다 — 그 번호의 매출이 아직 없어도 등록할 수 있고(saleId=null), 나중에
// 그 B/L로 매출이 등록되면 자동으로 연결된다(createSale 참고).
export async function createCustomsAdvance(input: CustomsAdvanceInput): Promise<CustomsAdvanceActionResult> {
  await requireCustomsAccess();
  const blNo = input.blNo.trim();
  const currency = (input.currency || "KRW").trim().toUpperCase();
  if (!blNo || !input.paidDate) {
    return { ok: false, message: "필수 항목을 모두 입력하세요." };
  }

  // 원화 환산액은 항상 서버에서 계산한다 — 외화×환율은 클라이언트가 미리 곱해서 보내도
  // 반올림 방식이 다르면 어긋날 수 있어, 화면 값을 그대로 믿지 않고 여기서 다시 확정한다.
  let amount: number;
  let fxAmount: number | null = null;
  let fxRate: number | null = null;
  if (currency === "KRW") {
    if (!Number.isFinite(input.amount)) return { ok: false, message: "필수 항목을 모두 입력하세요." };
    amount = input.amount;
  } else {
    if (!Number.isFinite(input.fxAmount) || !Number.isFinite(input.fxRate)) {
      return { ok: false, message: "외화 금액과 적용 환율을 입력하세요." };
    }
    fxAmount = input.fxAmount!;
    fxRate = input.fxRate!;
    amount = Math.round(fxAmount * fxRate);
  }

  const party = await resolveCustomsPartyId(input.partyId);
  if (!party.ok) return { ok: false, message: party.message };
  const payeeParty = await resolveCustomsPartyId(input.payeePartyId);
  if (!payeeParty.ok) return { ok: false, message: payeeParty.message };

  const sale = await prisma.sale.findFirst({ where: { blNo } });

  await prisma.customsAdvance.create({
    data: {
      blNo,
      saleId: sale?.id ?? null,
      partyId: party.partyId,
      payeePartyId: payeeParty.partyId,
      paidDate: parseDateInput(input.paidDate),
      amount,
      currency,
      fxAmount,
      fxRate,
      note: input.note,
    },
  });

  revalidateAll();
  return { ok: true };
}

// 이미 등록된 관세전표의 지급처만 나중에 지정/변경한다 — 세금계산서에서 등록된 옛 건(지급처가
// 아직 없는 건)이나, 수기 등록 시 비워둔 건을 채우기 위함이다. 삭제 후 재등록하면 회수(recovery)
// 기록과 B/L 연결이 같이 사라지므로 그러지 않고 이 필드만 바꾼다.
export async function setCustomsAdvancePayee(
  id: string,
  payeePartyId: string | null
): Promise<CustomsAdvanceActionResult> {
  await requireCustomsAccess();
  const payeeParty = await resolveCustomsPartyId(payeePartyId);
  if (!payeeParty.ok) return { ok: false, message: payeeParty.message };

  await prisma.customsAdvance.update({
    where: { id },
    data: { payeePartyId: payeeParty.partyId },
  });

  revalidateAll();
  return { ok: true };
}

export async function deleteCustomsAdvance(formData: FormData): Promise<DeleteActionResult> {
  await requireCustomsAccess();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  const existing = await prisma.customsAdvance.findUnique({ where: { id }, select: { settlementConfirmedAt: true } });
  if (existing?.settlementConfirmedAt) return { ok: false, reason: "confirmed" };

  await prisma.customsAdvance.delete({ where: { id } });
  revalidateAll();
  return { ok: true };
}

// ── 출금(대납 지급) 매칭·확정 — 일반전표와 같은 규칙이지만, 요청/승인 흐름은 이번 범위 밖이라
// 관리자만 직접 해제할 수 있다(2026-08-31, 회수(입금) 쪽은 저장되는 배분 대상이 아니다).
export type CustomsVoucherActionResult = { ok: true } | { ok: false; message: string };

export async function confirmCustomsAdvance(id: string): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  const advance = await prisma.customsAdvance.findUnique({ where: { id }, select: { amount: true } });
  if (!advance) return { ok: false, message: "대상을 찾을 수 없습니다." };

  const allocated =
    sumAllocated((await getAllocationsByTargets("customsAdvance", [id])).get(id)) +
    sumFxAdjusted((await getFxAdjustmentsByTargets("customsAdvance", [id])).get(id));
  if (!isFullyAllocated(advance.amount, allocated)) {
    return { ok: false, message: "출금 배분이 100% 완료되지 않아 확정할 수 없습니다." };
  }

  await prisma.customsAdvance.update({
    where: { id },
    data: { settlementConfirmedAt: new Date(), settlementConfirmedByEmail: user.email },
  });
  revalidateAll();
  return { ok: true };
}

export async function unconfirmCustomsAdvance(id: string, reason: string): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  if (user.role !== "admin") return { ok: false, message: "관리자만 확정을 해제할 수 있습니다." };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, message: "확정 해제 사유를 입력하세요." };

  await prisma.customsAdvance.update({
    where: { id },
    data: { settlementConfirmedAt: null, settlementConfirmedByEmail: null },
  });
  revalidateAll();
  return { ok: true };
}

export async function searchCustomsMatchCandidates(partyId: string | null, search: string): Promise<MatchCandidate[]> {
  await requireCustomsAccess();
  return searchMatchCandidatesLib("withdraw", { partyId, search });
}

export async function createCustomsAllocation(
  id: string,
  transRefKey: string,
  amount: number
): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  const result = await createManualAllocationLib("customsAdvance", id, transRefKey, amount, user.email);
  if (result.ok) revalidateAll();
  return result;
}

export async function deleteCustomsAllocation(allocationId: string): Promise<CustomsVoucherActionResult> {
  await requireCustomsAccess();
  const result = await deleteAllocationLib(allocationId);
  if (result.ok) revalidateAll();
  return result;
}

// 외화(달러/엔화 등)로 입력한 관세대납의 남은 미배분 잔액을 은행거래 없이 환차손익으로
// 정리한다 — VoucherTable의 같은 기능과 같은 이유(bankAllocation.ts createFxAdjustment 참고).
export async function createCustomsFxAdjustment(id: string, note: string): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  const result = await createFxAdjustmentLib("customsAdvance", id, note, user.email);
  if (result.ok) revalidateAll();
  return result;
}

export async function deleteCustomsFxAdjustment(adjustmentId: string): Promise<CustomsVoucherActionResult> {
  await requireCustomsAccess();
  const result = await deleteFxAdjustmentLib(adjustmentId);
  if (result.ok) revalidateAll();
  return result;
}

// ── 입금(회수) 매칭·확정 — 출금과 완전히 독립된 별도 흐름이다(2026-09-03 추가). 같은
// CustomsAdvance 행이지만 kind는 "customsAdvanceRecovery", 확정 필드는 depositConfirmedAt이라
// 출금 쪽 확정 여부와 무관하게 따로 배분·확정할 수 있다.
export async function confirmCustomsRecovery(id: string): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  const advance = await prisma.customsAdvance.findUnique({ where: { id }, select: { amount: true } });
  if (!advance) return { ok: false, message: "대상을 찾을 수 없습니다." };

  const allocated =
    sumAllocated((await getAllocationsByTargets("customsAdvanceRecovery", [id])).get(id)) +
    sumFxAdjusted((await getFxAdjustmentsByTargets("customsAdvanceRecovery", [id])).get(id));
  if (!isFullyAllocated(advance.amount, allocated)) {
    return { ok: false, message: "입금 배분이 100% 완료되지 않아 확정할 수 없습니다." };
  }

  await prisma.customsAdvance.update({
    where: { id },
    data: { depositConfirmedAt: new Date(), depositConfirmedByEmail: user.email },
  });
  revalidateAll();
  return { ok: true };
}

export async function unconfirmCustomsRecovery(id: string, reason: string): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  if (user.role !== "admin") return { ok: false, message: "관리자만 확정을 해제할 수 있습니다." };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, message: "확정 해제 사유를 입력하세요." };

  await prisma.customsAdvance.update({
    where: { id },
    data: { depositConfirmedAt: null, depositConfirmedByEmail: null },
  });
  revalidateAll();
  return { ok: true };
}

export async function searchCustomsRecoveryMatchCandidates(
  partyId: string | null,
  search: string
): Promise<MatchCandidate[]> {
  await requireCustomsAccess();
  return searchMatchCandidatesLib("deposit", { partyId, search });
}

export async function createCustomsRecoveryAllocation(
  id: string,
  transRefKey: string,
  amount: number
): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  const result = await createManualAllocationLib("customsAdvanceRecovery", id, transRefKey, amount, user.email);
  if (result.ok) revalidateAll();
  return result;
}

export async function deleteCustomsRecoveryAllocation(allocationId: string): Promise<CustomsVoucherActionResult> {
  await requireCustomsAccess();
  const result = await deleteAllocationLib(allocationId);
  if (result.ok) revalidateAll();
  return result;
}

export async function createCustomsRecoveryFxAdjustment(id: string, note: string): Promise<CustomsVoucherActionResult> {
  const user = await requireCustomsAccess();
  const result = await createFxAdjustmentLib("customsAdvanceRecovery", id, note, user.email);
  if (result.ok) revalidateAll();
  return result;
}

export async function deleteCustomsRecoveryFxAdjustment(adjustmentId: string): Promise<CustomsVoucherActionResult> {
  await requireCustomsAccess();
  const result = await deleteFxAdjustmentLib(adjustmentId);
  if (result.ok) revalidateAll();
  return result;
}

export async function addRecovery(formData: FormData) {
  await requireCustomsAccess();
  const customsAdvanceId = String(formData.get("customsAdvanceId") ?? "");
  const dateStr = String(formData.get("date") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const note = String(formData.get("note") ?? "").trim();

  if (!customsAdvanceId || !dateStr || !Number.isFinite(amount)) return;

  await prisma.customsRecovery.create({
    data: { customsAdvanceId, date: parseDateInput(dateStr), amount, note },
  });

  revalidateAll();
}

export async function deleteRecovery(formData: FormData): Promise<DeleteActionResult> {
  await requireCustomsAccess();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  await prisma.customsRecovery.delete({ where: { id } });
  revalidateAll();
  return { ok: true };
}
