import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Manrope", "ui-sans-serif", "system-ui"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular"],
      },
      colors: {
        ink: "#101418",
        cream: "#f5f0e7",
        mint: "#d2f4d3",
        coral: "#ff835e",
        sky: "#9ec5ff",
      },
      boxShadow: {
        card: "0 8px 30px rgba(16, 20, 24, 0.08)",
      },
      borderRadius: {
        xl2: "1rem",
      },
    },
  },
  plugins: [],
};

export default config;
