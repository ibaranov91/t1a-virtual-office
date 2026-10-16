export interface BinjgbModule {
  HEAPU8: Uint8Array;
  [name: `_${string}`]: (...args: number[]) => number;
}
export default function Binjgb(options: { wasmBinary: Uint8Array; print?: (text: string) => void; printErr?: (text: string) => void }): Promise<BinjgbModule>;
