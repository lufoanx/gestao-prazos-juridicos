"use client";
// /app/intimacoes/[id]: detalhe integrado (6.4). No modo demo, a tela existente é /revisao.
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { IntegratedIntimationRoute } from "@/integrated/IntegratedIntimationDetail";
import { APP_MODE } from "@/lib/integration/mode.mjs";

function DemoRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => { router.replace(`/app/intimacoes/${params?.id ?? ""}/revisao`); }, [params, router]);
  return null;
}

export default function Page() {
  return APP_MODE === "integrated" ? <IntegratedIntimationRoute /> : <DemoRedirect />;
}
