import { useLayoutEffect } from 'react';
import type { Decorator } from '@storybook/react-vite';

type MakaGlobal = Record<string, unknown>;
type MakaWindow = { maka?: MakaGlobal };

export function withScopedMakaBridge(bridge: MakaGlobal): Decorator {
  return (Story) => {
    const target = window as unknown as MakaWindow;
    useLayoutEffect(() => {
      const previous = target.maka;
      target.maka = bridge;
      return () => {
        if (target.maka === bridge) {
          target.maka = previous;
        }
      };
    }, []);
    return <Story />;
  };
}