# PrazoAI — Gestão de prazos jurídicos

O PrazoAI ajuda profissionais autônomos e equipes de advocacia a cadastrar, priorizar e acompanhar prazos em um só lugar. É um projeto acadêmico de Engenharia de Software da Católica SC (Joinville).

**Site oficial (Azure): [prazoai.online](https://prazoai.online)** — crie uma conta com e-mail e senha.

**[Demonstração sem login (Vercel)](https://prazoai-homolog.vercel.app/)** → clique em **Ver o dashboard** para explorar com dados fictícios.

Use apenas dados fictícios. Não envie documentos de clientes, dados de processos reais ou senhas de outros serviços.

## Estado da entrega

| Ambiente | O que está disponível |
| --- | --- |
| Demo pública na Vercel | Dashboard, prazos, calendário e navegação com dados fictícios. Não usa a API, o banco ou o e-mail do ambiente integrado. |
| Modo integrado local | O mesmo código da produção, para desenvolvimento e testes, com PostgreSQL, Mailpit e Azurite locais. |
| Produção integrada (Azure) | Publicada em [prazoai.online](https://prazoai.online): cadastro, login, recuperação de senha por e-mail real (Resend, SPF/DKIM/DMARC), dashboard com totais do servidor, prazos, calendário, escritórios e equipe, intimações com PDF privado (Azure Blob, até 10 MiB), notificações. Detalhes em [docs/backend/29-implantacao-azure.md](docs/backend/29-implantacao-azure.md). |

O calendário organiza vencimentos informados pelo usuário. Os indicadores de urgência **não são cálculo processual oficial**. O PDF da intimação é guardado de forma privada, mas **não é lido automaticamente**: os dados do prazo são revisados e preenchidos por uma pessoa. Leitura por IA/OCR, cálculo processual automático e login com Google não fazem parte desta entrega.

## Fluxos principais

- **Dashboard:** prazos urgentes, agenda do dia, intimações para revisão e visão geral do ambiente selecionado.
- **Prazos e calendário:** cadastre, edite e conclua um prazo; confira o vencimento no calendário.
- **Pessoal e Escritório:** separe seus registros pessoais dos prazos compartilhados pela equipe.
- **Convites e permissões:** convide integrantes e controle acesso e edição conforme as permissões concedidas.
- **Conta:** no modo integrado, o backend autentica a conta; a recuperação de senha depende da configuração de e-mail.

## Arquitetura

| Camada | Tecnologia e responsabilidade |
| --- | --- |
| `frontend/` | Next.js, React e TypeScript. No modo integrado, as rotas server-side `/bff/*` fazem a ponte entre o navegador e a API. |
| `backend/` | Python e FastAPI. Expõe a API versionada, aplica regras de negócio e verifica permissões. |
| Banco | PostgreSQL com migrações Alembic (esquema `prazoai`) e sessões do BFF cifradas (esquema `prazoai_bff`), com um usuário de banco por função (privilégios mínimos). |
| Arquivos | Azure Blob Storage privado para os PDFs das intimações. |
| `.github/` | GitHub Actions: `ci.yml` (testes de backend, frontend, integração, E2E e Docker) e `publicar-imagens.yml` (imagens no GHCR após o CI no `main`). |
| `docs/` | Proposta, requisitos, diagramas e documentação técnica. |

[Diagrama de contexto](docs/diagramas/contexto-c4.png) · [Diagrama de contêineres](docs/diagramas/containers-c4.png)

## Executar localmente

### Frontend demonstrativo

Com Node.js 20+ (o projeto foi desenvolvido em Node.js 22), a partir da raiz do clone:

```bash
cd frontend
npm ci
npm run dev
```

Acesse [localhost:3000](http://localhost:3000). Não configure o modo integrado para esta execução.

### Modo integrado

1. Siga o [guia do backend](backend/README.md) para instalar as dependências, preparar um PostgreSQL de desenvolvimento, configurar `DATABASE_URL` e executar as migrações.
2. Inicie o backend em modo local com `STORAGE=postgres` e confirme a rota `GET /api/v1/health`.
3. Siga o [guia do frontend](frontend/README.md) para configurar o modo `NEXT_PUBLIC_PRAZOAI_MODE=integrated` e apontar o BFF para a API local.
4. Para testar recuperação de senha sem e-mail real, use o capturador SMTP indicado no [guia operacional](docs/backend/22-operacao-recuperacao-senha.md).

Não coloque credenciais em commits nem em variáveis públicas do frontend.

## Testes e evidências

- **Frontend:** rode `npm test`, `npm run typecheck`, `npm run lint` e `npm run build` em `frontend/`. O guia do frontend também documenta as suítes de integração e de navegador.
- **Backend:** o [README do backend](backend/README.md) documenta os testes em memória e as suítes que exigem um PostgreSQL descartável e/ou Mailpit.
- **Regressão de permissões:** o [PR #33](https://github.com/lufoanx/gestao-prazos-juridicos/pull/33) verifica que a usuária mantém a leitura de um prazo atribuído, recebe `403` ao tentar editar sem permissão e volta a editar após a restauração, sem precisar fazer login novamente. Foram executados 61 testes HTTP de prazos em memória, além das verificações do GitHub Actions no PR.

## Publicação

Frontend (Next.js + BFF) e backend (FastAPI) rodam no **Azure Container Apps** (Brazil South); o backend só é acessível pela rede interna. Banco no **Azure Database for PostgreSQL**, PDFs no **Azure Blob**, e-mail pelo **Resend**, domínio na Hostinger com HTTPS gratuito do Azure. Recursos, variáveis, comandos e como atualizar: [docs/backend/29-implantacao-azure.md](docs/backend/29-implantacao-azure.md).

Antes de receber dados reais de clientes: rotina de backup e restauração testada, monitoramento e alertas, e revisão jurídica do uso dos dados.

## Documentação

- [Proposta inicial](docs/proposta-inicial.md)
- [Validação do problema](docs/pesquisa/validacao-problema.md)
- [Requisitos funcionais](docs/requisitos/requisitos-funcionais.md) e [não funcionais](docs/requisitos/requisitos-nao-funcionais.md)
- [Frontend](frontend/README.md) e [backend](backend/README.md)
- [Recuperação de senha: operação e demonstração local](docs/backend/22-operacao-recuperacao-senha.md)
- [Ambientes pessoal e escritório](docs/backend/26-fluxos-pessoal-escritorio.md)
- [Implantação: homologação e produção](docs/backend/27-implantacao-homologacao-producao.md) · [PDF das intimações](docs/backend/28-pdf-intimacoes.md) · [Implantação no Azure](docs/backend/29-implantacao-azure.md)

## Autor

José Lucas Andrade da Fonseca · Engenharia de Software · Católica SC
