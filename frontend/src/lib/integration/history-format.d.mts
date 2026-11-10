import type { HistoryEvent } from "./dto.d.mts";
export function describeEvent(event: HistoryEvent, nameOf: (userId: string) => string): string;
