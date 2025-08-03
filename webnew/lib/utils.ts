import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Color utility functions
const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
};

export const SUBJECT_COLOR_MAP: { [key: string]: string } = {
  "物理": "#0ea5e9", // sky-500
  "数学": "#8b5cf6", // violet-500
  // 必要に応じて他の教科と色を追加
};

export const getSubjectStyle = (subject: string | undefined) => {
  const baseColor = subject ? SUBJECT_COLOR_MAP[subject] || '#0ea5e9' : '#0ea5e9'; // sky-500 as default

  const rgb = hexToRgb(baseColor);

  if (!rgb) {
    return {
      color: '#0284c7', // sky-600
      backgroundColor: '#f0f9ff', // sky-50
      borderColor: '#e0f2fe', // sky-100
    };
  }

  const backgroundColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.035)`;
  const borderColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`;

  return {
    color: baseColor,
    backgroundColor,
    borderColor,
    borderWidth: '1px',
    borderStyle: 'solid',
  };
};
