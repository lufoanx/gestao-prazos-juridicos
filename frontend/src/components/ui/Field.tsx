import {
  useId, type InputHTMLAttributes, type SelectHTMLAttributes,
  type TextareaHTMLAttributes, type ReactNode,
} from "react";

interface FieldShellProps {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
}
function FieldShell({ label, required, hint, error, htmlFor, children }: FieldShellProps) {
  return (
    <div className={`field${error ? " field--invalid" : ""}`}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}{required ? <span className="field__req" aria-hidden>*</span> : null}
      </label>
      {children}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? <span className="field__error" role="alert">{error}</span> : null}
    </div>
  );
}

type BaseFieldProps = { label: string; hint?: string; error?: string };

export function Input({
  label, hint, error, id, required, ...rest
}: BaseFieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell label={label} required={required} hint={hint} error={error} htmlFor={fid}>
      <input
        id={fid} className="input" required={required}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export function Select({
  label, hint, error, id, required, children, ...rest
}: BaseFieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell label={label} required={required} hint={hint} error={error} htmlFor={fid}>
      <select
        id={fid} className="select" required={required}
        aria-invalid={error ? true : undefined}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export function Textarea({
  label, hint, error, id, required, ...rest
}: BaseFieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell label={label} required={required} hint={hint} error={error} htmlFor={fid}>
      <textarea
        id={fid} className="textarea" required={required}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
    </FieldShell>
  );
}
