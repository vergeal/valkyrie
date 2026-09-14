import { useEffect, useState } from "react";

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  ariaLabel?: string;
  onChange: (value: number) => void;
}

/**
 * 数字输入：不限定固定档位，用户自己填。输入过程中合法就即时生效，
 * 失焦 / 回车时把空值或越界值夹回合法范围。
 */
export function NumberField({ value, min, max, ariaLabel, onChange }: NumberFieldProps) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const clamp = (input: string) => {
    const parsed = Math.round(Number(input));

    if (!Number.isFinite(parsed))
      return value;

    return Math.min(max, Math.max(min, parsed));
  };

  return (
    <input
      type="number"
      className="opt-number-input"
      value={text}
      min={min}
      max={max}
      aria-label={ariaLabel}
      onChange={event => {
        const input = event.target.value;
        setText(input);

        const parsed = Number(input);

        if (Number.isFinite(parsed) && parsed >= min && parsed <= max)
          onChange(Math.round(parsed));
      }}
      onBlur={() => {
        const next = clamp(text);
        setText(String(next));

        if (next !== value)
          onChange(next);
      }}
      onKeyDown={event => {
        if (event.key === "Enter")
          (event.target as HTMLInputElement).blur();
      }}
    />
  );
}
