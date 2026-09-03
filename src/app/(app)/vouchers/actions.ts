"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
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
  directionForKind,
  type MatchCandidate,
} from "@/lib/bankAllocation";

// proxy.ts는 "로그인 됐는가"만 확인하므로, 일반전표 열람 권한은 Server Action 안에서도
// 다시 확인한다(관세전표·거래처 쪽과 같은 이유).
async function requireVouchersAccess() {
  const user = await getCurrentUserFresh();
  if (!user?.canViewVouchers) throw new Error("일반전표 열람 권한이 없습니다.");
  return user;
}

function revalidateAll() {
  revalidatePath("/vouchers");
}

// 매입은 2026-08-31부터 Purchase 전체가 아니라 B/L 배분(PurchaseAllocation) 단위로 확정한다 —
// 매입 한 건이 여러 B/L로 나뉘면 일부만 먼저 입출금 완료되는 경우를 표현하기 위함이다.
export type VoucherKind = "sale" | "purchaseAllocation";
export type VoucherActionResult = { ok: true } | { ok: false; message: string };

// 실제로 확정 표시를 지운다 — 관리자 직접 해제(unconfirmVoucher)와 요청 승인
// (approveUnconfirmRequest) 양쪽에서 같은 처리를 쓴다.
async function clearConfirmation(kind: VoucherKind, id: string): Promise<void> {
  if (kind === "sale") {
    await prisma.sale.update({
      where: { id },
      data: { settlementConfirmedAt: null, settlementConfirmedByEmail: null },
    });
  } else {
    await prisma.purchaseAllocation.update({
      where: { id },
      data: { settlementConfirmedAt: null, settlementConfirmedByEmail: null },
    });
  }
}

// 입금/출금 완료(1단계)를 사람이 최종 검토해서 확정(2단계)으로 넘긴다 — 일반전표 열람 권한이
// 있으면 누구나 할 수 있다. **100% 배분(매칭) 완료된 건만** 확정할 수 있다(2026-08-31) —
// 부분 배분 상태에서 확정하면 나머지 배분이 어느 대상 몫인지 알 수 없게 된다. 확정된 건은
// 관리자가 해제하기 전까지 수정·삭제할 수 없다.
export async function confirmVoucher(kind: VoucherKind, id: string): Promise<VoucherActionResult> {
  const user = await requireVouchersAccess();

  const amount =
    kind === "sale"
      ? (await prisma.sale.findUnique({ where: { id }, select: { amount: true } }))?.amount
      : (await prisma.purchaseAllocation.findUnique({ where: { id }, select: { amount: true } }))?.amount;
  if (amount == null) return { ok: false, message: "대상을 찾을 수 없습니다." };

  const allocated =
    sumAllocated((await getAllocationsByTargets(kind, [id])).get(id)) +
    sumFxAdjusted((await getFxAdjustmentsByTargets(kind, [id])).get(id));
  if (!isFullyAllocated(amount, allocated)) {
    return { ok: false, message: "입출금 배분이 100% 완료되지 않아 확정할 수 없습니다." };
  }

  const now = new Date();
  if (kind === "sale") {
    await prisma.sale.update({
      where: { id },
      data: { settlementConfirmedAt: now, settlementConfirmedByEmail: user.email },
    });
  } else {
    await prisma.purchaseAllocation.update({
      where: { id },
      data: { settlementConfirmedAt: now, settlementConfirmedByEmail: user.email },
    });
  }
  await prisma.voucherConfirmHistory.create({
    data: { kind, voucherId: id, action: "confirm", byEmail: user.email },
  });
  revalidateAll();
  return { ok: true };
}

// 수기 매칭 팝업의 후보 목록.
export async function searchMatchCandidates(
  kind: VoucherKind,
  partyId: string | null,
  search: string
): Promise<MatchCandidate[]> {
  await requireVouchersAccess();
  return searchMatchCandidatesLib(directionForKind(kind), { partyId, search });
}

// 은행거래 하나(transRefKey)를 이 전표(kind+id)에 금액만큼 배분한다.
export async function createManualAllocation(
  kind: VoucherKind,
  id: string,
  transRefKey: string,
  amount: number
): Promise<VoucherActionResult> {
  const user = await requireVouchersAccess();
  const result = await createManualAllocationLib(kind, id, transRefKey, amount, user.email);
  if (result.ok) revalidateAll();
  return result;
}

// 배분 1건을 취소한다(실수로 잘못 배분했을 때) — 이미 확정된 건은 먼저 해제해야 한다.
export async function deleteAllocation(allocationId: string): Promise<VoucherActionResult> {
  await requireVouchersAccess();
  const result = await deleteAllocationLib(allocationId);
  if (result.ok) revalidateAll();
  return result;
}

// 외화 전표의 남은 미배분 잔액(입력 시점 환율 vs 실제 결제 환율 차이)을 은행거래 없이
// 환차손익으로 정리한다 — KRW 전표에는 쓸 수 없다(createFxAdjustmentLib이 막는다).
export async function createFxAdjustment(kind: VoucherKind, id: string, note: string): Promise<VoucherActionResult> {
  const user = await requireVouchersAccess();
  const result = await createFxAdjustmentLib(kind, id, note, user.email);
  if (result.ok) revalidateAll();
  return result;
}

export async function deleteFxAdjustment(adjustmentId: string): Promise<VoucherActionResult> {
  await requireVouchersAccess();
  const result = await deleteFxAdjustmentLib(adjustmentId);
  if (result.ok) revalidateAll();
  return result;
}

// 확정을 해제한다 — 관리자만 할 수 있다("수정이 필요하면 관리자 승인을 받는다"는 요구를
// "관리자가 해제해야 다시 수정 가능"으로 구현했다). 사유를 반드시 남긴다 — 다른 되돌림
// 동작들(묶음 풀기 등)과 같은 이유로, 왜 확정을 풀었는지 나중에 추적할 수 있어야 한다.
export async function unconfirmVoucher(
  kind: VoucherKind,
  id: string,
  reason: string
): Promise<VoucherActionResult> {
  const user = await requireVouchersAccess();
  if (user.role !== "admin") return { ok: false, message: "관리자만 확정을 해제할 수 있습니다." };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, message: "확정 해제 사유를 입력하세요." };

  await clearConfirmation(kind, id);
  await prisma.voucherConfirmHistory.create({
    data: { kind, voucherId: id, action: "unconfirm", byEmail: user.email, reason: trimmed },
  });
  revalidateAll();
  return { ok: true };
}

export type UnconfirmRequestInfo = {
  id: string;
  reason: string;
  requestedByEmail: string;
  createdAt: string;
};

// 관리자가 아닌 사용자는 확정을 직접 풀 수 없다 — 대신 사유를 남겨 해제를 "요청"하고,
// 관리자가 승인해야 실제로 풀린다("수정이 필요하면 관리자 승인을 받는다"는 요구를 이번엔
// 요청/승인 흐름으로 구현했다, 2026-08-31). 한 전표에 대기 중인 요청은 하나만 허용한다 —
// 여러 번 눌러도 중복 요청이 쌓이지 않게.
export async function requestUnconfirm(
  kind: VoucherKind,
  id: string,
  reason: string
): Promise<VoucherActionResult> {
  const user = await requireVouchersAccess();
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, message: "확정 해제 요청 사유를 입력하세요." };

  const existing = await prisma.voucherUnconfirmRequest.findFirst({
    where: { kind, voucherId: id, status: "pending" },
  });
  if (existing) return { ok: false, message: "이미 대기 중인 확정 해제 요청이 있습니다." };

  await prisma.voucherUnconfirmRequest.create({
    data: { kind, voucherId: id, reason: trimmed, requestedByEmail: user.email },
  });
  revalidateAll();
  return { ok: true };
}

// 요청을 승인한다 — 관리자만. 실제 해제(clearConfirmation)까지 이 시점에 이뤄진다.
export async function approveUnconfirmRequest(requestId: string): Promise<VoucherActionResult> {
  const user = await requireVouchersAccess();
  if (user.role !== "admin") return { ok: false, message: "관리자만 승인할 수 있습니다." };

  const request = await prisma.voucherUnconfirmRequest.findUnique({ where: { id: requestId } });
  if (!request) return { ok: false, message: "요청을 찾을 수 없습니다." };
  if (request.status !== "pending") return { ok: false, message: "이미 처리된 요청입니다." };

  await clearConfirmation(request.kind as VoucherKind, request.voucherId);
  await prisma.voucherUnconfirmRequest.update({
    where: { id: requestId },
    data: { status: "approved", decidedByEmail: user.email, decidedAt: new Date() },
  });
  await prisma.voucherConfirmHistory.create({
    data: {
      kind: request.kind,
      voucherId: request.voucherId,
      action: "unconfirm",
      byEmail: user.email,
      reason: `[요청자: ${request.requestedByEmail}] ${request.reason}`,
    },
  });
  revalidateAll();
  return { ok: true };
}

// 요청을 거절한다 — 관리자만. 전표는 확정 상태 그대로 남는다. 사유를 반드시 남긴다 —
// 요청한 사람이 왜 거절됐는지 알아야 다시 요청할지 판단할 수 있다(2026-08-31).
export async function rejectUnconfirmRequest(requestId: string, note: string): Promise<VoucherActionResult> {
  const user = await requireVouchersAccess();
  if (user.role !== "admin") return { ok: false, message: "관리자만 거절할 수 있습니다." };
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, message: "거절 사유를 입력하세요." };

  const request = await prisma.voucherUnconfirmRequest.findUnique({ where: { id: requestId } });
  if (!request) return { ok: false, message: "요청을 찾을 수 없습니다." };
  if (request.status !== "pending") return { ok: false, message: "이미 처리된 요청입니다." };

  await prisma.voucherUnconfirmRequest.update({
    where: { id: requestId },
    data: { status: "rejected", decidedByEmail: user.email, decidedAt: new Date(), decisionNote: trimmed },
  });
  revalidateAll();
  return { ok: true };
}
