"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PartyOption = { id: string; code: string | null; name: string };

// 거래처를 **코드 또는 거래처명으로 검색해서** 고르는 입력. 거래처 마스터에 이미 있는 것만
// 고를 수 있고, 여기서 새 거래처를 만들지는 않는다 — 관세전표를 입력하다가 오타로 거래처가
// 새로 생겨버리면 거래처 목록이 금방 지저분해지고, 손익 집계도 거래처가 쪼개져서 어긋난다.
// (거래처 추가는 /parties 화면에서, 세금계산서 자동등록은 사업자번호 기준으로만 한다.)
//
// <select>를 쓰지 않은 이유: 거래처가 수십~수백 건이면 스크롤로 찾기 어렵고, 코드로 찾는
// 사람과 이름으로 찾는 사람이 모두 있어서 타이핑 검색이 필요하다.
export function PartySearchSelect({
  parties,
  value,
  onChange,
  placeholder = "코드 또는 거래처명 검색",
  disabled = false,
  className = "",
}: {
  parties: PartyOption[];
  value: string | null; // 선택된 party id (없으면 null)
  onChange: (partyId: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const selected = useMemo(() => parties.find((p) => p.id === value) ?? null, [parties, value]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // 바깥을 클릭하면 닫는다 — 팝업 안에서 쓰이므로 열린 채로 남아 다른 입력을 가리면 안 된다.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return parties.slice(0, 30);
    // 코드는 앞자리 일치가 자연스럽고(0001 → 0001x), 이름은 부분 일치가 자연스럽다.
    // 앞에서 일치하는 것을 위로 올려서, 정확히 아는 코드를 치면 첫 줄에 나오게 한다.
    const scored = parties
      .map((p) => {
        const code = (p.code ?? "").toLowerCase();
        const name = p.name.toLowerCase();
        if (code && code.startsWith(q)) return { p, rank: 0 };
        if (name.startsWith(q)) return { p, rank: 1 };
        if (code.includes(q)) return { p, rank: 2 };
        if (name.includes(q)) return { p, rank: 3 };
        return null;
      })
      .filter((x): x is { p: PartyOption; rank: number } => x !== null)
      .sort((a, b) => a.rank - b.rank);
    return scored.slice(0, 30).map((x) => x.p);
  }, [parties, query]);

  useEffect(() => setHighlight(0), [query, open]);

  function pick(p: PartyOption) {
    onChange(p.id);
    setQuery("");
    setOpen(false);
  }

  // 이미 고른 상태에서는 입력창 대신 선택된 거래처를 보여준다 — 무엇이 선택됐는지가 검색어보다
  // 중요하고, 잘못 골랐을 때 지우고 다시 찾는 흐름이 분명해진다.
  if (selected) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <span className="num text-xs text-muted">{selected.code ?? "-"}</span>
        <span className="flex-1 truncate text-sm text-fg" title={selected.name}>
          {selected.name}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              setOpen(true);
            }}
            className="text-xs text-muted hover:underline"
          >
            변경
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <input
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            // 폼 안에서 쓰이므로 Enter가 저장으로 새지 않게 막는다.
            e.preventDefault();
            if (open && matches[highlight]) pick(matches[highlight]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
      />
      {open && (
        <ul className="absolute z-10 mt-1 max-h-52 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
          {matches.length === 0 ? (
            <li className="px-2 py-2 text-xs text-muted">
              일치하는 거래처가 없습니다 — 거래처 화면에서 먼저 등록해주세요.
            </li>
          ) : (
            matches.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(p)}
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${
                    i === highlight ? "bg-gray-95" : ""
                  }`}
                >
                  <span className="num w-10 shrink-0 text-xs text-muted">{p.code ?? "-"}</span>
                  <span className="truncate text-fg">{p.name}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
