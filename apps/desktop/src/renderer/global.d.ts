import type { OwnContextApi } from "../electron/preload.cjs";

declare global {
  interface Window {
    ownContext: OwnContextApi;
  }
}

export {};
