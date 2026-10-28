import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#EEF1F0",
        panel: "#F8FAF9",
        ink: "#0F1F1A",
        mute: "#5B6B65",
        line: "#C9D1CE",
        anchor: "#2B4BFF",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
