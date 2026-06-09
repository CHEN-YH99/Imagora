import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#07070A",
        coal: "#101116",
        ember: "#FF6B35",
        mint: "#58F0B6",
        volt: "#D9F85B",
        plasma: "#FF4DB8",
        cyanx: "#25D8FF"
      },
      boxShadow: {
        glow: "0 0 32px rgba(37, 216, 255, 0.25)",
        ember: "0 0 34px rgba(255, 107, 53, 0.25)"
      },
      opacity: {
        7: "0.07",
        8: "0.08",
        12: "0.12",
        14: "0.14",
        15: "0.15",
        18: "0.18",
        24: "0.24",
        28: "0.28",
        34: "0.34",
        44: "0.44",
        52: "0.52",
        58: "0.58",
        64: "0.64",
        66: "0.66",
        68: "0.68",
        72: "0.72",
        74: "0.74",
        76: "0.76",
        78: "0.78",
        94: "0.94"
      }
    }
  },
  plugins: []
};

export default config;
