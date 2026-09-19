"use client";
import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

interface PasswordInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function PasswordInput({ label, hint, error, id, required, ...rest }: PasswordInputProps) {
  const auto = useId();
  const fid = id ?? auto;
  const [show, setShow] = useState(false);
  return (
    <div className={`field${error ? " field--invalid" : ""}`}>
      <label className="field__label" htmlFor={fid}>
        {label}{required ? <span className="field__req" aria-hidden>*</span> : null}
      </label>
      <div className="pw">
        <input
          id={fid} className="input" type={show ? "text" : "password"}
          required={required} aria-invalid={error ? true : undefined}
          {...rest}
        />
        <button
          type="button" className="pw__toggle"
          onClick={() => setShow((s) => !s)}
          aria-pressed={show}
          aria-label={show ? "Ocultar senha" : "Mostrar senha"}
        >
          {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? <span className="field__error" role="alert">{error}</span> : null}
    </div>
  );
}
