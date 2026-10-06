#!/usr/bin/env node
// Generates src/dark-theme.css: a dark counterpart for every colour class used in the app.
//
// The UI uses Tailwind classes with literal colours (bg-[#FAF8F5], text-[#362217]/80,
// hover:border-[#9E5D2D] ...). This script scans the source for them and writes rules that apply
// under <html class="dark">, mapping each colour by its role:
//   backgrounds  light surfaces become dark surfaces; accents (buttons, badges) keep their hue
//   text         dark text becomes light; coloured text is lightened enough to read on dark
//   borders      light borders become subtle dark borders
// Run automatically before `npm run dev` and `npm run build`; commit the output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(SRC, "dark-theme.css");

// ---------------------------------------------------------------- colour maths
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
function hexToHsl(hex) {
  let value = hex.replace("#", "");
  if (value.length === 3) value = value.split("").map((char) => char + char).join("");
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}
function hslToHex({ h, s, l }) {
  const hue = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let r;
  let g;
  let b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  return `#${[r, g, b].map((channel) => Math.round(clamp(channel) * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Dark-theme colour for a light-theme colour in a given role. */
export function darkColor(hex, role) {
  const c = hexToHsl(hex);
  const accent = c.s > 0.35 && c.l > 0.2 && c.l < 0.75;
  if (role === "bg") {
    if (hex.toUpperCase() === "#FFFFFF") return "#1E1814"; // cards: a warm surface just above the page
    if (c.l >= 0.78 || (c.l >= 0.55 && c.s < 0.25)) return hslToHex({ h: c.h, s: Math.min(c.s, 0.22), l: clamp(0.11 + (1 - c.l) * 0.5, 0.1, 0.24) });
    if (c.l < 0.22) return hslToHex({ ...c, l: c.l * 0.7 });
    return hex; // accents (buttons, badges) keep their colour
  }
  if (role === "text") {
    if (accent) return hslToHex({ ...c, s: Math.min(c.s, 0.7), l: Math.max(c.l, 0.66) });
    if (c.l < 0.62) return hslToHex({ h: c.h, s: Math.min(c.s, 0.18), l: clamp(0.93 - c.l * 0.7, 0.58, 0.92) });
    return hex; // already light (e.g. text on the dark sidebar)
  }
  if (role === "border") {
    if (c.l >= 0.68) return hslToHex({ h: c.h, s: Math.min(c.s, 0.18), l: clamp(0.2 + (1 - c.l) * 0.35, 0.18, 0.32) });
    if (accent) return hslToHex({ ...c, l: Math.max(c.l, 0.5) });
    return hslToHex({ ...c, l: clamp(c.l + 0.12) });
  }
  return hex;
}

// ---------------------------------------------------------------- scanning
function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const UTILITY = /^(bg|text|border(?:-[trblxy])?|from|via|to|ring|placeholder|divide|outline|fill|stroke|accent|caret|decoration)$/;
const NAMED = { white: "#FFFFFF", black: "#000000" };
const tokens = new Set();
for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/(?<![\w-])((?:[a-z0-9-]+:)*(?:bg|text|border(?:-[trblxy])?|from|via|to|ring|placeholder|divide|outline|fill|stroke|accent|caret|decoration)-(?:\[#[0-9A-Fa-f]{3,8}\]|white|black)(?:\/\d{1,3})?)(?![\w\]-])/g)) {
    tokens.add(match[1]);
  }
}

// ---------------------------------------------------------------- rules
const escapeClass = (value) => value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
const BREAKPOINTS = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" };
const PSEUDO = { hover: ":hover", focus: ":focus", "focus-visible": ":focus-visible", "focus-within": ":focus-within", active: ":active", disabled: ":disabled", placeholder: "::placeholder", first: ":first-child", last: ":last-child" };

function declaration(utility, color, alpha) {
  const value = alpha === null ? color : `color-mix(in oklab, ${color} ${alpha}%, transparent)`;
  switch (utility) {
    case "bg": return `background-color: ${value};`;
    case "text": return `color: ${value};`;
    case "placeholder": return `color: ${value};`;
    case "from": return `--tw-gradient-from: ${value};`;
    case "via": return `--tw-gradient-via: ${value};`;
    case "to": return `--tw-gradient-to: ${value};`;
    case "ring": return `--tw-ring-color: ${value};`;
    case "outline": return `outline-color: ${value};`;
    case "fill": return `fill: ${value};`;
    case "stroke": return `stroke: ${value};`;
    case "accent": return `accent-color: ${value};`;
    case "caret": return `caret-color: ${value};`;
    case "decoration": return `text-decoration-color: ${value};`;
    case "divide": return `border-color: ${value};`;
    default: return `border-color: ${value};`; // border, border-t/r/b/l/x/y
  }
}
const ROLE = { bg: "bg", from: "bg", via: "bg", to: "bg", text: "text", placeholder: "text", fill: "text", stroke: "text", decoration: "text", caret: "text" };

const rules = [];
for (const token of [...tokens].sort()) {
  const parts = token.split(":");
  const base = parts.pop();
  const variants = parts;
  const match = base.match(/^([a-z-]+?)-(\[#[0-9A-Fa-f]{3,8}\]|white|black)(?:\/(\d{1,3}))?$/);
  if (!match || !UTILITY.test(match[1])) continue;
  const [, utility, colourToken, alphaText] = match;
  const hex = colourToken.startsWith("[") ? colourToken.slice(1, -1) : NAMED[colourToken];
  if (colourToken === "white" && ROLE[utility] !== "bg") continue; // white text/borders read fine on dark; white gradient stops do not
  if (colourToken === "black" && utility === "bg") continue;
  const role = ROLE[utility] || "border";
  const dark = darkColor(hex, role);
  if (dark.toUpperCase() === hex.toUpperCase() && colourToken !== "white") continue;
  // Elements marked keep-colors (dark text on a fixed accent) stay as designed.
  let selector = `html.dark .${escapeClass(token)}:not(.keep-colors)`;
  let media = null;
  let groupHover = false;
  for (const variant of variants) {
    if (BREAKPOINTS[variant]) media = `(min-width: ${BREAKPOINTS[variant]})`;
    else if (variant === "group-hover") groupHover = true;
    else if (PSEUDO[variant]) selector += PSEUDO[variant];
    else if (variant === "dark") selector = null;
  }
  if (!selector) continue;
  if (groupHover) selector = selector.replace("html.dark ", "html.dark .group:hover ");
  if (utility === "placeholder" && !selector.includes("::placeholder")) selector += "::placeholder";
  if (utility === "divide") selector += " > :not(:last-child)";
  const rule = `${selector} { ${declaration(utility, dark, alphaText ? Number(alphaText) : null)} }`;
  rules.push(media ? `@media ${media} { ${rule} }` : rule);
}

const header = `/* Generated by scripts/generate-dark-theme.mjs from the colour classes in src/. Do not edit by hand. */
html.dark { color-scheme: dark; }
html.dark body { background-color: #14100D; color: #E9DFD5; }
html.dark ::-webkit-scrollbar-track { background: #14100D; }
html.dark ::-webkit-scrollbar-thumb { background: #3A2E26; border-color: #14100D; }
html.dark .skeleton { background: linear-gradient(90deg, #211A15 0px, #2C231D 160px, #211A15 320px); background-size: 800px 100%; }
html.dark .lift:hover { border-color: #4A3A2F; box-shadow: 0 12px 28px -12px rgba(0, 0, 0, 0.6); }
html.dark :focus-visible { outline-color: #E0A36E; }
/* Page backgrounds and the top bar (marked in the markup) are the darkest layer; cards sit above them. */
html.dark .app-bg.app-bg { background-color: #14100D; }
html.dark .app-header.app-header { background-color: color-mix(in oklab, #14100D 88%, transparent); border-color: #2E241D; }
/* Tailwind's named shades that are used as text */
html.dark { --color-amber-600: #FBBF24; --color-amber-700: #FCD34D; --color-amber-800: #FDE68A; --color-red-500: #F87171; --color-red-600: #FCA5A5; --color-orange-700: #FDBA74; --color-orange-600: #FB923C; }
`;
fs.writeFileSync(OUT, `${header}${rules.join("\n")}\n`);
console.log(`dark-theme.css: ${rules.length} rules from ${tokens.size} colour classes`);
