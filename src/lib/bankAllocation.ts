import { prisma } from "@/lib/prisma";
import { matchPartyForRemark, type PartyLite } from "@/lib/bankPartyMatch";

// 전표(매출/매입B/L배분/관세대납) ↔ 은행거래 사이의 **실제 배분**을 다루는 공용 모듈
// (2026-08-31, bankMatch.ts의 그 자리 계산식 매칭을 대체).
//
// 예전에는 "금액이 똑같은 은행거래가 있나"를 매번 그 자리에서 계산만 했다 — 그래서 부분입금·
// 분할출금처럼 금액이 정확히 안 맞는 경우를 표현할 방법이 없었고, 사람이 "이게 그 거래다"라고
// 직접 지정할 수도 없었다. 이제는 그 연결을 `BankAllocation`에 저장한다.
//
// **자동 매칭은 "완전히 미배분인 대상"에만, 정확히 같은 금액인 경우에만** 시도한다(예전
// 계산식과 같은 규칙). 하나라도 배분이 생기면(자동이든 수기든) 그 대상은 더 이상 자동매칭
// 대상이 아니다 — 남은 금액을 채우는 건 전부 수기 매칭의 몫이다. 그래서 세액(VAT) 후보 계산이
// "전액 미배분" 상황에서만 필요해 예전 로직보다 단순하다.
//
// 매입은 B/L별 배분(PurchaseAllocation) 단위로 매칭한다 — 세금계산서 부가세는 전표(매입) 전체
// 합계라 특정 B/L 하나에 몰아 붙일 근거가 없으므로, 매입은 **공급가액(배분액) 그대로 일치하는
// 경우만** 자동매칭 후보로 삼는다. 부가세를 포함한 금액이나 여러 B/L에 걸친 출금은 수기 매칭으로
// 사람이 직접 나눠 배분한다.

export type AllocationKind = "sale" | "purchaseAllocation" | "customsAdvance";

// 금액은 원 단위 정수라 반올림 오차만 허용한다.
const EPS = 0.5;

export function directionForKind(kind: AllocationKind): "deposit" | "withdraw" {
  return kind === "sale" ? "deposit" : "withdraw";
}

// "YYYYMMDDHHMMSS" → "YYYY-MM-DD"
function toDate(transDT: string): string {
  const d = transDT.replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : transDT;
}

export type AllocationDetail = {
  id: string;
  transRefKey: string;
  amount: number;
  date: string;
  auto: boolean;
  createdByEmail: string;
};

// 배치로 여러 대상의 배분 내역을 읽어온다 — 화면 하나에 수십~수백 행이 있어 대상마다 따로
// 쿼리하면 느리다.
export async function getAllocationsByTargets(
  kind: AllocationKind,
  targetIds: string[]
): Promise<Map<string, AllocationDetail[]>> {
  const out = new Map<string, AllocationDetail[]>();
  if (targetIds.length === 0) return out;
  const rows = await prisma.bankAllocation.findMany({
    where: { kind, targetId: { in: targetIds } },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return out;
  const transRefKeys = [...new Set(rows.map((r) => r.transRefKey))];
  const bankRows = await prisma.bankTransaction.findMany({
    where: { transRefKey: { in: transRefKeys } },
    select: { transRefKey: true, transDT: true },
  });
  const dateByKey = new Map(bankRows.map((b) => [b.transRefKey, toDate(b.transDT)]));
  for (const r of rows) {
    const list = out.get(r.targetId) ?? [];
    list.push({
      id: r.id,
      transRefKey: r.transRefKey,
      amount: r.amount,
      date: dateByKey.get(r.transRefKey) ?? "",
      auto: r.auto,
      createdByEmail: r.createdByEmail,
    });
    out.set(r.targetId, list);
  }
  return out;
}

export function sumAllocated(details: AllocationDetail[] | undefined): number {
  return (details ?? []).reduce((s, d) => s + d.amount, 0);
}

export function isFullyAllocated(amount: number, allocated: number): boolean {
  return allocated >= amount - EPS;
}

// 예전 BankMatchBasis와 같은 개념 — 배분 합계가 전표 금액(공급가액) 그대로인지, 부가세가
// 더해진 금액인지. 여러 은행거래에 나눠 배분됐어도 합계만 보면 되므로 그대로 재사용한다.
export type AllocBasis = "supply" | "withVat";
export function basisFor(amount: number, allocatedTotal: number): AllocBasis {
  return Math.round(allocatedTotal) === Math.round(amount) ? "supply" : "withVat";
}

// ── 자동 매칭 — 완전히 미배분인 대상만, 정확히 같은 금액일 때만 ──────────────────────────

export type AutoMatchEntry = {
  kind: AllocationKind;
  targetId: string;
  amount: number;
  partyId: string | null;
  // 세액 조회용 — sale/customsAdvance만 의미가 있다(purchaseAllocation은 공급가액 후보만 시도).
  ntsSendKey: string | null;
};

// 세금계산서 원본에 남은 실제 세액을 부가세 포함 후보로 쓴다(10%를 곱하는 추정이 아니다 —
// 영세율·면세가 섞이면 추정이 틀린다). bankMatch.ts의 taxAmountFor와 같은 규칙.
async function loadTaxByKey(ntsSendKeys: string[]): Promise<Map<string, number>> {
  const keys = [...new Set(ntsSendKeys)];
  if (keys.length === 0) return new Map();
  const rows = await prisma.taxInvoiceRecord.findMany({
    where: { ntsSendKey: { in: keys } },
    select: { ntsSendKey: true, taxTotal: true },
  });
  return new Map(rows.map((r) => [r.ntsSendKey, r.taxTotal]));
}

// 아직 배분이 하나도 없는 대상들에 대해, "확정"된 은행거래 중 정확히 같은 금액·같은 거래처인
// 것을 찾아 자동으로 BankAllocation을 만든다. 일반전표/관세전표 페이지를 열 때마다 호출한다
// (예전 createBankMatcher를 부르던 자리를 대체).
export async function runAutoMatch(entries: AutoMatchEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const byKind = new Map<AllocationKind, string[]>();
  for (const e of entries) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.targetId]);

  const allocatedMaps = new Map<AllocationKind, Map<string, AllocationDetail[]>>();
  for (const [kind, ids] of byKind) allocatedMaps.set(kind, await getAllocationsByTargets(kind, ids));

  const unallocated = entries.filter((e) => (allocatedMaps.get(e.kind)?.get(e.targetId)?.length ?? 0) === 0 && e.partyId);
  if (unallocated.length === 0) return;

  const taxByKey = await loadTaxByKey(
    unallocated.filter((e) => e.kind !== "purchaseAllocation").map((e) => e.ntsSendKey ?? "").filter(Boolean)
  );

  const [confirmedRows, parties, aliasRows] = await Promise.all([
    prisma.bankTransactionConfirm.findMany({ where: { status: "confirmed" }, select: { transRefKey: true } }),
    prisma.party.findMany({ select: { id: true, code: true, name: true } }),
    prisma.bankPartyAlias.findMany({ include: { party: { select: { id: true, code: true, name: true } } } }),
  ]);
  const confirmedKeys = confirmedRows.map((c) => c.transRefKey);
  if (confirmedKeys.length === 0) return;

  const [bankRows, existingAllocs] = await Promise.all([
    prisma.bankTransaction.findMany({ where: { transRefKey: { in: confirmedKeys } }, orderBy: { transDT: "asc" } }),
    prisma.bankAllocation.findMany({ where: { transRefKey: { in: confirmedKeys } }, select: { transRefKey: true, amount: true } }),
  ]);
  const consumedByKey = new Map<string, number>();
  for (const a of existingAllocs) consumedByKey.set(a.transRefKey, (consumedByKey.get(a.transRefKey) ?? 0) + a.amount);
  const aliases = new Map<string, PartyLite>(aliasRows.map((a) => [a.normalized, a.party]));

  const bank = bankRows.map((b) => ({
    transRefKey: b.transRefKey,
    deposit: b.deposit,
    withdraw: b.withdraw,
    remaining: (b.deposit > 0 ? b.deposit : b.withdraw) - (consumedByKey.get(b.transRefKey) ?? 0),
    partyId: matchPartyForRemark(b.transRemark, parties, aliases)?.id ?? null,
  }));

  const toCreate: { transRefKey: string; kind: AllocationKind; targetId: string; amount: number }[] = [];
  for (const e of unallocated) {
    const dir = directionForKind(e.kind);
    const tax = e.kind === "purchaseAllocation" ? null : (taxByKey.get(e.ntsSendKey ?? "") ?? null);
    const candidates: number[] = [];
    if (tax != null && Math.round(tax) !== 0) candidates.push(e.amount + tax);
    candidates.push(e.amount);

    for (const value of candidates) {
      const hit = bank.find(
        (b) =>
          b.partyId === e.partyId &&
          (dir === "deposit" ? b.deposit > 0 : b.withdraw > 0) &&
          Math.round(b.remaining) === Math.round(value) &&
          !toCreate.some((t) => t.transRefKey === b.transRefKey)
      );
      if (hit) {
        toCreate.push({ transRefKey: hit.transRefKey, kind: e.kind, targetId: e.targetId, amount: value });
        break;
      }
    }
  }
  if (toCreate.length > 0) {
    await prisma.bankAllocation.createMany({
      data: toCreate.map((t) => ({ ...t, auto: true, createdByEmail: "system" })),
    });
  }
}

// ── 수기 매칭 ────────────────────────────────────────────────────────────────────────

export type MatchCandidate = {
  transRefKey: string;
  date: string;
  remark: string;
  amount: number; // 그 거래의 원래 입금/출금액
  remaining: number; // 아직 배분에 안 쓰인 잔액
  partyMatched: boolean;
};

// 수기 매칭 팝업의 후보 목록 — "확정"된 거래 중 아직 잔액이 남은 것만, 거래처 일치 우선·
// 최신순으로 보여준다. search가 있으면 적요(송금인) 문자열로도 좁힌다.
export async function searchMatchCandidates(
  direction: "deposit" | "withdraw",
  opts: { partyId?: string | null; search?: string } = {}
): Promise<MatchCandidate[]> {
  const confirmedRows = await prisma.bankTransactionConfirm.findMany({
    where: { status: "confirmed" },
    select: { transRefKey: true },
  });
  const keys = confirmedRows.map((c) => c.transRefKey);
  if (keys.length === 0) return [];

  const [bankRows, allocRows, parties, aliasRows] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        transRefKey: { in: keys },
        ...(direction === "deposit" ? { deposit: { gt: 0 } } : { withdraw: { gt: 0 } }),
      },
      orderBy: { transDT: "desc" },
    }),
    prisma.bankAllocation.findMany({ where: { transRefKey: { in: keys } }, select: { transRefKey: true, amount: true } }),
    prisma.party.findMany({ select: { id: true, code: true, name: true } }),
    prisma.bankPartyAlias.findMany({ include: { party: { select: { id: true, code: true, name: true } } } }),
  ]);
  const consumedByKey = new Map<string, number>();
  for (const a of allocRows) consumedByKey.set(a.transRefKey, (consumedByKey.get(a.transRefKey) ?? 0) + a.amount);
  const aliases = new Map<string, PartyLite>(aliasRows.map((a) => [a.normalized, a.party]));

  const search = opts.search?.trim().toLowerCase();
  const out: MatchCandidate[] = [];
  for (const b of bankRows) {
    const total = direction === "deposit" ? b.deposit : b.withdraw;
    const remaining = total - (consumedByKey.get(b.transRefKey) ?? 0);
    if (remaining <= EPS) continue;
    if (search && !b.transRemark.toLowerCase().includes(search)) continue;
    const partyId = matchPartyForRemark(b.transRemark, parties, aliases)?.id ?? null;
    out.push({
      transRefKey: b.transRefKey,
      date: toDate(b.transDT),
      remark: b.transRemark,
      amount: total,
      remaining,
      partyMatched: opts.partyId != null && partyId === opts.partyId,
    });
  }
  out.sort((a, b) => (a.partyMatched === b.partyMatched ? 0 : a.partyMatched ? -1 : 1));
  return out.slice(0, 100);
}

export type AllocationActionResult = { ok: true } | { ok: false; message: string };

async function getTargetState(
  kind: AllocationKind,
  targetId: string
): Promise<{ amount: number; confirmedAt: Date | null } | null> {
  if (kind === "sale") {
    const s = await prisma.sale.findUnique({
      where: { id: targetId },
      select: { amount: true, settlementConfirmedAt: true },
    });
    return s ? { amount: s.amount, confirmedAt: s.settlementConfirmedAt } : null;
  }
  if (kind === "purchaseAllocation") {
    const a = await prisma.purchaseAllocation.findUnique({
      where: { id: targetId },
      select: { amount: true, settlementConfirmedAt: true },
    });
    return a ? { amount: a.amount, confirmedAt: a.settlementConfirmedAt } : null;
  }
  const c = await prisma.customsAdvance.findUnique({
    where: { id: targetId },
    select: { amount: true, settlementConfirmedAt: true },
  });
  return c ? { amount: c.amount, confirmedAt: c.settlementConfirmedAt } : null;
}

export { getTargetState as getAllocationTargetState };

export async function createManualAllocation(
  kind: AllocationKind,
  targetId: string,
  transRefKey: string,
  amount: number,
  createdByEmail: string
): Promise<AllocationActionResult> {
  if (!(amount > 0)) return { ok: false, message: "배분 금액을 입력하세요." };

  const target = await getTargetState(kind, targetId);
  if (!target) return { ok: false, message: "대상을 찾을 수 없습니다." };
  if (target.confirmedAt) return { ok: false, message: "이미 확정된 건입니다. 먼저 확정을 해제하세요." };

  const confirm = await prisma.bankTransactionConfirm.findUnique({ where: { transRefKey } });
  if (!confirm || confirm.status !== "confirmed") {
    return { ok: false, message: "입출금내역에서 확정된 거래만 배분할 수 있습니다." };
  }
  const bankTx = await prisma.bankTransaction.findUnique({ where: { transRefKey } });
  if (!bankTx) return { ok: false, message: "은행 거래를 찾을 수 없습니다." };

  const dir = directionForKind(kind);
  const txTotal = dir === "deposit" ? bankTx.deposit : bankTx.withdraw;

  const [targetAgg, txAgg] = await Promise.all([
    prisma.bankAllocation.aggregate({ where: { kind, targetId }, _sum: { amount: true } }),
    prisma.bankAllocation.aggregate({ where: { transRefKey }, _sum: { amount: true } }),
  ]);
  const targetRemaining = target.amount - (targetAgg._sum.amount ?? 0);
  const txRemaining = txTotal - (txAgg._sum.amount ?? 0);

  if (amount > targetRemaining + EPS) {
    return { ok: false, message: `배분 금액이 전표 잔액(${Math.round(targetRemaining).toLocaleString()}원)을 초과합니다.` };
  }
  if (amount > txRemaining + EPS) {
    return { ok: false, message: `배분 금액이 은행거래 잔액(${Math.round(txRemaining).toLocaleString()}원)을 초과합니다.` };
  }

  await prisma.bankAllocation.create({ data: { transRefKey, kind, targetId, amount, auto: false, createdByEmail } });
  return { ok: true };
}

export async function deleteAllocation(id: string): Promise<AllocationActionResult> {
  const alloc = await prisma.bankAllocation.findUnique({ where: { id } });
  if (!alloc) return { ok: false, message: "배분 내역을 찾을 수 없습니다." };
  const target = await getTargetState(alloc.kind as AllocationKind, alloc.targetId);
  if (target?.confirmedAt) return { ok: false, message: "확정된 건은 먼저 확정을 해제해야 배분을 취소할 수 있습니다." };
  await prisma.bankAllocation.delete({ where: { id } });
  return { ok: true };
}

// ── 입출금내역 화면의 "전표연동" 칸 ──────────────────────────────────────────────────

// count = 이 은행거래에 연동된 **서로 다른 전표(대상) 수** — 같은 전표에 여러 번 나눠
// 배분해도(부분 매칭을 여러 번 한 경우) 1건으로 센다. label은 짧은 화면 표시용, 여러 건이면
// count까지 반영한 문구다(count===1이면 어느 전표인지 이름까지 담는다).
export type BankTransactionLink = { kind: "voucher" | "customs"; label: string; count: number };

export async function getBankTransactionLinks(): Promise<Record<string, BankTransactionLink>> {
  const allocs = await prisma.bankAllocation.findMany();
  if (allocs.length === 0) return {};

  const byKey = new Map<string, typeof allocs>();
  for (const a of allocs) byKey.set(a.transRefKey, [...(byKey.get(a.transRefKey) ?? []), a]);

  const saleIds = allocs.filter((a) => a.kind === "sale").map((a) => a.targetId);
  const paIds = allocs.filter((a) => a.kind === "purchaseAllocation").map((a) => a.targetId);
  const caIds = allocs.filter((a) => a.kind === "customsAdvance").map((a) => a.targetId);
  const [sales, pas, cas] = await Promise.all([
    saleIds.length
      ? prisma.sale.findMany({ where: { id: { in: saleIds } }, select: { id: true, party: { select: { name: true } } } })
      : Promise.resolve([]),
    paIds.length
      ? prisma.purchaseAllocation.findMany({
          where: { id: { in: paIds } },
          select: { id: true, purchase: { select: { party: { select: { name: true } } } } },
        })
      : Promise.resolve([]),
    caIds.length
      ? prisma.customsAdvance.findMany({
          where: { id: { in: caIds } },
          select: {
            id: true,
            payeeParty: { select: { name: true } },
            party: { select: { name: true } },
            sale: { select: { party: { select: { name: true } } } },
          },
        })
      : Promise.resolve([]),
  ]);
  const saleName = new Map(sales.map((s) => [s.id, s.party.name]));
  const paName = new Map(pas.map((p) => [p.id, p.purchase.party.name]));
  const caName = new Map(cas.map((c) => [c.id, c.payeeParty?.name ?? c.party?.name ?? c.sale?.party.name ?? ""]));

  function labelFor(a: (typeof allocs)[number]): { kind: "voucher" | "customs"; text: string } {
    if (a.kind === "sale") return { kind: "voucher", text: `일반전표(매출) · ${saleName.get(a.targetId) ?? ""}` };
    if (a.kind === "purchaseAllocation") return { kind: "voucher", text: `일반전표(매입) · ${paName.get(a.targetId) ?? ""}` };
    return { kind: "customs", text: `관세전표 · ${caName.get(a.targetId) ?? ""}` };
  }

  const links: Record<string, BankTransactionLink> = {};
  for (const [transRefKey, list] of byKey) {
    // 부분 매칭을 여러 번 나눠 했을 수 있으므로, "몇 건과 연동됐나"는 배분 행 수가 아니라
    // 서로 다른 (kind, targetId) 조합 수로 센다 — 안 그러면 전표 1건에 3번 나눠 배분한 것도
    // "3건 연동"으로 보여 실제보다 부풀려진다.
    const distinct = new Map<string, (typeof list)[number]>();
    for (const a of list) distinct.set(`${a.kind}-${a.targetId}`, a);
    const targets = [...distinct.values()];

    if (targets.length === 1) {
      const l = labelFor(targets[0]);
      links[transRefKey] = { kind: l.kind, label: l.text, count: 1 };
    } else {
      const hasVoucher = targets.some((a) => a.kind !== "customsAdvance");
      links[transRefKey] = {
        kind: hasVoucher ? "voucher" : "customs",
        label: `전표 ${targets.length}건 연동`,
        count: targets.length,
      };
    }
  }
  return links;
}
