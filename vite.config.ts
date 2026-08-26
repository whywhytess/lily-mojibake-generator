import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

const isCodexSeatbeltSandbox =
  process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
  server: isCodexSeatbeltSandbox
    ? {
        watch: {
          useFsEvents: false,
          usePolling: true,
        },
      }
    : undefined,

  plugins: [
    vinext(),

    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
