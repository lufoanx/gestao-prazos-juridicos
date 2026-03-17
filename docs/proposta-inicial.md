# Proposta Inicial de Projeto

## Sistema Web para Gestão Inteligente de Prazos Jurídicos

Autor: Lucas  
Curso: Engenharia de Software  
Disciplina: PAC Extensionista VII  

---

## 1. Introdução

Durante a rotina de um escritório de advocacia, o controle de prazos processuais é uma das atividades mais críticas. Cada processo possui prazos que devem ser cumpridos rigorosamente. O descumprimento de um único prazo pode resultar na perda de um direito processual ou até mesmo na perda completa de uma causa judicial.

Apesar da existência de sistemas jurídicos no mercado, muitos escritórios ainda enfrentam dificuldades na organização e visualização desses prazos. Frequentemente o controle depende de processos manuais, interpretações humanas de intimações e fluxos de trabalho pouco claros.

A proposta deste projeto surge a partir da observação desse cenário. A ideia é desenvolver uma plataforma web capaz de auxiliar advogados na organização e acompanhamento de prazos jurídicos, utilizando automação e inteligência artificial para reduzir erros humanos e melhorar a gestão das atividades jurídicas.

O foco da solução não é substituir sistemas jurídicos completos, mas atuar especificamente no problema da gestão e monitoramento de prazos processuais.

## 2. Como o problema foi investigado

Antes de iniciar o desenvolvimento de qualquer solução tecnológica, foi realizada uma etapa inicial de investigação para entender se o problema realmente existe no contexto profissional.

Para isso foi conduzida uma entrevista estruturada com um advogado com experiência prática em escritório jurídico.

O escritório em questão possui aproximadamente:
- 5 advogados atuantes
- cerca de 700 processos ativos

As áreas de atuação incluem:
- direito civil
- direito trabalhista
- direito empresarial
- direito tributário
- direito ambiental
- direito do consumidor
- direito de família

Atualmente o escritório utiliza um sistema jurídico chamado XJUS. Entretanto, o controle de prazos processuais não é realizado diretamente dentro desse sistema. O escritório terceiriza essa atividade para uma empresa especializada em controle jurídico.

Mesmo com essa estrutura, o profissional relatou que já ocorreram perdas de prazo nos últimos anos.

Segundo o entrevistado, o principal motivo dessas falhas é a atribuição incorreta de prazos devido a falhas humanas.

Outro ponto relatado foi a dificuldade de visualização clara das informações dentro dos sistemas atuais, que muitas vezes são considerados confusos e pouco objetivos.

Quando questionado sobre o impacto de uma perda de prazo, o advogado afirmou que, dependendo do processo, isso pode significar a perda completa da causa, gerando prejuízos financeiros significativos.

Após a apresentação da ideia do sistema proposto neste projeto, o profissional avaliou a relevância da solução como 10 em uma escala de 0 a 10, demonstrando forte interesse em uma ferramenta que automatize o cálculo e a organização de prazos.

Essa etapa confirmou que o problema abordado pelo projeto possui relevância prática e impacto real no meio jurídico.

## 3. Problema identificado

Escritórios de advocacia lidam diariamente com um grande volume de processos judiciais. Cada processo pode gerar diversos prazos que precisam ser acompanhados com precisão.

Esses prazos dependem de fatores como:
- dias úteis
- feriados nacionais
- feriados estaduais
- suspensões processuais
- regras específicas do Código de Processo Civil

Mesmo com o uso de sistemas jurídicos, o processo de identificação e atribuição correta desses prazos ainda depende frequentemente de intervenção humana.

Esse cenário aumenta o risco de erros operacionais, especialmente em escritórios com grande volume de processos.

Diante desse contexto, existe uma oportunidade para o desenvolvimento de uma solução tecnológica que automatize parte desse processo e ofereça uma visualização mais clara das atividades relacionadas aos prazos jurídicos.

## 4. Ideia da solução

A proposta deste projeto é desenvolver um sistema web capaz de auxiliar advogados no controle de prazos processuais.

A solução será baseada em três componentes principais.

O primeiro componente é um motor automatizado de cálculo de prazos, capaz de considerar regras jurídicas como dias úteis, feriados e suspensões processuais.

O segundo componente é a utilização de inteligência artificial para análise de intimações em PDF, permitindo identificar automaticamente informações relevantes presentes nos documentos.

O terceiro componente é um painel visual de prazos, que permitirá aos usuários visualizar facilmente quais tarefas possuem maior urgência e quais advogados são responsáveis por cada processo.

A proposta é criar uma ferramenta focada em reduzir riscos operacionais relacionados à perda de prazos.

## 5. Arquitetura geral do sistema

A arquitetura do sistema foi pensada de forma modular, permitindo que diferentes partes da aplicação evoluam de forma independente.

A aplicação será composta por diferentes componentes responsáveis por funções específicas, incluindo interface do usuário, API de backend, motor de cálculo de prazos e módulo de inteligência artificial.

Essa organização facilita manutenção, escalabilidade e futuras expansões do sistema.

### Diagrama de Contexto do Sistema

[Inserir aqui a imagem do diagrama de contexto C4]

### Diagrama de Arquitetura (Containers)

[Inserir aqui a imagem do diagrama de containers C4]

## 6. Tecnologias previstas

Para o desenvolvimento do sistema serão utilizadas tecnologias amplamente adotadas na indústria de software.

Entre as principais ferramentas previstas estão:

- Python
- FastAPI
- PostgreSQL
- Docker
- GitHub Actions
- Cloud computing

Essa combinação permite construir uma aplicação moderna, escalável e alinhada com boas práticas de engenharia de software.

## 7. Segurança das informações

Como o sistema lidará com dados jurídicos sensíveis, a segurança será considerada um aspecto essencial do projeto.

Entre as principais medidas previstas estão:
- utilização de conexões seguras via HTTPS
- autenticação segura de usuários
- controle de acesso baseado em permissões
- isolamento de dados entre diferentes escritórios

Além disso, o projeto buscará seguir boas práticas inspiradas na ISO 27001, voltada para gestão de segurança da informação.

O objetivo é garantir que informações sobre processos e prazos sejam protegidas contra acessos não autorizados ou vazamentos de dados.

## 8. Próximos passos do projeto

Este documento representa apenas a etapa inicial da proposta do projeto.

Nas próximas fases serão desenvolvidos:
- detalhamento dos requisitos funcionais
- detalhamento dos requisitos não funcionais
- modelagem de banco de dados
- implementação do motor de cálculo de prazos
- desenvolvimento da interface web
- testes automatizados do sistema

Ao longo do semestre, este documento será atualizado para refletir a evolução do projeto e as decisões técnicas tomadas durante o desenvolvimento.
