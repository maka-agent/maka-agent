import type { MakaBridge } from './preload/bridge-contract.js';

declare global {
  interface Window {
    maka: MakaBridge;
  }
}

export {};
