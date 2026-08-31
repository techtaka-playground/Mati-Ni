import { prisma } from "@/lib/prisma";
import type { TaxInvoiceDirection } from "@/lib/barobill";
import { formatDate } from "@/lib/format";
import { deleteUploadedFile } from "@/lib/fileStorageActions";

export type AttachmentStatus = {
  blNo: string | null;
  fileName: string;
  matched: boolean;
  matchedKind: "sale" | "purchase" | "customs" | null; // 매입 세금계산서는 일반전표(매입)로도, 관세전표로도 등록될 수 있다
  matchedLabel: string | null; // 예: "테크타카모바일 · 2026-07-31" (접두어 없이 거래처/날짜만)
  bundledCount: number; // 같은 B/L·같은 구분(매출/매입)으로 함께 묶여 등록된 다른 세금계산서 건수(없으면 0)
  // 이 등록이 실제로 걸쳐 있는 서로 다른 B/L 수. 매입(PurchaseAllocation)과 매출(같은
  // 승인번호를 공유하는 여러 Sale, 2026-08-27부터) 둘 다 2 이상이 될 수 있고, 관세는 항상 1이다.
  // 목록에서 "PRKS26060051 외 3건"으로 보여주는 데 쓴다(미등록이면 0).
  blCount: number;
  approvedAt: string | null; // 승인(전표 등록) 시각 — 매출·매입 공통. 있으면 목록에서 초록 음영 + "수정"만 가능
  saleId: string | null; // matchedKind === "sale"일 때만 값이 있음
  saleConfirmedAt: string | null; // ISO 문자열 — 확정 안 됐으면 null(matchedKind !== "sale"이면 항상 null)
};

// 첨부된 인보이스의 B/L이 이미 등록된 매출/매입/관세대납과 맞는지 매번 다시 확인한다 —
// 저장해두지 않는 이유는 PurchaseAllocation.saleId 등과 같다: 나중에 매출이 등록되면 그
// 즉시 매칭 상태가 바뀌어 보여야 하기 때문이다.
// **이 승인번호로 등록된 전표를 정확히 찾는다.**
//
// 왜 B/L이 아니라 승인번호인가: B/L은 전표를 특정하는 키가 아니다. 같은 B/L에 관세 대납과
// 운임 매입이 함께 걸릴 수 있다 — 실제로 DSC084969에는 관세전표(3,063,059)와 항공운임 매입
// 배분(29,439,549)이 둘 다 있다. 그때 B/L로 찾으면 먼저 조회된 쪽이 답이 되어, 관세전표로
// 등록한 세금계산서가 목록에서 "일반전표"로 보인다. 승인번호는 그 세금계산서가 정확히 어느
// 전표가 됐는지 가리키므로, 값이 있으면 그것이 답이다.
//
// 셋 중 하나에만 등록되므로 먼저 찾은 것이 답이다. 묶음 매입의 구성원은 대표 1건만 승인번호를
// 가져서 여기서 못 찾는데, 그 경우는 호출부에서 B/L로 다시 찾는다.
type ExactVoucherMatch = {
  blNo: string;
  matchedKind: "sale" | "purchase" | "customs";
  matchedLabel: string;
  blCount: number;
  saleId: string | null;
  saleConfirmedAt: string | null;
};

async function findVoucherByNtsSendKey(ntsSendKey: string): Promise<ExactVoucherMatch | null> {
  // 매출도 매입처럼 인보이스 한 건이 B/L 여러 건에 걸쳐 등록될 수 있어(2026-08-27) 같은
  // 승인번호를 가진 Sale이 여러 행일 수 있다 — findFirst 대신 findMany로 전부 찾는다.
  const sales = await prisma.sale.findMany({ where: { ntsSendKey }, include: { party: true } });
  if (sales.length > 0) {
    const first = sales[0];
    return {
      blNo: first.blNo,
      matchedKind: "sale",
      matchedLabel: `${first.party.name} · ${formatDate(first.date)}`,
      blCount: sales.length,
      saleId: first.id,
      saleConfirmedAt: first.confirmedAt ? first.confirmedAt.toISOString() : null,
    };
  }

  const purchase = await prisma.purchase.findFirst({
    where: { ntsSendKey },
    include: { party: true, allocations: { select: { blNo: true } } },
  });
  if (purchase) {
    // 빈 blNo는 세지 않는다 — 세금계산서 미발행분(W/F 등)은 특정 B/L에 속하지 않아 blNo가
    // 빈 문자열이다. 그걸 세면 "외 N건"이 실제 B/L 수보다 하나 많게 나온다.
    const blNos = [...new Set(purchase.allocations.map((x) => x.blNo).filter(Boolean))];
    if (blNos.length > 0) {
      return {
        blNo: blNos[0],
        matchedKind: "purchase",
        matchedLabel: `${purchase.party.name} · ${formatDate(purchase.date)}`,
        blCount: blNos.length,
        saleId: null,
        saleConfirmedAt: null,
      };
    }
  }

  const customs = await prisma.customsAdvance.findFirst({ where: { ntsSendKey } });
  if (customs) {
    return {
      blNo: customs.blNo,
      matchedKind: "customs",
      matchedLabel: formatDate(customs.paidDate),
      blCount: 1, // 관세대납은 B/L별로 각각 별도 행이다
      saleId: null,
      saleConfirmedAt: null,
    };
  }
  return null;
}

export async function getAttachmentStatuses(
  entries: { ntsSendKey: string; direction: TaxInvoiceDirection }[]
): Promise<Record<string, AttachmentStatus>> {
  if (entries.length === 0) return {};

  const keys = entries.map((e) => e.ntsSendKey);
  const attachments = await prisma.taxInvoiceAttachment.findMany({
    where: { ntsSendKey: { in: keys } },
  });

  const directionByKey = new Map(entries.map((e) => [e.ntsSendKey, e.direction]));
  const result: Record<string, AttachmentStatus> = {};

  for (const a of attachments) {
    const direction0 = directionByKey.get(a.ntsSendKey) ?? (a.direction as TaxInvoiceDirection);

    // **승인번호로 먼저 찾는다**(findVoucherByNtsSendKey 주석 참고 — B/L은 전표를 특정하지
    // 못한다). 찾으면 첨부의 blNo가 비어 있어도 전표의 B/L을 쓴다: 인보이스 인식이 실패했거나
    // 옛 리비전으로 등록된 건은 첨부에 B/L이 없는데, 그렇다고 "미등록"으로 보이면 안 된다
    // (O00010이 그랬다).
    const exact = await findVoucherByNtsSendKey(a.ntsSendKey);
    if (exact) {
      result[a.ntsSendKey] = {
        blNo: exact.blNo,
        fileName: a.fileName,
        matched: true,
        matchedKind: exact.matchedKind,
        matchedLabel: exact.matchedLabel,
        bundledCount: await prisma.taxInvoiceAttachment.count({
          where: { blNo: exact.blNo, direction: direction0, ntsSendKey: { not: a.ntsSendKey } },
        }),
        blCount: exact.blCount,
        approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        saleId: exact.saleId,
        saleConfirmedAt: exact.saleConfirmedAt,
      };
      continue;
    }

    // 여기부터는 승인번호로 못 찾은 경우 — 묶음 구성원(대표만 승인번호를 갖는다)이나 아직
    // 전표가 없는 건이다. 그때는 첨부의 B/L로 찾되, **확정된 건에만** 그렇게 한다.
    //
    // 확정을 요구하는 이유: B/L은 전표를 특정하지 못하므로(위 findVoucherByNtsSendKey 주석),
    // B/L만 보고 붙이면 그 B/L에 걸린 남의 전표를 자기 것으로 표시한다. 실제로 O00017은
    // 등록조차 안 된 상태인데 DSC084965가 겹치는 다른 매입 전표(154,921,927)에 붙어
    // "일반전표 · 외 10건"으로 보였다. 등록하면 반드시 확정 시각이 남으므로(registerFromTaxInvoice·
    // registerBundledPurchase 둘 다 approvedAt을 채운다 — 묶음은 구성원 전원에게 채운다),
    // 확정이 없다는 것은 이 세금계산서가 아직 어느 전표도 되지 않았다는 뜻이다.
    const blNo = a.approvedAt ? a.blNo : null;
    if (!blNo) {
      result[a.ntsSendKey] = {
        blNo: null,
        fileName: a.fileName,
        matched: false,
        matchedKind: null,
        matchedLabel: null,
        bundledCount: 0,
        blCount: 0,
        approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        saleId: null,
        saleConfirmedAt: null,
      };
      continue;
    }

    const direction = directionByKey.get(a.ntsSendKey) ?? (a.direction as TaxInvoiceDirection);

    // 같은 B/L·같은 구분(매출/매입)으로 함께 묶여 등록된 다른 세금계산서가 몇 건 더 있는지 —
    // 있으면 "OO등록 외 N건"으로 보여준다. 매출/매입은 완전히 별개의 흐름이라 구분을 섞지 않는다.
    const bundledCount = await prisma.taxInvoiceAttachment.count({
      where: { blNo, direction, ntsSendKey: { not: a.ntsSendKey } },
    });

    if (direction === "sales") {
      const sale = await prisma.sale.findFirst({ where: { blNo }, include: { party: true } });
      result[a.ntsSendKey] = {
        blNo,
        fileName: a.fileName,
        matched: Boolean(sale),
        matchedKind: sale ? "sale" : null,
        matchedLabel: sale ? `${sale.party.name} · ${formatDate(sale.date)}` : null,
        bundledCount: sale ? bundledCount : 0,
        blCount: sale ? 1 : 0, // Sale은 구조상 B/L 1건 = 1행이다
        approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        saleId: sale?.id ?? null,
        saleConfirmedAt: sale?.confirmedAt ? sale.confirmedAt.toISOString() : null,
      };
      continue;
    }

    // 매입 세금계산서는 일반전표(Purchase)로 등록됐을 수도, 관세전표(CustomsAdvance)로
    // 등록됐을 수도 있다 — 둘 다 확인한다.
    const alloc = await prisma.purchaseAllocation.findFirst({
      where: { blNo },
      // purchase.allocations까지 가져오는 이유: 이 매입이 몇 개의 B/L에 걸쳐 있는지(blCount)를
      // 세어 목록에 "외 N건"으로 보여주기 위해서다.
      include: { purchase: { include: { party: true, allocations: { select: { blNo: true } } } } },
    });
    if (alloc) {
      result[a.ntsSendKey] = {
        blNo,
        fileName: a.fileName,
        matched: true,
        matchedKind: "purchase",
        matchedLabel: `${alloc.purchase.party.name} · ${formatDate(alloc.purchase.date)}`,
        bundledCount,
        blCount: new Set(alloc.purchase.allocations.map((x) => x.blNo)).size,
        approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        saleId: null,
        saleConfirmedAt: null,
      };
      continue;
    }

    const customs = await prisma.customsAdvance.findFirst({ where: { blNo } });
    result[a.ntsSendKey] = {
      blNo,
      fileName: a.fileName,
      matched: Boolean(customs),
      matchedKind: customs ? "customs" : null,
      matchedLabel: customs ? formatDate(customs.paidDate) : null,
      bundledCount: customs ? bundledCount : 0,
      // 관세대납은 B/L별로 각각 별도 행이라 이 첨부와 확실히 묶인 것은 이 1건뿐이다.
      blCount: customs ? 1 : 0,
      approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
      saleId: null,
      saleConfirmedAt: null,
    };
  }

  await markVouchersWithoutAttachment(keys, result);
  return result;
}

// 첨부기록(TaxInvoiceAttachment)은 없는데 그 승인번호로 이미 전표가 만들어져 있는 건을
// "이미 등록"으로 표시한다.
//
// 왜 필요한가: 위 로직은 전부 TaxInvoiceAttachment를 기준으로 판단하는데, 전표만 있고
// 첨부기록이 없는 상태가 실제로 생긴다 — 일반전표 화면에서 직접 등록한 경우, 또는 DB를
// 백업에서 복구했는데 첨부기록은 복구되지 않은 경우다. 그러면 목록에 "미등록"으로 보여
// 체크박스와 "등록" 버튼이 살아나고, 같은 매입을 한 번 더 등록해 **이중 계상**된다.
// 2026-08-19에 프로라인해운 6,129,097원이 정확히 이 경로로 두 번 잡혔다(백업 대조로 확인 후
// 중복분 삭제). 그 뒤 registerFromTaxInvoice/registerBundled*에도 하드 가드를 넣었다.
//
// 한계: 묶음으로 등록된 Purchase는 대표 1건의 승인번호만 들고 있어(`ntsSendKeys[0]`),
// 첨부기록이 사라진 묶음의 **구성원** 승인번호는 여기서 잡히지 않는다.
async function markVouchersWithoutAttachment(
  keys: string[],
  result: Record<string, AttachmentStatus>
): Promise<void> {
  const orphanKeys = keys.filter((k) => !result[k]);
  if (orphanKeys.length === 0) return;

  const [sales, purchases] = await Promise.all([
    prisma.sale.findMany({ where: { ntsSendKey: { in: orphanKeys } }, include: { party: true } }),
    prisma.purchase.findMany({
      where: { ntsSendKey: { in: orphanKeys } },
      include: { party: true, allocations: { select: { blNo: true } } },
    }),
  ]);

  // 같은 승인번호를 공유하는 Sale이 여러 건일 수 있어(B/L 여러 건 배분, 2026-08-27) 먼저
  // 승인번호별로 묶은 뒤 대표(첫 건) 기준으로 채운다 — 그냥 덮어쓰면 마지막 건만 남는다.
  const salesByKey = new Map<string, typeof sales>();
  for (const s of sales) {
    if (!s.ntsSendKey) continue;
    const group = salesByKey.get(s.ntsSendKey) ?? [];
    group.push(s);
    salesByKey.set(s.ntsSendKey, group);
  }
  for (const [ntsSendKey, group] of salesByKey) {
    const first = group[0];
    result[ntsSendKey] = {
      blNo: first.blNo,
      fileName: "", // 첨부된 파일이 없다 — "인보이스" 칸은 그대로 `—`로 보인다
      matched: true,
      matchedKind: "sale",
      matchedLabel: `${first.party.name} · ${formatDate(first.date)}`,
      bundledCount: 0,
      blCount: group.length,
      // 세금계산서 화면의 승인 흐름을 거치지 않은 전표라 확정 시각이 없다 — "확정" 칸은 `—`로
      // 두고 초록 음영도 넣지 않는다(없는 승인 기록을 있는 것처럼 보이게 하지 않는다).
      approvedAt: null,
      saleId: first.id,
      saleConfirmedAt: first.confirmedAt ? first.confirmedAt.toISOString() : null,
    };
  }

  for (const p of purchases) {
    if (!p.ntsSendKey || result[p.ntsSendKey]) continue;
    result[p.ntsSendKey] = {
      blNo: p.allocations[0]?.blNo ?? null,
      fileName: "",
      matched: true,
      matchedKind: "purchase",
      matchedLabel: `${p.party.name} · ${formatDate(p.date)}`,
      bundledCount: 0,
      blCount: new Set(p.allocations.map((x) => x.blNo)).size,
      approvedAt: null,
      saleId: null,
      saleConfirmedAt: null,
    };
  }
}

// 일반전표(매출/매입)를 삭제할 때, 그 전표가 세금계산서에서 등록됐던 것이라면 세금계산서
// 화면의 등록 상태도 함께 초기화한다 — 안 그러면 전표는 지워졌는데 세금계산서 목록에는
// 여전히 "등록됨(초록 음영)"으로 남아 다시 등록할 수 없는 상태가 된다.
//
// blNo로 묶어서 찾는 이유: "묶어서 등록"(registerBundledSale/Purchase)은 전표 1건이 여러
// 승인번호(ntsSendKey)를 대표해서, 그 승인번호들의 TaxInvoiceAttachment가 전부 같은 대표
// blNo를 공유한다 — 전표 1건을 지우면 그 승인번호들 전부의 등록이 함께 풀려야 한다(묶음
// 풀기와 같은 효과). 반대로 같은 B/L이 세금계산서별로 각각 다른 전표로 등록된 경우(승인번호
// 여러 개 → 전표 여러 개)에는, 지금 지운 전표의 승인번호만 풀고 나머지는 그대로 둬야 한다
// (그 전표들은 아직 살아있다). 그래서 blNo로 후보를 모은 뒤, **각 승인번호를 실제로 참조하는
// 전표가 하나도 안 남았을 때만** 그 승인번호를 초기화한다 — 두 경우를 자동으로 구분해낸다.
export async function resetOrphanedTaxInvoiceAttachments(
  blNo: string,
  direction: TaxInvoiceDirection
): Promise<void> {
  if (!blNo) return;

  const attachments = await prisma.taxInvoiceAttachment.findMany({
    where: { blNo, direction },
    select: { ntsSendKey: true, fileName: true },
  });
  if (attachments.length === 0) return;

  const orphaned: string[] = [];
  for (const a of attachments) {
    const stillReferenced =
      direction === "sales"
        ? (await prisma.sale.count({ where: { ntsSendKey: a.ntsSendKey } })) > 0
        : (await prisma.purchase.count({ where: { ntsSendKey: a.ntsSendKey } })) > 0 ||
          (await prisma.customsAdvance.count({ where: { ntsSendKey: a.ntsSendKey } })) > 0;
    if (!stillReferenced) orphaned.push(a.ntsSendKey);
  }
  if (orphaned.length === 0) return;

  // 묶음 구성원끼리 같은 첨부 파일명을 공유할 수 있으므로(saveBundledTaxInvoiceAttachmentPdf)
  // 중복 없이 한 번씩만 지운다 — "묶음 풀기"와 같은 처리.
  const fileNames = new Set(
    attachments.filter((a) => orphaned.includes(a.ntsSendKey)).map((a) => a.fileName).filter(Boolean)
  );
  await Promise.all([...fileNames].map((f) => deleteUploadedFile(f)));

  await prisma.taxInvoiceAttachment.updateMany({
    where: { ntsSendKey: { in: orphaned } },
    data: { blNo: null, fileName: "", approvedAt: null },
  });
}
