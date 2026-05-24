# PrazoAI — Sistema Inteligente de Gestão de Prazos Jurídicos

## Visão geral

Este projeto está sendo desenvolvido na disciplina PAC Extensionista VII do curso de Engenharia de Software.

A proposta é criar uma plataforma web focada na gestão inteligente de prazos jurídicos, com o objetivo de reduzir falhas humanas, melhorar a organização dos processos e trazer mais segurança no acompanhamento de prazos processuais.

O PrazoAI atua como uma solução especializada para auxiliar advogados, assistentes jurídicos e escritórios de pequeno e médio porte na organização, cálculo e acompanhamento de prazos.

---

## Problema

O controle de prazos processuais ainda é uma atividade crítica em escritórios de advocacia.

Mesmo com o uso de sistemas jurídicos, planilhas, agendas e serviços terceirizados, falhas humanas na leitura de intimações, atribuição de datas e acompanhamento de vencimentos ainda ocorrem, podendo gerar prejuízos processuais, financeiros e reputacionais.

Além disso, muitos sistemas atuais apresentam:

- baixa clareza visual;
- excesso de complexidade;
- dificuldade de organização por prioridade;
- dependência de lançamentos manuais;
- pouca automação na interpretação de intimações em PDF.

---

## Solução proposta

O sistema será desenvolvido com foco em três pilares principais:

- motor automatizado de cálculo de prazos processuais;
- análise de intimações em PDF utilizando inteligência artificial;
- dashboard visual para organização e priorização de prazos.

A proposta é reduzir o risco de perda de prazos, melhorar a visualização das tarefas críticas e apoiar a rotina operacional de escritórios jurídicos.

---

## Diferencial do Projeto

Diferente dos sistemas jurídicos tradicionais, o PrazoAI é focado especificamente na gestão inteligente de prazos processuais.

Enquanto muitas plataformas do mercado são amplas e generalistas, o PrazoAI concentra sua proposta em um ponto crítico da rotina jurídica: reduzir falhas humanas no acompanhamento de prazos.

O diferencial está na combinação entre:

- extração de dados de intimações em PDF com apoio de IA;
- cálculo automatizado considerando dias úteis, feriados e regras de contagem;
- visualização clara dos prazos por prioridade;
- foco em escritórios pequenos e médios, que muitas vezes não possuem equipe dedicada apenas ao controle processual.

---

## Validação do problema

A ideia foi validada com profissional da área jurídica, em contexto de escritório com aproximadamente:

- 5 advogados;
- cerca de 700 processos ativos.

Principais pontos identificados:

- ocorrência de perda de prazos;
- falhas humanas na atribuição de datas;
- dificuldade de organização e visualização;
- dependência de leitura manual de intimações;
- necessidade de uma visão mais clara dos prazos urgentes.

A solução proposta foi avaliada como altamente relevante, recebendo nota 10/10 na validação inicial.

---

## Métricas de Sucesso (KPIs)

As métricas previstas para avaliar o sucesso do projeto são:

- acurácia da extração de dados pela IA superior a 85%;
- redução de pelo menos 70% no tempo médio gasto para cadastrar um prazo a partir de uma intimação;
- tempo de resposta inferior a 500ms nas principais ações do sistema;
- suporte inicial para no mínimo 10 usuários simultâneos;
- zero prazos perdidos por falha do sistema durante a fase de testes.

---

## Arquitetura inicial

A arquitetura do sistema foi organizada com base no modelo C4, permitindo visualizar o projeto em diferentes níveis de detalhe: contexto, containers e componentes.

### Diagrama de contexto

![Diagrama de Contexto](docs/diagramas/contexto-c4.png)

---

### Diagrama de containers

![Diagrama de Containers](docs/diagramas/containers-c4.png)

---

## Tecnologias previstas

As tecnologias previstas para o desenvolvimento do projeto são:

- Python;
- FastAPI;
- React;
- PostgreSQL;
- Docker;
- GitHub Actions (CI, com possibilidade futura de CD);
- Cloud computing;
- Inteligência Artificial para análise de documentos.

---

## Documentação

- [RFC do Projeto](docs/RFC.md)
- [Proposta Inicial](docs/proposta-inicial.md)
- [Validação do Problema](docs/pesquisa/validacao-problema.md)
- [Requisitos Funcionais](docs/requisitos/requisitos-funcionais.md)
- [Requisitos Não Funcionais](docs/requisitos/requisitos-nao-funcionais.md)

---

## Estrutura do projeto

    docs/          # documentação do projeto
    backend/       # API, regras de negócio e motor de cálculo
    frontend/      # interface web do sistema
    .github/       # automações e integração contínua

---

## Segurança

O sistema será desenvolvido considerando boas práticas de segurança da informação, especialmente por lidar com dados sensíveis relacionados a processos jurídicos.

Entre os cuidados previstos estão:

- uso de HTTPS;
- autenticação segura;
- controle de acesso por usuário;
- isolamento de dados entre escritórios;
- armazenamento seguro de senhas com hash;
- separação lógica dos dados por escritório;
- validação de permissões para acesso a processos e prazos.

Além disso, o projeto será inspirado em princípios de segurança da informação, como confidencialidade, integridade e disponibilidade, alinhando-se a boas práticas presentes na ISO 27001.

---

## Protótipo visual

Nesta etapa, foram elaboradas telas estáticas de média fidelidade para representar o fluxo principal do sistema.

Os mockups contemplam telas como:

- login;
- dashboard de prazos;
- cadastro de prazo;
- upload e revisão de intimação;
- detalhes do prazo;
- gestão de usuários.

A versão navegável no Figma será estruturada em etapa posterior, com conexão entre as telas e simulação completa do fluxo principal.

---

## Status do projeto

Projeto acadêmico em desenvolvimento na disciplina PAC Extensionista VII.

A entrega atual contempla os capítulos 1 a 5 do modelo de RFC, incluindo:

- visão do produto;
- validação do problema;
- análise de soluções existentes;
- engenharia de requisitos;
- fluxos do sistema;
- mockups e experiência do usuário;
- arquitetura inicial;
- modelo de dados;
- principais componentes;
- stack tecnológica.

Próximos passos:

- evolução do protótipo navegável;
- implementação do motor de cálculo de prazos;
- integração da análise de documentos com IA;
- desenvolvimento da interface em React;
- implementação da API em FastAPI;
- evolução dos testes e da arquitetura do sistema.

---

## Autor

- José Lucas Andrade Fonseca
