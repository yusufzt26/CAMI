import { useEffect, useState, type ReactNode } from "react";

export function Section({ title, badge, children, defaultOpen = true }: { title: string; badge?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? "open" : ""}`}>
      <button className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev" aria-hidden>
          ▸
        </span>
        <span className="section-title">{title}</span>
        {badge}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

/** Number input that only commits valid numbers, so typing "-" or "1." does not fight the user. */
export function NumberField({
  value,
  onChange,
  step = 1,
  min,
  suffix,
  label,
  width,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  suffix?: string;
  label?: string;
  width?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="num" style={width ? { width } : undefined}>
      {label && <span className="num-label">{label}</span>}
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(v) && (min === undefined || v >= min)) onChange(v);
        }}
        onBlur={() => setText(String(value))}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </label>
  );
}

export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="row" title={hint}>
      <span className="row-label">{label}</span>
      <div className="row-control">{children}</div>
    </div>
  );
}
