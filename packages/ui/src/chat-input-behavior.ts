export interface ChatInputCompositionEvent {
  key?: string;
  nativeEvent: object;
}

export function isChatInputComposing(
  event: ChatInputCompositionEvent,
  trackedComposition = false,
): boolean {
  return trackedComposition || event.key === 'Process'
    || ('isComposing' in event.nativeEvent && event.nativeEvent.isComposing === true);
}

export function fileTransferContainsFiles(types: Iterable<string>, fileCount: number): boolean {
  return fileCount > 0 || Array.from(types).includes('Files');
}

export interface TextInputSelectionTarget {
  value: string;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

export function focusTextInputAtEnd(input: TextInputSelectionTarget): void {
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

export interface ChatInputActionOwner<ActionId> {
  readonly pending: ActionId | null;
  run<Result>(actionId: ActionId, action: () => Promise<Result>): Promise<Result | undefined>;
  reset(): void;
}

export function createChatInputActionOwner<ActionId>(
  onPendingChange: (action: ActionId | null) => void,
): ChatInputActionOwner<ActionId> {
  let pending: ActionId | null = null;
  let generation = 0;
  return {
    get pending() {
      return pending;
    },
    async run<Result>(actionId: ActionId, action: () => Promise<Result>): Promise<Result | undefined> {
      if (pending !== null) return undefined;
      const ownedGeneration = ++generation;
      pending = actionId;
      onPendingChange(actionId);
      try {
        return await action();
      } finally {
        if (generation === ownedGeneration && pending === actionId) {
          pending = null;
          onPendingChange(null);
        }
      }
    },
    reset() {
      generation += 1;
      pending = null;
    },
  };
}
