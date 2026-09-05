import { defineConfig } from "vite";

export default defineConfig({
  // Tauri serves the frontend from a fixed port and expects a stable dev URL.
  clearScreen: false,
  server: { port: 5183, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", sourcemap: true },
  // The wasm-pack output ships its own loader; Vite only needs to leave the
  // .wasm asset alone so the loader's `new URL(...)` resolves at runtime.
  optimizeDeps: { exclude: ["typeset-wasm"] },
});
