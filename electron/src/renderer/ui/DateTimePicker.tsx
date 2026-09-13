import { useMemo, useState } from "react";
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
}

/* 周一起始，和国内日历习惯一致 */
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateText(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
export function DateTimePicker({ mode, value, onChange }: DateTimePickerProps) {
  const now = useMemo(() => new Date(), []);
  const parsed = parseValue(value);
  const [view, setView] = useState(() => ({
    year: parsed.date?.year ?? now.getFullYear(),
    month: parsed.date?.month ?? now.getMonth()
  }));

  const time = parsed.time ?? { hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() };
  const timeText = `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  const todayText = dateText(now);

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
