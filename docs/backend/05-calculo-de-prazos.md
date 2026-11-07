# 05 — Cálculo de prazos: feriados nacionais (Issue #2)

> Escopo da Issue #2: considerar os **feriados nacionais** no cálculo em dias úteis
> do endpoint legado `GET /calcular-prazo`. **Não** é cálculo processual oficial.

## Onde está
- `backend/app/services/calendario.py` — calendário isolado (`feriados_nacionais`,
  `eh_feriado_nacional`, `eh_dia_util`).
- `backend/app/services/prazo_service.py` — `calcular_prazo` usa `eh_dia_util`.
- Testes: `backend/tests/test_issue2_feriados_nacionais.py`.

## Regra aplicada
Conta-se a partir do dia seguinte à data inicial; cada dia é considerado útil quando
é de segunda a sexta **e** não é feriado nacional.

## Abrangência (calendário próprio)
Feriados nacionais fixos previstos em lei federal:

| Data | Feriado | Fonte |
|---|---|---|
| 01/01 | Confraternização Universal | Lei 662/1949 (red. Lei 10.607/2002) |
| 21/04 | Tiradentes | Lei 662/1949 (red. Lei 10.607/2002) |
| 01/05 | Dia do Trabalho | Lei 662/1949 (red. Lei 10.607/2002) |
| 07/09 | Independência | Lei 662/1949 (red. Lei 10.607/2002) |
| 12/10 | Nossa Senhora Aparecida | Lei 6.802/1980 |
| 02/11 | Finados | Lei 662/1949 (red. Lei 10.607/2002) |
| 15/11 | Proclamação da República | Lei 662/1949 (red. Lei 10.607/2002) |
| 20/11 | Zumbi e Consciência Negra | Lei 14.759/2023 (a partir de 2024) |
| 25/12 | Natal | Lei 662/1949 (red. Lei 10.607/2002) |

**Por que calendário próprio e não biblioteca:** são nove datas fixas, sem regra móvel;
uma dependência externa traria regras que extrapolam o escopo (estaduais, móveis,
facultativos) e cuja atualização não controlamos. O módulo é pequeno, sem I/O e
determinístico nos testes.

## Limitações (NÃO contemplado)
- Recesso forense (art. 220 do CPC) e suspensões processuais.
- Feriados estaduais e municipais — inclusive Sexta-feira da Paixão e Corpus Christi,
  que não são feriados nacionais por lei federal.
- Pontos facultativos (ex.: Carnaval).
- Calendários e feriados forenses específicos de cada tribunal.
- Cálculo processual oficial completo (marco inicial por tipo de intimação etc.).

## Casos verificados
| Entrada | Resultado | Motivo |
|---|---|---|
| 13/11/2026 + 5 | 23/11/2026 | 20/11 (sexta) é feriado |
| 30/10/2026 + 1 | 03/11/2026 | fim de semana + 02/11 (segunda) feriado |
| 10/09/2026 + 2 | 14/09/2026 | caso comum sem feriado |
