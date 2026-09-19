// Estado de sessão DEMONSTRATIVO (sem backend, sem autenticação real).
// Guarda apenas dados não sensíveis: nome, e-mail, escolha de perfil,
// preferências e escritório criado/ingressado. NUNCA guarda senhas.
// Transições puras — a camada React/localStorage vive em SessionContext.tsx.
import { userIdFromEmail, officeIdFor } from "./ids.mjs";

export const SESSION_VERSION = 1;

// Persona semeada usada apenas na visita direta (sem sessão). Contas reais
// recebem ids PRÓPRIOS derivados do e-mail/nome (ver ids.mjs), evitando
// mistura de dados persistidos entre contas.
export const DEMO_USER_ID = "u1";

export const ADMIN_PERMISSIONS = [
  "deadline.read", "deadline.create", "deadline.edit", "deadline.complete",
  "deadline.transfer", "team.manage", "office.manage",
];
export const MEMBER_PERMISSIONS = ["deadline.read", "deadline.create", "deadline.complete"];

// Conjunto canônico de permissões válidas, DERIVADO das listas canônicas
// (admin + membro) para não duplicar manualmente. Inclui deadline.edit, usado
// por permissões personalizadas na gestão de equipe.
const KNOWN_PERMISSIONS = new Set([...ADMIN_PERMISSIONS, ...MEMBER_PERMISSIONS]);
const KNOWN_PROFILES = new Set(["autonomo", "office-admin", "office-member"]);

export function defaultSession() {
  return { version: SESSION_VERSION, user: null, profile: null, preferences: {}, office: null, membership: null };
}

export function isValidSession(s) {
  if (!s || typeof s !== "object") return false;
  if (s.version !== SESSION_VERSION) return false;
  // Usuário
  if (!(s.user === null || (typeof s.user === "object"
    && typeof s.user.id === "string" && s.user.id.length > 0
    && typeof s.user.name === "string" && typeof s.user.email === "string"))) return false;
  // Escritório
  if (!(s.office === null || (typeof s.office === "object"
    && typeof s.office.id === "string" && s.office.id.length > 0
    && typeof s.office.name === "string"))) return false;
  // Perfil e preferências
  if (!(s.profile === null || (typeof s.profile === "string" && KNOWN_PROFILES.has(s.profile)))) return false;
  if (s.preferences === null || typeof s.preferences !== "object" || Array.isArray(s.preferences)) return false;
  // Vínculo (membership): campos e permissões válidas
  if (s.membership !== null) {
    const m = s.membership;
    if (typeof m !== "object") return false;
    if (typeof m.userId !== "string" || m.userId.length === 0) return false;
    if (typeof m.officeId !== "string" || m.officeId.length === 0) return false;
    if (typeof m.roleLabel !== "string") return false;
    if (!Array.isArray(m.practiceAreas) || !m.practiceAreas.every((a) => typeof a === "string")) return false;
    if (m.visibility !== "all" && m.visibility !== "assigned") return false;
    if (!Array.isArray(m.permissions) || m.permissions.length === 0) return false;
    if (!m.permissions.every((p) => KNOWN_PERMISSIONS.has(p))) return false;
    // Coerência entre vínculo, escritório e usuário
    if (!s.office || m.officeId !== s.office.id) return false;
    if (s.user && m.userId !== s.user.id) return false;
  }
  return true;
}

/** Cadastro: cria a conta demonstrativa (em memória). Nunca recebe/guarda senha. */
export function applySignUp(session, { name, email }) {
  const em = (email || "").trim();
  return {
    ...session,
    user: { id: userIdFromEmail(em), name: (name || "").trim(), email: em },
    profile: null, office: null, membership: null,
  };
}

/** Login: marca sessão como identificada. Sem senha.
 *  E-mail DIFERENTE do da sessão anterior começa limpo — não herda nome,
 *  preferências nem escritório. Mesmo e-mail preserva a continuidade. */
export function applySignIn(session, { name, email }) {
  const em = (email || "").trim();
  const prevEmail = session.user && session.user.email ? session.user.email : "";
  const sameUser = !!prevEmail && prevEmail.toLowerCase() === em.toLowerCase();
  if (sameUser) {
    return { ...session, user: { ...session.user, email: em } };
  }
  // Conta diferente (ou primeira identificação): nada é herdado.
  return {
    ...defaultSession(),
    user: { id: userIdFromEmail(em), name: (name || "").trim() || "Usuário demonstrativo", email: em },
  };
}

/** Onboarding autônomo: sem vínculo de escritório. Preferências opcionais. */
export function applyAutonomo(session, preferences = {}) {
  return {
    ...session, profile: "autonomo", office: null, membership: null,
    preferences: { ...session.preferences, ...preferences },
  };
}

/** Regra: no máximo UM escritório por pessoa — bloqueia criar com vínculo ativo. */
export function canCreateOffice(session) {
  if (session.office) return { ok: false, reason: "already-office" };
  return { ok: true };
}

/** Criar escritório: entra como ADMINISTRADOR no ambiente criado.
 *  Lança se já houver escritório ativo (nunca substitui em silêncio). */
export function applyCreateOffice(session, { name, role, area } = {}) {
  if (session.office) throw new Error("already-office");
  const ownerId = session.user ? session.user.id : DEMO_USER_ID;
  const office = { id: officeIdFor(ownerId, name), name: (name || "").trim() };
  const membership = {
    userId: ownerId,
    officeId: office.id,
    roleLabel: (role && role.trim()) || "Administrador(a)",
    practiceAreas: area ? [area] : [],
    permissions: [...ADMIN_PERMISSIONS],
    visibility: "all",
  };
  return { ...session, profile: "office-admin", office, membership };
}

/** Regra: no máximo UM escritório ativo por pessoa. */
export function canAcceptInvite(session, inviteOfficeId) {
  if (session.office) {
    if (session.office.id === inviteOfficeId) return { ok: false, reason: "already-member" };
    return { ok: false, reason: "second-office" };
  }
  return { ok: true };
}

/** Ingressar por convite: entra como MEMBRO. Não toca no ambiente pessoal. */
export function applyAcceptInvite(session, office, opts = {}) {
  const check = canAcceptInvite(session, office.id);
  if (!check.ok) throw new Error(check.reason);
  const membership = {
    userId: session.user ? session.user.id : DEMO_USER_ID,
    officeId: office.id,
    roleLabel: opts.roleLabel || "Advogado(a)",
    practiceAreas: opts.practiceAreas || [],
    permissions: opts.permissions ? [...opts.permissions] : [...MEMBER_PERMISSIONS],
    visibility: opts.visibility || "all",
  };
  return { ...session, profile: "office-member", office: { id: office.id, name: office.name }, membership };
}

/** Atualiza dados pessoais editáveis (nome). O e-mail é âncora de identidade
 *  (deriva o id) e NÃO é alterado aqui, para não misturar dados entre contas. */
export function applyUpdateProfile(session, { name } = {}) {
  if (!session.user) return session;
  const finalName = typeof name === "string" && name.trim() ? name.trim() : session.user.name;
  return { ...session, user: { ...session.user, name: finalName } };
}

/** Mescla preferências pessoais (área de atuação, digest…). */
export function applyUpdatePreferences(session, preferences = {}) {
  return { ...session, preferences: { ...session.preferences, ...preferences } };
}

export function resetSession() {
  return defaultSession();
}

/** Encerra o vínculo de escritório NA SESSÃO (fonte única com o roster).
 *  Mantém a conta identificada; volta ao ambiente pessoal (autônomo). */
export function applyLeaveOffice(session) {
  if (!session.office && !session.membership) return session;
  const wasOffice = session.profile === "office-admin" || session.profile === "office-member";
  return { ...session, office: null, membership: null, profile: wasOffice ? "autonomo" : session.profile };
}

/** Ambiente inicial ao abrir o dashboard, derivado do perfil. */
export function defaultScopeKind(session) {
  if (session && session.office && (session.profile === "office-admin" || session.profile === "office-member")) {
    return "office";
  }
  return "personal";
}
