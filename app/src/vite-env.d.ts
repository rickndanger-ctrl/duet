/// <reference types="vite/client" />

declare module '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' {
  /** Emscripten module factory for RNNoise 0.2, wasm inlined: returns the module synchronously. */
  const createRNNWasmModuleSync: () => unknown;
  export default createRNNWasmModuleSync;
}
