import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const client = new Anthropic();

export type ExtractResult<T> = { ok: true; data: T } | { ok: false; message: string };

const SaleInvoiceSchema = z.object({
  blNo: z.string().nullable().describe("B/L 번호"),
  date: z.string().nullable().describe("인보이스에 적힌 거래/선적 날짜, YYYY-MM-DD 형식"),
  partyName: z.string().nullable().describe("거래처(고객, 대금을 지불하는 쪽)의 회사명"),
  amount: z.number().nullable().describe("청구 총액(숫자만, 통화기호·콤마 제외)"),
  note: z.string().nullable().describe("참고할 만한 한 줄 메모(화물명, 품목 등). 없으면 null"),
});
export type ExtractedSaleInvoice = z.infer<typeof SaleInvoiceSchema>;

const PurchaseInvoiceSchema = z.object({
  date: z.string().nullable().describe("인보이스에 적힌 거래일자, YYYY-MM-DD 형식"),
  partyName: z.string().nullable().describe("거래처(공급자, 대금을 청구하는 쪽)의 회사명"),
  amount: z.number().nullable().describe("청구 총액(숫자만, 통화기호·콤마 제외)"),
  note: z.string().nullable().describe("참고할 만한 한 줄 메모. 없으면 null"),
});
export type ExtractedPurchaseInvoice = z.infer<typeof PurchaseInvoiceSchema>;

const PurchaseStatementLineSchema = z.object({
  refNo: z.string().describe(
    "이 줄(shipment)의 식별번호 — House No가 있으면 House No, House No가 비어있고 Master No만 있으면 " +
      "Master No를 사용"
  ),
  masterNo: z
    .string()
    .nullable()
    .describe(
      "House No와 별개로 Master No가 함께 표시돼 있으면 그 값. refNo로 이미 Master No를 썼거나 " +
        "Master No가 아예 없으면 null"
    ),
  amount: z.number().describe("이 줄의 청구 합계(Total) 금액, 숫자만"),
});
const PurchaseStatementSchema = z.object({
  partyName: z.string().nullable().describe("이 명세서의 거래처명(Customer/발행 대상 회사명)"),
  groupNo: z.string().nullable().describe("문서에 있는 Group No 값(있으면). 없으면 null"),
  period: z.string().nullable().describe("문서에 있는 Period(청구 대상 기간) 값(있으면). 없으면 null"),
  lines: z
    .array(PurchaseStatementLineSchema)
    .describe("문서에 나열된 개별 화물(House/Master No) 줄들 — 소계·합계(Grand Total) 줄은 제외"),
});
export type ExtractedPurchaseStatement = z.infer<typeof PurchaseStatementSchema>;

const CustomsInvoiceSchema = z.object({
  blNo: z.string().nullable().describe("관련 B/L 번호(수입신고필증 등에 적혀 있으면)"),
  paidDate: z.string().nullable().describe("관세 납부일자, YYYY-MM-DD 형식"),
  amount: z.number().nullable().describe("관세 납부액(숫자만, 통화기호·콤마 제외)"),
  note: z.string().nullable().describe("참고할 만한 한 줄 메모. 없으면 null"),
});
export type ExtractedCustomsInvoice = z.infer<typeof CustomsInvoiceSchema>;

// PDF 인보이스를 첨부해 구조화된 필드를 추출한다. 양식은 거래처마다 제각각이라 값을 못 찾으면
// null로 두게 하고, 실제 반영 여부는 항상 사용자가 폼에서 확인/수정한 뒤 저장한다.
async function extractPdf<T>(
  base64: string,
  schema: z.ZodType<T>,
  instruction: string,
  maxTokens = 1024
): Promise<T> {
  const response = await client.beta.messages.parse({
    model: "claude-opus-5",
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: instruction },
        ],
      },
    ],
    output_format: betaZodOutputFormat(schema),
  });

  if (!response.parsed_output) {
    throw new Error("PDF에서 값을 추출하지 못했습니다.");
  }
  return response.parsed_output;
}

export function extractSaleInvoice(base64: string): Promise<ExtractedSaleInvoice> {
  return extractPdf(
    base64,
    SaleInvoiceSchema,
    "이 PDF는 포워더가 고객에게 보내는 매출 인보이스입니다. B/L번호, 거래일자, 거래처(고객)명, " +
      "청구 총액을 찾아서 추출하세요. 문서에서 확인할 수 없는 값은 null로 두세요."
  );
}

export function extractPurchaseInvoice(base64: string): Promise<ExtractedPurchaseInvoice> {
  return extractPdf(
    base64,
    PurchaseInvoiceSchema,
    "이 PDF는 공급자(포워더 파트너 등)가 발행한 매입 인보이스입니다. 거래일자, 거래처(공급자)명, " +
      "청구 총액을 찾아서 추출하세요. 문서에서 확인할 수 없는 값은 null로 두세요."
  );
}

// House No/Master No 단위로 여러 화물의 청구액이 나열된 매입 명세서(지출결의서 등). 문서 전체
// 합계 = Purchase.amount, 각 줄(House/Master No + 금액) = 그 B/L에 배분할 PurchaseAllocation
// 후보. 실제 배분은 각 줄의 refNo를 기존 매출(B/L)과 매칭한 뒤 사용자가 확인하고 등록한다.
export function extractPurchaseStatement(base64: string): Promise<ExtractedPurchaseStatement> {
  return extractPdf(
    base64,
    PurchaseStatementSchema,
    "이 PDF는 포워더가 여러 건의 화물(선적)에 대해 청구하는 매입 명세서(지출결의서 등)입니다. " +
      "House No 컬럼과 Master No 컬럼이 있고, 화물 한 건마다 House No(우선) 또는 Master No(House " +
      "No가 비어있을 때)와 그 줄의 청구 합계(Total) 금액이 있습니다. House No와 Master No가 둘 다 " +
      "표시된 줄은 refNo에 House No를, masterNo에 Master No를 따로 채우세요. 문서에 나열된 개별 " +
      "화물 줄을 모두 빠짐없이 추출하세요 — 소계·페이지합계·Grand Total 같은 합산 줄은 포함하지 마세요. " +
      "거래처명(Customer), Group No, Period(청구 대상 기간)도 있으면 함께 추출하세요.",
    4096
  );
}

export function extractCustomsInvoice(base64: string): Promise<ExtractedCustomsInvoice> {
  return extractPdf(
    base64,
    CustomsInvoiceSchema,
    "이 PDF는 관세 납부와 관련된 문서(수입신고필증, 관세납부영수증 등)입니다. 관련 B/L번호, " +
      "관세 납부일자, 납부액을 찾아서 추출하세요. 문서에서 확인할 수 없는 값은 null로 두세요."
  );
}
