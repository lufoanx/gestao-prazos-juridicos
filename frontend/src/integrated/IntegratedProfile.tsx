"use client";
// Perfil no modo integrado: GET/PATCH /users/me via BFF (só o nome é editável na API).
import { useEffect, useState } from "react";
import { Input, Button } from "@/components/ui";
import { ApiError, StaleResponseError } from "@/lib/integration/api-client.mjs";
import type { PublicUser } from "@/lib/integration/dto.d.mts";
import { useAuth } from "./AuthProvider";
import { errorMessage } from "./messages";

type Load = { status: "loading" } | { status: "ready"; user: PublicUser } | { status: "error"; message: string };

export function IntegratedProfile() {
  const { api, controller } = useAuth();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  function handle(e: unknown) {
    if (e instanceof StaleResponseError) return true;
    if (e instanceof ApiError && e.status === 401) { controller.sessionEnded(e.code); return true; }
    return false;
  }

  useEffect(() => {
    let alive = true;
    api.request<PublicUser>("GET", "/bff/api/users/me")
      .then((u) => { if (alive) { setLoad({ status: "ready", user: u }); setName(u.name); } })
      .catch((e) => { if (alive && !handle(e)) setLoad({ status: "error", message: errorMessage(e) }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!name.trim()) { setMsg({ kind: "error", text: "Informe seu nome." }); return; }
    setSaving(true);
    try {
      const u = await api.request<PublicUser>("PATCH", "/bff/api/users/me", { name: name.trim() });
      setLoad({ status: "ready", user: u });
      setName(u.name);
      controller.updateUser(u);
      setMsg({ kind: "ok", text: "Perfil atualizado." });
    } catch (err) {
      if (!handle(err)) setMsg({ kind: "error", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-head"><div className="page-head__title">
        <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, margin: 0 }}>Perfil</h1>
      </div></div>
      <div className="card"><div className="card__body">
        {load.status === "loading" && <p aria-busy="true">Carregando…</p>}
        {load.status === "error" && <p role="alert">{load.message}</p>}
        {load.status === "ready" && (
          <form onSubmit={save} noValidate aria-label="Perfil">
            <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} required />
            <Input label="E-mail" value={load.user.email} disabled readOnly />
            {msg && <p role={msg.kind === "error" ? "alert" : "status"} className={msg.kind === "error" ? "field__error" : "text-muted"}>{msg.text}</p>}
            <Button type="submit" variant="primary" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
            <p className="text-muted" style={{ marginTop: 12 }}>
              Troca de e-mail e de senha pelo perfil não estão disponíveis nesta fase.
            </p>
          </form>
        )}
      </div></div>
    </div>
  );
}
