import Link from "next/link";

export default function NotFound() {
  return (
    <main className="notfound" id="conteudo">
      <div className="notfound__card">
        <span className="notfound__code" aria-hidden>404</span>
        <h1 className="notfound__title">Página não encontrada</h1>
        <p className="notfound__text">O endereço acessado não existe ou foi movido.</p>
        <div className="notfound__actions">
          <Link className="btn btn--primary" href="/">Ir para a página inicial</Link>
          <Link className="btn btn--secondary" href="/login">Entrar</Link>
        </div>
      </div>
    </main>
  );
}
