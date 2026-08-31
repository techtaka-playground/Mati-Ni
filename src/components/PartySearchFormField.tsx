"use client";

import { useState } from "react";
import { PartySearchSelect, type PartyOption } from "@/components/PartySearchSelect";

// 순수 GET 폼(서버 액션 없이 <form method="get">으로 페이지를 다시 그리는 화면) 안에서
// PartySearchSelect를 쓰기 위한 얇은 래퍼 — 선택값을 hidden input(name)에 반영해서, 폼
// 자체는 그대로 네이티브 제출로 동작한다(손익조회 화면, 2026-08-27 — 거래처가 많아지면
// <select> 스크롤로 찾기 어렵다는 이유로 검색 방식으로 바꿈).
export function PartySearchFormField({
  name,
  parties,
  defaultValue,
  placeholder,
  className,
}: {
  name: string;
  parties: PartyOption[];
  defaultValue: string;
  placeholder?: string;
  className?: string;
}) {
  const [value, setValue] = useState<string | null>(defaultValue || null);

  return (
    <>
      <input type="hidden" name={name} value={value ?? ""} />
      <PartySearchSelect
        parties={parties}
        value={value}
        onChange={setValue}
        placeholder={placeholder}
        className={className}
      />
    </>
  );
}
