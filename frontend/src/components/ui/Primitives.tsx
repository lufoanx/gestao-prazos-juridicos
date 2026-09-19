import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { BadgeTone } from "@/lib/urgency.mjs";

/* ---------- Button ---------- */
type BtnVariant = "primary" | "secondary" | "teal" | "ghost" | "danger";
type BtnSize = "sm" | "md" | "lg";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  block?: boolean;
  iconOnly?: boolean;
}
export function Button({
  variant = "primary", size = "md", block, iconOnly,
  className = "", children, type = "button", ...rest
}: ButtonProps) {
  const cls = [
    "btn", `btn--${variant}`,
    size !== "md" ? `btn--${size}` : "",
    block ? "btn--block" : "",
    iconOnly ? "btn--icon" : "",
    className,
  ].filter(Boolean).join(" ");
  return <button type={type} className={cls} {...rest}>{children}</button>;
}

/* ---------- Badge ---------- */
export function Badge({
  tone = "neutral", dot, children,
}: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot ? <span className="badge__dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

/* ---------- Avatar ---------- */
function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}
export function Avatar({
  name, size = "md", navy,
}: { name: string; size?: "sm" | "md"; navy?: boolean }) {
  const cls = ["avatar", size === "sm" ? "avatar--sm" : "", navy ? "avatar--navy" : ""]
    .filter(Boolean).join(" ");
  return <span className={cls} aria-hidden title={name}>{initials(name)}</span>;
}

/* ---------- EmptyState ---------- */
export function EmptyState({
  icon, title, children,
}: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon ? <div className="empty__icon">{icon}</div> : null}
      <div className="empty__title">{title}</div>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

/* ---------- Skeleton ---------- */
export function Skeleton({
  width = "100%", height = 14, radius,
}: { width?: number | string; height?: number | string; radius?: number }) {
  return (
    <span
      className="skeleton"
      style={{ display: "block", width, height, borderRadius: radius }}
      aria-hidden
    />
  );
}

/* ---------- Breadcrumb ---------- */
export interface Crumb { label: string; href?: string; }
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumb" aria-label="Trilha de navegação">
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {i > 0 ? <span className="breadcrumb__sep" aria-hidden>/</span> : null}
            {last || !c.href
              ? <span className="breadcrumb__current" aria-current={last ? "page" : undefined}>{c.label}</span>
              : <a href={c.href}>{c.label}</a>}
          </span>
        );
      })}
    </nav>
  );
}
