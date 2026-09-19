"use client";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

export interface Column<T> {
  key: string;
  header: string;
  /** Valor para renderização da célula. */
  render: (row: T) => ReactNode;
  /** Valor usado na ordenação; se ausente, coluna não é ordenável. */
  sortValue?: (row: T) => string | number;
  align?: "left" | "right" | "center";
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: "asc" | "desc" };
  emptyLabel?: string;
}

export function Table<T>({
  columns, rows, rowKey, caption, onRowClick, initialSort, emptyLabel = "Nenhum registro.",
}: TableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a); const vb = col.sortValue!(b);
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      return 0;
    });
  }, [rows, sort, columns]);

  function toggleSort(key: string) {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: "asc" };
      if (cur.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  return (
    <div className="table-wrap">
      <table className={`table${onRowClick ? " table--clickable" : ""}`}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort = !c.sortValue ? undefined
                : active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none";
              return (
                <th key={c.key} style={{ textAlign: c.align }} aria-sort={ariaSort as never}>
                  {c.sortValue ? (
                    <button
                      className="table__sort" onClick={() => toggleSort(c.key)}
                      aria-label={`Ordenar por ${c.header}`}
                    >
                      {c.header}
                      {!active ? <ArrowUpDown size={13} aria-hidden />
                        : sort!.dir === "asc" ? <ArrowUp size={13} aria-hidden />
                        : <ArrowDown size={13} aria-hidden />}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={columns.length} style={{ textAlign: "center", color: "var(--muted)" }}>{emptyLabel}</td></tr>
          ) : sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(row); } : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align }}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
