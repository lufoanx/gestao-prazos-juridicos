export function getBff(env?: Record<string, string | undefined>): {
  register(r: Request): Promise<Response>;
  login(r: Request): Promise<Response>;
  logout(r: Request): Promise<Response>;
  session(r: Request): Promise<Response>;
  proxy(r: Request, path: string): Promise<Response>;
  publicInvitationLookup(r: Request): Promise<Response>;
} | null;
export function runBff(handler: (bff: NonNullable<ReturnType<typeof getBff>>) => Promise<Response>): Promise<Response>;
export function unavailableResponse(): Response;
export function misconfiguredResponse(): Response;
