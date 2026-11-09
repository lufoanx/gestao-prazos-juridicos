import { NoticePage } from "@/integrated/Unavailable";

// Recursos que dependem de serviços ainda inexistentes (ex.: e-mail de recuperação de senha).
export default function IndisponivelPage() {
  return (
    <NoticePage title="Indisponível nesta fase">
      A recuperação de senha depende do envio de e-mail, que ainda não existe. Nenhum e-mail é enviado.
    </NoticePage>
  );
}
