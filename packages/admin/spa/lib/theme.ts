import { useEffect, useState } from "react";

const STORAGE_KEY = "frogcp-admin-theme";
type Theme = "light" | "dark";

/**
 * Flips shadcn's `.dark` class on `<html>` (see `styles.css`'s
 * `@custom-variant dark (&:is(.dark *))`). Hand-rolled rather than
 * `next-themes`, which exists to solve SSR hydration mismatches that a
 * client-only Vite SPA doesn't have.
 *
 * No `prefers-color-scheme` auto-detection: this is a dev tool, so an explicit
 * toggle defaulting to light is enough.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  function toggle() {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }

  return [theme, toggle];
}
