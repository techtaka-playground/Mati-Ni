import { getCurrentUserFresh } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatBizNo } from "@/lib/format";
import { getAccessibleEmails } from "@/lib/email-groups";
import { readStoredFile, isSafeStoredFilename } from "@/lib/fileStorage";

// 세금계산서에 첨부해둔 인보이스 PDF를 실제로 열어볼 수 있게 내려준다.
//
// 경로 탐색(path traversal) 방어: 파일명을 URL로 받지 않고 **승인번호만** 받아서 DB에서
// 파일명을 찾아 쓴다 — 사용자가 경로를 직접 지정할 방법이 아예 없다. 그래도 저장된 파일명이
// 어떤 이유로든 경로 구분자를 품게 되는 경우를 대비해 한 번 더 확인한다.
//
// 권한: 세금계산서 열람 권한(canViewTaxInvoices)이 필수이고, admin이 아니면 그 세금계산서
// 상대방 거래처의 담당자 이메일이 자기 이메일과 같거나 같은 이메일 그룹에 속할 때만
// 내려준다(목록 화면의 hasCorpNumAccess와 같은 규칙). 상대방을 알 수 없으면(엑셀 업로드분이
// 지워진 뒤 바로빌 API로만 조회되는 건 등) 판단 근거가 없으므로 admin에게만 허용한다 —
// 실패 시 막는 쪽으로.
export async function GET(_request: Request, context: { params: Promise<{ ntsSendKey: string }> }) {
  const user = await getCurrentUserFresh();
  if (!user?.canViewTaxInvoices) {
    return new Response("세금계산서 열람 권한이 없습니다.", { status: 403 });
  }

  const { ntsSendKey } = await context.params;
  const attachment = await prisma.taxInvoiceAttachment.findUnique({ where: { ntsSendKey } });
  if (!attachment?.fileName) {
    return new Response("첨부된 인보이스가 없습니다.", { status: 404 });
  }

  if (user.role !== "admin") {
    const record = await prisma.taxInvoiceRecord.findUnique({ where: { ntsSendKey } });
    // 거래처 bizNo는 000-00-00000으로 저장되고 corpNum은 하이픈이 없을 수 있어 형식을 맞춘다.
    const corpNum = formatBizNo(record?.counterpartCorpNum);
    if (!corpNum) {
      return new Response("이 세금계산서에 대한 권한이 없습니다.", { status: 403 });
    }
    const party = await prisma.party.findUnique({ where: { bizNo: corpNum } });
    const accessible = await getAccessibleEmails(user.email);
    if (!party?.email || !accessible.has(party.email.trim().toLowerCase())) {
      return new Response("이 거래처의 세금계산서에 대한 권한이 없습니다.", { status: 403 });
    }
  }

  if (!isSafeStoredFilename(attachment.fileName)) {
    return new Response("잘못된 파일 경로입니다.", { status: 400 });
  }

  let data: Buffer;
  try {
    data = await readStoredFile(attachment.fileName);
  } catch {
    // DB에는 파일명이 남아있지만 uploads/에서 사라진 경우(수동 삭제 등).
    return new Response("첨부 파일을 찾을 수 없습니다.", { status: 404 });
  }

  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/pdf",
      // 새 탭에서 바로 보이게(다운로드가 아니라 inline). 파일명에 한글이 들어가므로
      // filename* (RFC 5987) 형식으로 인코딩해서 넘긴다.
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
