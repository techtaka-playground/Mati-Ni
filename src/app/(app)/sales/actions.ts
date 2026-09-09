"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { parseDateInput } from "@/lib/format";
import type { DeleteActionResult } from "@/components/DeleteButton";
import { extractSaleInvoice, type ExtractedSaleInvoice, type ExtractResult } from "@/lib/invoiceExtract";
import { requireLoggedIn } from "@/lib/session";
import { resetOrphanedTaxInvoiceAttachments } from "@/lib/taxInvoiceAttachments";
import { cleanupOrphanedAllocations } from "@/lib/bankAllocation";
import { parsePurchaseStatement } from "@/lib/purchaseStatementParser";
import { parseArgoInvoice } from "@/lib/argoInvoiceParser";
import { parseAirInvoice } from "@/lib/airInvoiceParser";
import { parseStatementOfAccount } from "@/lib/statementOfAccountParser";

// 이 오프라인 파서들(다건명세서·해외 파트너 명세서 등)은 전부 매입(비용) 쪽 양식이다 — 매출
// 등록 화면에 실수로 매입 명세서를 첨부했을 때(2026-09-09, "일반전표 매출로 열었는데 해외
// 명세서를 올려서 인식 실패" 사례) "PDF를 못 읽었다"는 막연한 오류 대신 정확한 안내를 주기
// 위해서만 쓴다 — 그 결과(lines)를 매출로 만들지는 않는다(매출은 B/L 1건=1줄만 가능).
async function looksLikePurchaseStatement(buffer: Buffer): Promise<boolean> {
  try {
    if ((await parsePurchaseStatement(buffer)).lines.length > 0) return true;
    if ((await parseArgoInvoice(buffer)).lines.length > 0) return true;
    if ((await parseAirInvoice(buffer)).lines.length > 0) return true;
    if ((await parseStatementOfAccount(buffer)).lines.length > 0) return true;
  } catch {
    // 못 읽어도 이 안내 목적으로는 실패 취급하면 충분하다 — 아래 일반 오류로 넘어간다.
  }
  return false;
}

export async function extractSaleInvoicePdf(base64: string): Promise<ExtractResult<ExtractedSaleInvoice>> {
  await requireLoggedIn();
  try {
    return { ok: true, data: await extractSaleInvoice(base64) };
  } catch {
    const buffer = Buffer.from(base64, "base64");
    if (await looksLikePurchaseStatement(buffer)) {
      return {
        ok: false,
        message:
          "이 PDF는 매입(비용) 명세서로 보입니다. 구분을 \"매입\"으로 바꾼 뒤, 인보이스 첨부 옆의 " +
          "\"다건명세서 업로드\"를 사용해주세요.",
      };
    }
    return { ok: false, message: "PDF에서 정보를 추출하지 못했습니다. 값을 직접 입력해주세요." };
  }
}

export type SaleInput = {
  blNo: string;
  date: string;
  partyId: string;
  amount: number;
  note: string;
  currency?: string;
  fxAmount?: number | null;
  fxRate?: number | null;
};
export type SaleActionResult = { ok: true } | { ok: false; message: string };

export async function createSale(input: SaleInput): Promise<SaleActionResult> {
  await requireLoggedIn();
  const blNo = input.blNo.trim();
  const currency = (input.currency || "KRW").trim().toUpperCase();
  if (!blNo || !input.date || !input.partyId) {
    return { ok: false, message: "필수 항목을 모두 입력하세요." };
  }

  // 원화 환산액은 항상 서버에서 계산한다(CustomsAdvance의 createCustomsAdvance와 같은 이유) —
  // 외화×환율을 클라이언트가 미리 곱해서 보내도 반올림 방식이 다르면 어긋날 수 있다.
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

  const sale = await prisma.sale.create({
    data: { blNo, date: parseDateInput(input.date), partyId: input.partyId, amount, currency, fxAmount, fxRate, note: input.note },
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
  await cleanupOrphanedAllocations();

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
