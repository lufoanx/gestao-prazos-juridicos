"use client";
import { useAuth } from "./AuthProvider";

export function IntegratedHome() {
  const { state } = useAuth();
  return (
    <div>
      <div className="page-head"><div className="page-head__title">
        <h1 style={{ fontSize: "var(--fs-2xl)", fontWeight: 700, margin: 0 }}>Olá, {state.user?.name}</h1>
      </div></div>
      <div className="card"><div className="card__body">
        <p>Nesta fase, a integração com o servidor cobre <strong>conta, sessão e perfil</strong>.</p>
        <p className="text-muted">Prazos, calendário, intimações, notificações e escritório estão em integração e serão
          habilitados nas próximas entregas. Nenhum dado demonstrativo é exibido no modo integrado.</p>
      </div></div>
    </div>
  );
}

export function NotIntegratedModule() {
  return (
    <div className="card"><div className="card__body" role="status">
      <h1 style={{ fontSize: "var(--fs-xl)" }}>Módulo ainda não integrado</h1>
      <p className="text-muted">Esta área será conectada ao servidor em uma próxima entrega. Para evitar confusão,
        nenhum dado demonstrativo é exibido aqui.</p>
    </div></div>
  );
}
