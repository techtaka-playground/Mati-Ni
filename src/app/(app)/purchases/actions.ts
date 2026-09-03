"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { parseDateInput } from "@/lib/format";
import type { DeleteActionResult } from "@/components/DeleteButton";
import {
  extractPurchaseInvoice,
  extractPurchaseStatement,
  type ExtractedPurchaseInvoice,
  type ExtractedPurchaseStatement,
  type ExtractResult,
} from "@/lib/invoiceExtract";
import { parsePurchaseStatement } from "@/lib/purchaseStatementParser";
import { parseArgoInvoice } from "@/lib/argoInvoiceParser";
import { parseAirInvoice } from "@/lib/airInvoiceParser";
import { requireLoggedIn } from "@/lib/session";
import { resetOrphanedTaxInvoiceAttachments } from "@/lib/taxInvoiceAttachments";
import { cleanupOrphanedAllocations } from "@/lib/bankAllocation";

export async function extractPurchaseInvoicePdf(
  base64: string
): Promise<ExtractResult<ExtractedPurchaseInvoice>> {
  await requireLoggedIn();
  try {
    return { ok: true, data: await extractPurchaseInvoice(base64) };
  } catch {
    return { ok: false, message: "PDF에서 정보를 추출하지 못했습니다. 값을 직접 입력해주세요." };
  }
}

// vat/supplyAmount는 **정형 양식 파서만** 채운다(AI 추출은 못 채운다) — 그래서 선택 필드다.
// 화면에서는 supplyAmount가 있으면 그걸 쓰고, 없으면 amount를 쓴다.
export type ExtractedPurchaseStatementSmart = Omit<ExtractedPurchaseStatement, "lines"> & {
  method: "offline" | "ai";
  lines: (ExtractedPurchaseStatement["lines"][number] & { vat?: number; supplyAmount?: number })[];
};

// House No/Master No별로 여러 화물이 나열된 매입 명세서(지출결의서 등) 또는 B/L 1건짜리
// 단건 인보이스(관세 등) 추출.
// 1) 먼저 pdf-parse로 텍스트만 뽑아 규칙 기반으로 읽는다(API 키 불필요) — 지출결의서 양식
//    (`parsePurchaseStatement`) → 해상 단건 INVOICE(`parseArgoInvoice`) → 항공 단건
//    INVOICE(`parseAirInvoice`) 순으로 시도한다. 각 파서는 자기 양식이 아니면 빈 배열을
//    돌려주므로 순서대로 이어 붙이면 되고, 새 정형 양식이 생기면 여기 하나 더 추가한다.
// 2) 둘 다 한 줄도 못 찾으면(지원하지 않는 다른 양식) — ANTHROPIC_API_KEY가 있을 때만 —
//    Claude로 추출을 한 번 더 시도한다. 셋 다 실패하면 사용자가 직접 입력해야 한다.
export async function extractPurchaseStatementPdf(
  base64: string
): Promise<ExtractResult<ExtractedPurchaseStatementSmart>> {
  await requireLoggedIn();
  try {
    const buffer = Buffer.from(base64, "base64");
    const offline = await parsePurchaseStatement(buffer);
    if (offline.lines.length > 0) {
      return { ok: true, data: { ...offline, method: "offline" } };
    }
    const argoInvoice = await parseArgoInvoice(buffer);
    if (argoInvoice.lines.length > 0) {
      return { ok: true, data: { ...argoInvoice, method: "offline" } };
    }
    // 항공(AWB) INVOICE — 해상 파서가 요구하는 "B/L No" 대신 "HAWB No"/"MAWB No"를 쓰는 양식.
    const airInvoice = await parseAirInvoice(buffer);
    if (airInvoice.lines.length > 0) {
      return { ok: true, data: { ...airInvoice, method: "offline" } };
    }
  } catch {
    // 이 PDF는 지원하는 정형 명세서 양식이 아님 — 아래에서 AI 추출로 넘어간다.
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      message:
        "이 PDF에서는 지원하는 명세서 양식(지출결의서 리스트 / 해상 B/L 인보이스 / 항공 AWB 인보이스)을 " +
        "인식하지 못했습니다. " +
        "다른 양식은 ANTHROPIC_API_KEY를 설정해야 AI로 추출할 수 있습니다.",
    };
  }

  try {
    const data = await extractPurchaseStatement(base64);
    if (data.lines.length === 0) {
      return { ok: false, message: "명세서에서 개별 화물 줄을 찾지 못했습니다." };
    }
    return { ok: true, data: { ...data, method: "ai" } };
  } catch {
    return { ok: false, message: "PDF에서 정보를 추출하지 못했습니다. 값을 직접 입력해주세요." };
  }
}

export type CreatePurchaseInput = {
  date: string;
  partyId: string;
  amount: number;
  note: string;
  allocations: { blNo: string; amount: number }[];
  currency?: string;
  fxAmount?: number | null;
  fxRate?: number | null;
};

export type CreatePurchaseResult = { ok: true } | { ok: false; message: string };

function revalidateAll() {
  revalidatePath("/vouchers");
  revalidatePath("/pnl");
}

// 매입 총액 = B/L별 배분 합계가 항상 맞아야 손익(매출-배분매입)이 정확하다 — 여기서 강제 검증.
// 배분은 blNo(B/L번호)로 저장되고, 그 번호로 이미 등록된 매출이 있으면 saleId를 같이 채운다 —
// 없으면 saleId=null로 저장해두고, 나중에 그 번호로 매출이 등록되는 순간 자동 연결된다
// (createSale 참고). 즉 매입을 매출보다 먼저 등록해도 된다.
export async function createPurchase(input: CreatePurchaseInput): Promise<CreatePurchaseResult> {
  await requireLoggedIn();
  const { date, partyId, note, allocations } = input;
  const currency = (input.currency || "KRW").trim().toUpperCase();

  if (!date || !partyId || allocations.length === 0) {
    return { ok: false, message: "필수 항목을 모두 입력하세요." };
  }
  if (allocations.some((a) => !a.blNo.trim())) {
    return { ok: false, message: "모든 배분 줄에 B/L 번호를 입력하세요." };
  }

  // 원화 환산액은 항상 서버에서 계산한다(createSale·createCustomsAdvance와 같은 이유) —
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

  // 외화는 지금까지 항상 B/L 1개 = 전액 배분(일반전표 수기입력)에서만 들어온다 — 배분 줄의
  // 금액도 서버가 계산한 값으로 맞춘다(클라이언트가 미리 계산해 보낸 값과 반올림이 어긋나지
  // 않게). 여러 줄(다건명세서 업로드 등)은 항상 KRW라 그대로 둔다.
  const resolvedAllocations =
    currency === "KRW" || allocations.length !== 1 ? allocations : [{ ...allocations[0], amount }];

  const allocTotal = resolvedAllocations.reduce((sum, a) => sum + a.amount, 0);
  if (Math.round(allocTotal) !== Math.round(amount)) {
    return {
      ok: false,
      message: `배분 합계(${Math.round(allocTotal).toLocaleString("ko-KR")})가 매입 총액(${Math.round(amount).toLocaleString("ko-KR")})과 일치하지 않습니다.`,
    };
  }

  const blNos = [...new Set(resolvedAllocations.map((a) => a.blNo.trim()))];
  const matchingSales = await prisma.sale.findMany({
    where: { blNo: { in: blNos } },
    select: { id: true, blNo: true },
  });
  const saleIdByBlNo = new Map(matchingSales.map((s) => [s.blNo, s.id]));

  await prisma.purchase.create({
    data: {
      date: parseDateInput(date),
      partyId,
      amount,
      currency,
      fxAmount,
      fxRate,
      note,
      allocations: {
        create: resolvedAllocations.map((a) => {
          const blNo = a.blNo.trim();
          return { blNo, saleId: saleIdByBlNo.get(blNo) ?? null, amount: a.amount };
        }),
      },
    },
  });

  revalidateAll();
  return { ok: true };
}

export type UpdateSinglePurchaseInput = {
  id: string;
  date: string;
  partyId: string;
  blNo: string;
  amount: number;
  note: string;
};

// 전표 빠른입력에서 만든, B/L 1개짜리 매입만 수정할 수 있다 — 세금계산서에서 등록된 건이나
// 배분이 여러 건인(다건명세서 등으로 만든) 매입은 이 화면에서 안전하게 수정할 수 없어 잠긴다.
export async function updatePurchase(input: UpdateSinglePurchaseInput): Promise<CreatePurchaseResult> {
  await requireLoggedIn();
  const existing = await prisma.purchase.findUnique({ where: { id: input.id }, include: { allocations: true } });
  if (!existing) return { ok: false, message: "이미 삭제된 매입입니다." };
  if (existing.ntsSendKey) return { ok: false, message: "세금계산서에서 등록된 매입은 전표에서 수정할 수 없습니다." };
  if (existing.allocations.length !== 1) {
    return { ok: false, message: "B/L이 여러 건으로 배분된 매입은 전표에서 수정할 수 없습니다." };
  }
  if (existing.allocations[0].settlementConfirmedAt) {
    return { ok: false, message: "확정된 건은 관리자가 해제하기 전까지 수정할 수 없습니다." };
  }

  const blNo = input.blNo.trim();
  if (!blNo || !input.date || !input.partyId || !Number.isFinite(input.amount)) {
    return { ok: false, message: "필수 항목을 모두 입력하세요." };
  }

  const sale = await prisma.sale.findFirst({ where: { blNo } });

  await prisma.purchase.update({
    where: { id: input.id },
    data: {
      date: parseDateInput(input.date),
      partyId: input.partyId,
      amount: input.amount,
      note: input.note,
      allocations: {
        update: {
          where: { id: existing.allocations[0].id },
          data: { blNo, amount: input.amount, saleId: sale?.id ?? null },
        },
      },
    },
  });

  revalidateAll();
  return { ok: true };
}

export async function deletePurchase(formData: FormData): Promise<DeleteActionResult> {
  await requireLoggedIn();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, reason: "not_found" };

  const existing = await prisma.purchase.findUnique({
    where: { id },
    select: {
      ntsSendKey: true,
      allocations: { select: { blNo: true, settlementConfirmedAt: true } },
    },
  });
  // 배분(B/L)이 하나라도 확정돼 있으면 전체 매입 삭제를 막는다 — 삭제는 전표 단위 동작이라
  // 확정된 B/L만 남기고 지울 수는 없다.
  if (existing?.allocations.some((a) => a.settlementConfirmedAt)) return { ok: false, reason: "confirmed" };

  await prisma.purchase.delete({ where: { id } });
  await cleanupOrphanedAllocations();

  // 세금계산서에서 등록된 매입이었다면, 그 등록 상태도 함께 초기화한다 — 안 그러면 전표는
  // 지워졌는데 세금계산서 화면에는 여전히 "등록됨"으로 남는다.
  const primaryBlNo = existing?.allocations[0]?.blNo;
  if (existing?.ntsSendKey && primaryBlNo) {
    await resetOrphanedTaxInvoiceAttachments(primaryBlNo, "purchase");
  }

  revalidateAll();
  revalidatePath("/tax-invoices");
  return { ok: true };
}
