# PrazoAI — Gestão de prazos jurídicos

O PrazoAI ajuda profissionais autônomos e equipes de advocacia a cadastrar, priorizar e acompanhar prazos em um só lugar. É um projeto acadêmico de Engenharia de Software da Católica SC (Joinville).

**[Abrir a demonstração](https://prazoai-homolog.vercel.app/)** → clique em **Ver o dashboard** para explorar sem login. Use apenas dados fictícios. Não envie documentos de clientes, dados de processos reais ou senhas de outros serviços.

## Estado da entrega

| Ambiente | O que está disponível |
| --- | --- |
| Demo pública na Vercel | Dashboard, prazos, calendário e navegação com dados fictícios. Não usa a API, o banco ou o e-mail do ambiente integrado. |
| Modo integrado local | Cadastro e login com e-mail e senha, perfil, escritórios e equipe, permissões, convites, prazos, calendário, intimações (metadados e revisão humana) e notificações internas. PostgreSQL e recuperação de senha via SMTP foram verificados localmente. |
| Produção integrada | Pendente. O backend ainda recusa `ENVIRONMENT=production` e as sessões do frontend integrado ficam em memória no servidor Node. A demo online não demonstra prontidão para receber contas ou dados reais. |

O calendário organiza vencimentos informados pelo usuário. Os indicadores de urgência **não são cálculo processual oficial**. Leitura real de PDFs por IA/OCR, armazenamento de arquivos e integrações externas não estão disponíveis na demo.

## Fluxos principais

- **Prazos e calendário:** cadastre, edite e conclua um prazo; confira o vencimento no calendário.
- **Pessoal e Escritório:** separe seus registros pessoais dos prazos compartilhados pela equipe.
- **Convites e permissões:** convide integrantes e controle acesso e edição conforme as permissões concedidas.
- **Conta:** no modo integrado, o backend autentica a conta; a recuperação de senha depende da configuração de e-mail.

## Arquitetura

| Camada | Tecnologia e responsabilidade |
| --- | --- |
| `frontend/` | Next.js, React e TypeScript. No modo integrado, as rotas server-side `/bff/*` fazem a ponte entre o navegador e a API. |
| `backend/` | Python e FastAPI. Expõe a API versionada, aplica regras de negócio e verifica permissões. |
| Banco | PostgreSQL com migrações Alembic. Armazena autenticação e dados de negócio no modo `STORAGE=postgres`; isso não torna persistentes as sessões do BFF. |
| `.github/` | GitHub Actions para verificações automatizadas do repositório. |
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

## Antes de abrir para contas reais

- Resolver os bloqueios de produção no backend e no gerenciamento das sessões integradas do frontend. Não usar o modo de desenvolvimento como produção.
- Implantar e validar frontend, API, PostgreSQL e e-mail em ambiente separado, com HTTPS, segredos no servidor, configuração de acesso e dados fictícios.
- Testar no endereço hospedado: cadastro, login, recuperação de senha, persistência após reinício, isolamento entre contas e escritórios. Definir rotinas de backup, restauração e monitoramento antes de abrir para uso real.

## Documentação

- [Proposta inicial](docs/proposta-inicial.md)
- [Validação do problema](docs/pesquisa/validacao-problema.md)
- [Requisitos funcionais](docs/requisitos/requisitos-funcionais.md) e [não funcionais](docs/requisitos/requisitos-nao-funcionais.md)
- [Frontend](frontend/README.md) e [backend](backend/README.md)
- [Recuperação de senha: operação e demonstração local](docs/backend/22-operacao-recuperacao-senha.md)
- [Ambientes pessoal e escritório](docs/backend/26-fluxos-pessoal-escritorio.md)

## Autor

José Lucas Andrade da Fonseca · Engenharia de Software · Católica SC
