export interface FragmentWindow {
  location: { hash: string; pathname: string };
  history: { replaceState(a: unknown, b: string, c: string): void };
}
export const FRAGMENT_TOKEN_RE: RegExp;
export function parseFragmentToken(hash: string): string | null;
export function captureFragmentToken(win: FragmentWindow): string | null;
export interface FragmentTokenHolder {
  capture(win: FragmentWindow): { token: string | null; fresh: boolean; revision: number };
  readonly token: string | null;
  readonly revision: number;
  clear(revision: number): boolean;
}
export function createFragmentTokenHolder(): FragmentTokenHolder;
