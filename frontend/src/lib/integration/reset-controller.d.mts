import type { RecoveryClient } from "./recovery-client.mjs";
import type { FragmentWindow } from "./fragment-token.mjs";
import type { ResetState } from "./recovery-flow.mjs";
export interface ResetSnapshot { readonly state: ResetState; readonly password: string; readonly confirm: string }
export interface ResetController {
  readonly snapshot: ResetSnapshot;
  subscribe(fn: () => void): () => void;
  read(): void;
  setPassword(value: string): void;
  setConfirm(value: string): void;
  edit(): void;
  endCooldown(): void;
  submit(): Promise<void>;
}
export function createResetController(opts: { client: Pick<RecoveryClient, "reset">; getWindow: () => FragmentWindow }): ResetController;
