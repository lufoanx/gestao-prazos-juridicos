export type OfficeEntryState = "loading" | "error" | "no-office" | "personal" | "office";
export function officeEntryState(s: { status?: string; hasOffice: boolean; scope: string }): OfficeEntryState;
export const OFFICE_ENTRY_TEXT: Readonly<{
  noOffice: string;
  noOfficeHow: string;
  createAction: string;
  joinAction: string;
  inviteHint: string;
  personal: string;
  personalHow: string;
  openOfficeAction: string;
  switchNoOffice: string;
  switchNoOfficeAction: string;
  loadError: string;
  waiting: string;
}>;
