// DTOs da API (espelham os schemas do backend) usados na entrega 6.1.
export interface PublicUser { id: string; name: string; email: string; createdAt: string; }
export interface SessionResponse { authenticated: boolean; user?: PublicUser; }
export interface LoginResponse { user: PublicUser; }
