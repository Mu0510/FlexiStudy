import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "*.{js,ts,jsx,tsx,mdx}",
  ],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",

        // メインカラーパレット（基本デザイン用）
        neutral: {
          50: "#f9f9f9",
          100: "#f0f0f0", // メイン背景色
          200: "#e5e5e5",
          300: "#ced3e0", // セカンダリ背景・ボーダー
          400: "#a1a8b8",
          500: "#6b7280",
          600: "#4b5563",
          700: "#374151",
          800: "#213358", // 深い青
          900: "#070c17", // 最も濃いテキスト色
          950: "#030508",
        },

        primary: {
          DEFAULT: "#213358", // 深い青
          50: "#f1f3f7",
          100: "#e2e7ef",
          200: "#c9d2e3",
          300: "#a8b5d1",
          400: "#8394bb",
          500: "#6577a7",
          600: "#526094",
          700: "#455078",
          800: "#213358", // メインカラー
          900: "#1a2a47",
          950: "#070c17",
          foreground: "#f0f0f0",
        },

        accent: {
          DEFAULT: "#ee1a59", // 鮮やかなピンク/クリムゾン
          50: "#fef1f4",
          100: "#fde2ea",
          200: "#fbc9db",
          300: "#f7a2be",
          400: "#f26d96",
          500: "#ee1a59", // メインアクセント
          600: "#d91748",
          700: "#b8123c",
          800: "#9a1238",
          900: "#831235",
          950: "#4a0619",
        },

        secondary: {
          DEFAULT: "#6dd5e0", // 明るいシアン/ターコイズ
          50: "#f0fdfe",
          100: "#ccfbfe",
          200: "#9af5fc",
          300: "#6dd5e0", // セカンダリアクセント
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2",
          700: "#0e7490",
          800: "#155e75",
          900: "#164e63",
          950: "#083344",
        },

        // 機能的な色（警告・ステータス用）
        success: {
          DEFAULT: "#44552a", // 暗めの緑
          50: "#f4f6f0",
          100: "#e6ebd8",
          200: "#cdd8b5",
          300: "#adc088",
          400: "#8fa55e",
          500: "#748842",
          600: "#5a6d33",
          700: "#44552a", // メイン成功色
          800: "#384521",
          900: "#2f3a1c",
          950: "#1a2010",
        },

        warning: {
          DEFAULT: "#b4bc38", // くすんだ黄色
          50: "#fefdf0",
          100: "#fefbe6",
          200: "#fdf4c7",
          300: "#fbe89d",
          400: "#f7d866",
          500: "#f0c53a",
          600: "#e0b025",
          700: "#b4bc38", // メイン警告色
          800: "#9a8f2f",
          900: "#827529",
          950: "#4a4014",
        },

        alert: {
          DEFAULT: "#e65c00", // 鮮やかなオレンジ
          50: "#fff4ed",
          100: "#ffe6d5",
          200: "#feccaa",
          300: "#fdab74",
          400: "#fb7f3c",
          500: "#f95d16",
          600: "#e65c00", // メインアラート色
          700: "#c13b00",
          800: "#9a3002",
          900: "#7c2906",
          950: "#431202",
        },

        error: {
          DEFAULT: "#f32b2b", // 鮮やかな赤
          50: "#fef2f2",
          100: "#fee2e2",
          200: "#fecaca",
          300: "#fca5a5",
          400: "#f87171",
          500: "#ef4444",
          600: "#f32b2b", // メインエラー色
          700: "#b91c1c",
          800: "#991b1b",
          900: "#7f1d1d",
          950: "#450a0a",
        },

        // shadcn/ui互換性のため
        destructive: {
          DEFAULT: "#f32b2b",
          foreground: "#f0f0f0",
        },
        muted: {
          DEFAULT: "#ced3e0",
          foreground: "#213358",
        },
        card: {
          DEFAULT: "#f0f0f0",
          foreground: "#070c17",
        },
        popover: {
          DEFAULT: "#f0f0f0",
          foreground: "#070c17",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate"), require("@tailwindcss/typography")],
} satisfies Config

export default config
