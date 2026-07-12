export interface E2eWindowTarget {
  pid: number;
  title?: string;
}

export function isOwnedComputerUseFixtureTarget(
  target: E2eWindowTarget | undefined,
  ownerPid: number,
): boolean {
  return target?.pid === ownerPid
    && target.title === 'Maka Real Model Computer Use Fixture';
}
