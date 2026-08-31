"use client";

import { useState } from "react";
import { commaInput, numOf } from "@/lib/format";

export function AmountInput({
  name,
  defaultValue = "",
  required,
  className,
  placeholder,
}: {
  name: string;
  defaultValue?: string | number;
  required?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [display, setDisplay] = useState(
    defaultValue === "" ? "" : commaInput(String(defaultValue))
  );

  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        placeholder={placeholder}
        onChange={(e) => setDisplay(commaInput(e.target.value))}
        required={required}
        className={className}
      />
      <input type="hidden" name={name} value={String(numOf(display))} />
    </>
  );
}
