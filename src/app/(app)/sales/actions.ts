"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { parseDateInput } from "@/lib/format";
import type { DeleteActionResult } from "@/components/DeleteButton";
import { extractSaleInvoice, type ExtractedSaleInvoice, type ExtractResult } from "@/lib/invoiceExtract";
import { requireLoggedIn } from "@/lib/session";
import { resetOrphanedTaxInvoiceAttachments } from "@/lib/taxInvoiceAttachments";

export async function extractSaleInvoicePdf(base64: string): Promise<ExtractResult<ExtractedSaleInvoice>> {
  await requireLoggedIn();
  try {
    return { ok: true, data: await extractSaleInvoice(base64) };
  } catch {
    return { ok: false, message: "PDF에서 정보를 추출하지 못했습니다. 값을 직접 입력해주세요." };
  }
}

export type SaleInput = { blNo: string; date: string; partyId: string; amount: number; note: string };
export type SaleActionResult = { ok: true } | { ok: false; message: string };

export async function createSale(input: SaleInput): Promise<SaleActionResult> {
  await requireLoggedIn();
  const blNo = input.blNo.trim();
  if (!blNo || !input.date || !input.partyId || !Number.isFinite(input.amount)) {
    return { ok: false, message: "필수 항목을 모두 입력하세요." };
  }

  const sale = await prisma.sale.create({
    data: { blNo, date: parseDateInput(input.date), partyId: input.partyId, amount: input.amount, note: input.note },
  });

  // 매입/관세대납이 이 B/L보다 먼저 등록됐을 수 있다 — 같은 blNo로 아직 매칭 안 된
  // (saleId=null) 건이 있으면 지금 막 생긴 이 매출에 자동으로 연결한다.
  await prisma.purchaseAllocation.updateMany({
    where: { blNo, saleId: null },
    data: { saleId: sale.id },
  });
  await prisma.customsAdvance.updateMany({
    where: { blNo, saleId: null },
    data: { saleId: sale.id },
  });

  revalidatePath("/vouchers");
  revalidatePath("/customs");
  revalidatePath("/pnl");
  return { ok: true };
}

// 수기입력 매출만 수정할 수 있다 — 세금계산서에서 등록된 건(ntsSendKey 있음)은 세금계산서
// 화면에서만 바뀌어야 하므로 전표에서는 잠긴다.
export async function updateSale(
  input: { id: string } & SaleInput
): Promise<SaleActionResult> {
  await requireLoggedIn();
  const existing = await prisma.sale.findUnique({ where: { id: input.id } });
  if (!existing) return { ok: false, message: "이미 삭제된 매출입니다." };
  if (existing.ntsSendKey) return { ok: false, message: "세금계산서에서 등록된 매출은 전표에서 수정할 수 없습니다." };
  if (existing.settlementConfirmedAt) {
    return { ok: false, message: "확정된 건은 관리자가 해제하기 전까지 수정할 수 없습니다." };
  }

  const blNo = input.blNo.trim();
  if (!blNo || !input.date || !input.partyId || !Number.isFinite(input.amount)) {
    return { ok: false, message: "필수 항목을 모두 입력하세요." };
  }

  await prisma.sale.update({
    where: { id: input.id },
    data: { blNo, date: parseDateInput(input.date), partyId: input.partyId, amount: input.amount, note: input.note },
  });

  if (blNo !== existing.blNo) {
    // B/L이 바뀌면 새 번호 기준으로 미매칭 매입배분·관세대납을 다시 연결해준다.
    await prisma.purchaseAllocation.updateMany({ where: { blNo, saleId: null }, data: { saleId: input.id } });
    await prisma.customsAdvance.updateMany({ where: { blNo, saleId: null }, data: { saleId: input.id } });
  }

  revalidatePath("/vouchers");
  revalidatePath("/customs");
  revalidatePath("/pnl");
  return { ok: true };
}

// 매출 삭제 — 이 B/L에 걸린 매입배분·관세대납도 함께 삭제된다(스키마의 Cascade).
export async function deleteSale(formData: FormData): Promise<DeleteActionResult> {
  await requireLoggedIn();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  const existing = await prisma.sale.findUnique({
    where: { id },
    select: { settlementConfirmedAt: true, ntsSendKey: true, blNo: true },
  });
  if (existing?.settlementConfirmedAt) return { ok: false, reason: "confirmed" };

  await prisma.sale.delete({ where: { id } });

  // 세금계산서에서 등록된 매출이었다면, 그 등록 상태도 함께 초기화한다 — 안 그러면 전표는
  // 지워졌는데 세금계산서 화면에는 여전히 "등록됨"으로 남는다.
  if (existing?.ntsSendKey) {
    await resetOrphanedTaxInvoiceAttachments(existing.blNo, "sales");
  }

  revalidatePath("/vouchers");
  revalidatePath("/customs");
  revalidatePath("/pnl");
  revalidatePath("/tax-invoices");
  return { ok: true };
}
