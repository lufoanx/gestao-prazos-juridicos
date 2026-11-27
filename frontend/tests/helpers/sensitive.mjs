// Verificação SANITIZADA para testes (lição da E3): ao falhar, mostra só o NOME do requisito.
// `assert.equal`/`deepEqual` imprimem os valores comparados; para corpos, tokens, senhas ou e-mails
// use `check(condição, "requisito")`, que lança um Error sem operandos.
export function check(condition, requirement) {
  if (!condition) {
    const e = new Error(`requisito não atendido: ${requirement}`);
    e.stack = e.message;                     // sem trechos de código nem valores
    throw e;
  }
}

/** Nenhum dos segredos (rotulados) aparece no texto; a falha lista só os rótulos. */
export function checkAbsent(text, secrets, where) {
  const leaked = Object.entries(secrets).filter(([, v]) => v && String(text).includes(v)).map(([k]) => k).sort((a, b) => a.localeCompare(b));
  if (leaked.length) {
    const e = new Error(`requisito não atendido: ${where} expõe ${leaked.join(", ")}`);
    e.stack = e.message;
    throw e;
  }
}
