export function shouldShowJumpToStart(input: {
  hasOlderHistory: boolean;
  isNearHistoryStart: boolean;
}): boolean {
  return input.hasOlderHistory || !input.isNearHistoryStart;
}
