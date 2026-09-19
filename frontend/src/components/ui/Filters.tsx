import { useId, type ReactNode } from "react";
import { Search } from "lucide-react";

/** Barra de filtros. Layout apenas — o estado é controlado por quem usa. */
export function Filters({ children }: { children: ReactNode }) {
  return <div className="filters">{children}</div>;
}

interface SearchFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}
export function SearchField({ label, value, onChange, placeholder }: SearchFieldProps) {
  const id = useId();
  return (
    <div className="field filters__search">
      <label className="field__label" htmlFor={id}>{label}</label>
      <div className="app-header__search" style={{ maxWidth: "none" }}>
        <Search size={16} aria-hidden />
        <input
          id={id} className="input" type="search" value={value}
          placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
