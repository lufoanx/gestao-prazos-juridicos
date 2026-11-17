import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { AuthShell } from "@/components/public/AuthShell";

// Destino da reescrita de /redefinir-senha/<qualquer coisa> (E5), nos dois modos. Página ESTÁTICA
// (componente de servidor, sem código próprio no cliente): não lê o caminho, não ecoa nem processa o token,
// não chama o BFF e não leva o token a outro endereço. O middleware acrescenta
// `Referrer-Policy: no-referrer`; o metadado abaixo repete a política no documento.
// Limite operacional: o servidor HTTP, o proxy ou a hospedagem ainda podem registrar a URL antiga
// recebida (doc 21, §22) — a aplicação não controla esses logs.
export const metadata: Metadata = { referrer: "no-referrer", title: "Link em formato antigo — PrazoAI" };

export default function OldResetLinkPage() {
  return (
    <AuthShell title="Link em formato antigo">
      <div className="state-box state-box--warn">
        <ShieldAlert size={20} aria-hidden />
        <span>Este endereço de redefinição de senha não é mais aceito. Peça um novo link: ele chegará por e-mail no formato atual.</span>
      </div>
      <Link className="btn btn--primary btn--block" href="/esqueci-senha" style={{ marginTop: 16 }}>Pedir novo link</Link>
      <p className="auth__alt"><Link href="/login">Voltar para entrar</Link></p>
    </AuthShell>
  );
}
