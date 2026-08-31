"use client";

import { useState } from "react";
import { deleteParty } from "@/app/(app)/parties/actions";
import { DeleteButton } from "@/components/DeleteButton";
import { PartyContactEditButton } from "@/components/PartyContactEditButton";
import { SortableTh } from "@/components/SortableTh";
import { formatBizNo } from "@/lib/format";
import { sortRowsBy, toggleSort, type SortState, type SortValue } from "@/lib/tableSort";

export type PartyTableRow = {
  id: string;
  code: string | null;
  name: string;
  bizNo: string | null;
  contactName: string | null;
  contactPhone: string | null;
  email: string | null;
  note: string;
  source: string;
};

type PartySortKey = "code" | "name" | "bizNo" | "contactName" | "contactPhone" | "email" | "note";

function partySortValue(p: PartyTableRow, key: PartySortKey): SortValue {
  // 사업자번호는 하이픈이 섞여 있으니 화면에 보이는 형식(formatBizNo)으로 정렬한다 —
  // 어차피 자릿수가 같아 문자열 비교로도 숫자순과 결과가 같다.
  if (key === "bizNo") return p.bizNo ? formatBizNo(p.bizNo) : null;
  return p[key];
}

// 이 표만 클라이언트 컴포넌트로 뽑은 이유: 열 정렬은 서버를 다시 부를 필요가 없는 화면 동작인데,
// 페이지가 서버 컴포넌트라 useState를 쓸 수 없었다.
export function PartyTable({ parties, isAdmin }: { parties: PartyTableRow[]; isAdmin: boolean }) {
  const [sort, setSort] = useState<SortState<PartySortKey>>(null);
  const sorted = sortRowsBy(parties, sort, partySortValue);
  const onSort = (k: PartySortKey) => setSort((prev) => toggleSort(prev, k));

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted">
          <SortableTh label="코드" sortKey="code" state={sort} onSort={onSort} />
          <SortableTh label="거래처명" sortKey="name" state={sort} onSort={onSort} />
          <SortableTh label="사업자등록번호" sortKey="bizNo" state={sort} onSort={onSort} />
          <SortableTh label="담당자명" sortKey="contactName" state={sort} onSort={onSort} />
          <SortableTh label="담당자 연락처" sortKey="contactPhone" state={sort} onSort={onSort} />
          <SortableTh label="담당자 이메일" sortKey="email" state={sort} onSort={onSort} />
          <SortableTh label="비고" sortKey="note" state={sort} onSort={onSort} />
          {/* 수정·삭제는 버튼 열이라 정렬 대상이 아니다. */}
          {isAdmin && <th className="py-2 pr-3">수정</th>}
          <th className="py-2 pr-2 text-right">삭제</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <tr key={p.id} className="border-b border-border/60">
            <td className="py-2 pr-3 whitespace-nowrap num text-muted">{p.code ?? "-"}</td>
            <td className="py-2 pr-3 text-fg">{p.name}</td>
            <td className="py-2 pr-3 whitespace-nowrap num text-muted">
              {p.bizNo ? formatBizNo(p.bizNo) : "-"}
            </td>
            <td className="py-2 pr-3 whitespace-nowrap text-muted">{p.contactName ?? "-"}</td>
            <td className="py-2 pr-3 whitespace-nowrap text-muted">{p.contactPhone ?? "-"}</td>
            <td className="py-2 pr-3 text-muted">{p.email ?? "-"}</td>
            <td className="py-2 pr-3 text-muted">{p.note}</td>
            {isAdmin && (
              <td className="py-2 pr-3 whitespace-nowrap">
                <PartyContactEditButton
                  party={{
                    id: p.id,
                    name: p.name,
                    contactName: p.contactName,
                    contactPhone: p.contactPhone,
                    email: p.email,
                  }}
                />
              </td>
            )}
            <td className="py-2 pr-2 text-right">
              {p.source === "manual" ? (
                <DeleteButton
                  action={deleteParty}
                  id={p.id}
                  confirmMessage={`"${p.name}" 거래처를 삭제할까요?`}
                  inUseMessage="매출 또는 매입에서 사용 중인 거래처라 삭제할 수 없습니다."
                  reasonMessages={{
                    from_tax_invoice: "세금계산서에서 자동으로 등록된 거래처라 삭제할 수 없습니다.",
                    in_use: "매출 또는 매입에서 사용 중인 거래처라 삭제할 수 없습니다.",
                  }}
                />
              ) : (
                <span className="text-xs text-muted" title="세금계산서에서 자동으로 등록된 거래처는 삭제할 수 없습니다.">
                  삭제불가
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
