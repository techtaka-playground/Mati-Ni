"use server";

import { requireLoggedIn } from "@/lib/session";
import { storeFile, storedFileExists, deleteStoredFile } from "@/lib/fileStorage";

const MAX_SEGMENT_LENGTH = 60;

// Windows/일반 파일시스템에서 금지된 문자 제거 + 길이 제한.
function sanitizeSegment(part: string): string {
  return part
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEGMENT_LENGTH);
}

// segments를 "_"로 이어붙여 파일명을 만들고, 같은 이름이 있으면 (1), (2)... 를 붙여 겹쳐쓰지
// 않는다. saveUploadedPdf/saveTaxInvoiceAttachmentPdf가 공통으로 쓴다.
async function writeUploadFile(segments: string[], base64: string): Promise<string> {
  let filename = `${segments.join("_")}.pdf`;

  let n = 1;
  while (await storedFileExists(filename)) {
    filename = `${segments.join("_")}(${n}).pdf`;
    n += 1;
  }

  await storeFile(filename, Buffer.from(base64, "base64"));
  return filename;
}

export type SavePdfInput = {
  base64: string;
  originalName: string;
  party: string | null;
  groupNo?: string | null;
  amount: number;
  period?: string | null;
};

export type SavePdfResult = { ok: true; filename: string } | { ok: false; message: string };

// 업로드된 인보이스/명세서 PDF 원본을 파일명_거래처_GroupNo_금액_Period 순으로 저장한다.
// GroupNo·Period는 다건 명세서에만 있으므로 없으면 그 자리를 건너뛴다.
export async function saveUploadedPdf(input: SavePdfInput): Promise<SavePdfResult> {
  await requireLoggedIn();
  try {
    const baseName = sanitizeSegment(input.originalName.replace(/\.pdf$/i, ""));
    const partySegment = input.party ? sanitizeSegment(input.party) : null;
    const groupNoSegment = input.groupNo ? sanitizeSegment(input.groupNo) : null;
    const amountSegment = Number.isFinite(input.amount) ? String(Math.round(input.amount)) : null;
    const periodSegment = input.period ? sanitizeSegment(input.period) : null;

    const segments = [baseName, partySegment, groupNoSegment, amountSegment, periodSegment].filter(
      (s): s is string => !!s && s.length > 0
    );

    const filename = await writeUploadFile(segments, input.base64);
    return { ok: true, filename };
  } catch {
    return { ok: false, message: "원본 PDF 저장에 실패했습니다." };
  }
}

export type SaveTaxInvoiceAttachmentInput = {
  base64: string;
  originalName: string;
  ntsSendKey: string;
  blNo: string | null;
};

// 세금계산서 행에 첨부한 인보이스 PDF를 파일명_B/L_승인번호 순으로 저장한다.
export async function saveTaxInvoiceAttachmentPdf(
  input: SaveTaxInvoiceAttachmentInput
): Promise<SavePdfResult> {
  await requireLoggedIn();
  try {
    const baseName = sanitizeSegment(input.originalName.replace(/\.pdf$/i, ""));
    const blNoSegment = input.blNo ? sanitizeSegment(input.blNo) : "미인식";
    const ntsSegment = sanitizeSegment(input.ntsSendKey);

    const segments = [baseName, blNoSegment, ntsSegment].filter((s) => s.length > 0);

    const filename = await writeUploadFile(segments, input.base64);
    return { ok: true, filename };
  } catch {
    return { ok: false, message: "인보이스 PDF 저장에 실패했습니다." };
  }
}

export type SaveBundledTaxInvoiceAttachmentInput = {
  base64: string;
  originalName: string;
  ntsSendKeys: string[];
  blNo: string | null;
};

// 여러 세금계산서를 묶어서 등록할 때 공통으로 첨부하는 인보이스(지출결의서 등) PDF를
// 파일명_B/L_대표승인번호(+외N건) 순으로 저장한다. 같은 파일이 여러 TaxInvoiceAttachment
// 행에 그대로 연결된다.
export async function saveBundledTaxInvoiceAttachmentPdf(
  input: SaveBundledTaxInvoiceAttachmentInput
): Promise<SavePdfResult> {
  await requireLoggedIn();
  try {
    const baseName = sanitizeSegment(input.originalName.replace(/\.pdf$/i, ""));
    const blNoSegment = input.blNo ? sanitizeSegment(input.blNo) : "미인식";
    const ntsSegment = sanitizeSegment(
      input.ntsSendKeys.length > 1
        ? `${input.ntsSendKeys[0]}외${input.ntsSendKeys.length - 1}건`
        : input.ntsSendKeys[0]
    );

    const segments = [baseName, blNoSegment, ntsSegment].filter((s) => s.length > 0);

    const filename = await writeUploadFile(segments, input.base64);
    return { ok: true, filename };
  } catch {
    return { ok: false, message: "인보이스 PDF 저장에 실패했습니다." };
  }
}

// "묶음 풀기"에서 첨부 파일까지 함께 지울 때 쓴다(2026-08-27, 이전엔 파일만 남기고 B/L만
// 지웠는데 "첨부도 지워달라"는 요청에 따름). 파일이 이미 없어도(다른 경로로 먼저 지워졌거나
// 애초에 첨부가 없던 행이거나) 조용히 넘어간다 — 사용자 입장에서는 어차피 "첨부 없음"이면
// 목표(파일이 안 남아있음)를 이미 이룬 것이라 에러로 취급하지 않는다.
export async function deleteUploadedFile(filename: string): Promise<void> {
  await requireLoggedIn();
  if (!filename) return;
  try {
    await deleteStoredFile(filename);
  } catch {
    // 이미 없으면 그냥 넘어간다.
  }
}
