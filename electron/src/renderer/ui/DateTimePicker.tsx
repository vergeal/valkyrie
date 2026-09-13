import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";

type Mode = "date" | "datetime" | "time";

interface DateTimePickerProps {
  mode: Mode;
  /**
   * 控件值（空串表示未选）：
   * date = YYYY-MM-DD，datetime = YYYY-MM-DDTHH:MM:SS，time = HH:MM:SS
   */
  value: string;
  /** 回传同样格式的控件值 */
  onChange: (next: string) => void;
  /** 输入框里的文字是否合法（非法时外层禁用保存） */
  onValidityChange?: (valid: boolean) => void;
}

/* 周一起始，和国内日历习惯一致 */
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateText(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const PLACEHOLDER: Record<Mode, string> = {
  date: "2026-09-13",
  datetime: "2026-09-13 14:30:00",
  time: "14:30:00"
};

/** 控件值 → 输入框里显示的文字（日期时间用空格分隔，比 T 好读） */
function screenText(value: string, mode: Mode): string {
  const [datePart = "", timePart = ""] = value.split("T");

  if (mode === "time")
    return timePart || datePart;

  return mode === "date" ? datePart : `${datePart} ${timePart}`.trim();
}

/** 解析日期段：YYYY-M-D 或 YYYYMMDD */
function readDate(text: string): { year: number; month: number; day: number } | null {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(text);

  if (!parts)
    return null;

  const year = Number(parts[1]);
  const month = Number(parts[2]) - 1;
  const day = Number(parts[3]);
  const probe = new Date(year, month, day);

  /* 反查一遍，挡住 2026-02-31 这种不存在的日期 */
  return probe.getFullYear() === year && probe.getMonth() === month && probe.getDate() === day
    ? { year, month, day }
    : null;
}

/** 解析时间段：H:M[:S] */
function readTime(text: string): { hour: number; minute: number; second: number } | null {
  const parts = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);

  if (!parts)
    return null;

  const hour = Number(parts[1]);
  const minute = Number(parts[2]);
  const second = Number(parts[3] ?? 0);

  return hour < 24 && minute < 60 && second < 60 ? { hour, minute, second } : null;
}

/**
 * 用户手输的文字 → 控件值，认不出来返回 null。
 * 容忍 - / . 年月日 / 空格 / T 等常见写法，日期时间可以只写日期部分。
 */
function parseInput(text: string, mode: Mode, fallbackTime: string): string | null {
  const cleaned = text.trim()
    .replace(/[年月]/g, "-")
    .replace(/日/g, "")
    .replace(/[/.]/g, "-")
    .replace(/[Tt]/g, " ")
    .replace(/\s+/g, " ");

  if (!cleaned)
    return null;

  const [first = "", second = ""] = cleaned.split(" ");

  if (mode === "time") {
    const time = readTime(first) ?? readTime(second);

    return time ? `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}` : null;
  }

  const date = readDate(first);

  if (!date)
    return null;

  const text2 = `${date.year}-${pad(date.month + 1)}-${pad(date.day)}`;

  if (mode === "date")
    return text2;

  const time = readTime(second);

  /* 只写日期时沿用当前选中的时间，不把时分秒清零 */
  if (!time && !second)
    return `${text2}T${fallbackTime}`;

  return time ? `${text2}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}` : null;
}

/** 解析控件值：日期、时间都可以缺省（未选） */
function parseValue(value: string) {
  const [datePart = "", timePart = ""] = value.split("T");
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timePart);

  return {
    date: date
      ? { year: Number(date[1]), month: Number(date[2]) - 1, day: Number(date[3]) }
      : null,
    time: time
      ? { hour: Number(time[1]), minute: Number(time[2]), second: Number(time[3] ?? 0) }
      : null
  };
}

/**
 * 自绘的日期 / 日期时间 / 时间选择器（放进编辑气泡里用）。
 * 原生 `<input type="date">` 的分段编辑和系统日历面板样式改不动，
 * 这里自己画：月历网格 + 时分秒下拉，配色与间距都跟应用主题一致。
 */
export function DateTimePicker({ mode, value, onChange, onValidityChange }: DateTimePickerProps) {
  const now = useMemo(() => new Date(), []);
  const parsed = parseValue(value);
  const [view, setView] = useState(() => ({
    year: parsed.date?.year ?? now.getFullYear(),
    month: parsed.date?.month ?? now.getMonth()
  }));
  /* 输入框里的文字自己维护：用户正在打字时不能被外部值覆盖 */
  const [text, setText] = useState(() => screenText(value, mode));
  const [invalid, setInvalid] = useState(false);
  const emitted = useRef<string | null>(null);

  const time = parsed.time ?? { hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() };
  const timeText = `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  const todayText = dateText(now);

  /* 外部值变了（日历点选、外层「今天/明天/现在」）→ 同步输入框文字，并把日历翻到那一月 */
  useEffect(() => {
    if (emitted.current === value)
      return;

    setText(screenText(value, mode));
    setInvalid(false);

    const date = parseValue(value).date;

    if (date && mode !== "time")
      setView({ year: date.year, month: date.month });
  }, [value, mode]);

  /** 输入框每次变化：能解析就立刻回传（日历跟着走），不能解析就标红 */
  function changeText(next: string) {
    setText(next);

    const parsedText = parseInput(next, mode, timeText);
    const empty = !next.trim();

    setInvalid(!parsedText && !empty);
    onValidityChange?.(Boolean(parsedText) || empty);

    if (parsedText) {
      emitted.current = parsedText;
      onChange(parsedText);
    }
  }

  function shiftMonth(delta: number) {
    setView(previous => {
      const next = new Date(previous.year, previous.month + delta, 1);

      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  /** 选日期：日期模式直接给日期，日期时间模式保留当前选中的时间 */
  function withDay(text: string): string {
    return mode === "date" ? text : `${text}T${timeText}`;
  }

  function pickTime(patch: Partial<typeof time>) {
    const next = { ...time, ...patch };
    const text = `${pad(next.hour)}:${pad(next.minute)}:${pad(next.second)}`;

    if (mode === "time") {
      onChange(text);
      return;
    }

    const date = parsed.date ?? { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };

    onChange(`${dateText(new Date(date.year, date.month, date.day))}T${text}`);
  }

  /* 6×7 网格：前后补上相邻月份的日子，点击时自动切换月份 */
  const cells = useMemo(() => {
    const first = new Date(view.year, view.month, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(view.year, view.month, 1 - offset);

    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);

      day.setDate(start.getDate() + index);
      return day;
    });
  }, [view.year, view.month]);

  const selectedText = parsed.date
    ? dateText(new Date(parsed.date.year, parsed.date.month, parsed.date.day))
    : null;

  return (
    <div className={`dtp is-${mode}`}>
      {/* 支持直接手输：YYYY-MM-DD、2026/09/13、20260913、带时分秒都认 */}
      <div className={`dtp-input-row${invalid ? " is-invalid" : ""}`}>
        <span className="dtp-input-icon" aria-hidden="true">
          <Icon name={mode === "time" ? "clock" : "calendarClock"} size={13} />
        </span>
        <input
          className="dtp-input"
          value={text}
          spellCheck={false}
          placeholder={PLACEHOLDER[mode]}
          aria-label={`输入${mode === "time" ? "时间" : "日期时间"}`}
          onChange={event => changeText(event.target.value)}
        />
      </div>

      {invalid && <div className="dtp-warn">格式无法识别，例如 {PLACEHOLDER[mode]}</div>}

      {mode !== "time" && (
        <>
          <div className="dtp-head">
            <button type="button" className="icon-btn dtp-nav" aria-label="上个月" onClick={() => shiftMonth(-1)}>
              <Icon name="chevronLeft" size={13} />
            </button>

            <button
              type="button"
              className="dtp-title"
              title="回到今天"
              onClick={() => {
                setView({ year: now.getFullYear(), month: now.getMonth() });
                onChange(withDay(todayText));
              }}
            >
              {view.year} 年 {view.month + 1} 月
            </button>

            <button type="button" className="icon-btn dtp-nav" aria-label="下个月" onClick={() => shiftMonth(1)}>
              <Icon name="chevronRight" size={13} />
            </button>
          </div>

          <div className="dtp-week">
            {WEEK.map(day => <span key={day}>{day}</span>)}
          </div>

          <div className="dtp-grid">
            {cells.map(day => {
              const text = dateText(day);
              const classes = [
                "dtp-day",
                day.getMonth() === view.month ? "" : "is-outside",
                text === selectedText ? "is-selected" : "",
                text === todayText ? "is-today" : ""
              ].filter(Boolean).join(" ");

              return (
                <button
                  key={text}
                  type="button"
                  className={classes}
                  onClick={() => {
                    if (day.getMonth() !== view.month)
                      setView({ year: day.getFullYear(), month: day.getMonth() });

                    onChange(withDay(text));
                  }}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        </>
      )}

      {mode !== "date" && (
        <div className="dtp-time">
          <span className="dtp-time-label">时间</span>
          <TimeSelect value={time.hour} count={24} onChange={hour => pickTime({ hour })} />
          <span className="dtp-colon">:</span>
          <TimeSelect value={time.minute} count={60} onChange={minute => pickTime({ minute })} />
          <span className="dtp-colon">:</span>
          <TimeSelect value={time.second} count={60} onChange={second => pickTime({ second })} />
        </div>
      )}
    </div>
  );
}

function TimeSelect({ value, count, onChange }: { value: number; count: number; onChange: (next: number) => void }) {
  return (
    <select
      className="dtp-select"
      value={String(value)}
      aria-label="时间"
      onChange={event => onChange(Number(event.target.value))}
    >
      {Array.from({ length: count }, (_, index) => (
        <option key={index} value={index}>{pad(index)}</option>
      ))}
    </select>
  );
}
