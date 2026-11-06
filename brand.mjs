// Brand extractor: logo / icon candidates, theme + dominant CSS colors, fonts, name and social handles from a public web page.
import { parseHTML } from "linkedom";
import { safeUrl } from "./lib.mjs";

const UA = "Mozilla/5.0 (compatible; NightshiftLabsBot/1.0; +https://nightshift-x402.nightshift-labs.workers.dev/llms.txt)";
async function get(u, accept, max = 2_000_000) {
  let url = await safeUrl(u), r;
  for (let i = 0; i < 4; i++) {
    r = await fetch(url, { redirect: "manual", headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(10000) });
    const loc = r.headers.get("location"); if (r.status >= 300 && r.status < 400 && loc) { url = await safeUrl(new URL(loc, url).href); continue; } break;
  }
  const text = new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()).subarray(0, max));
  return { url, status: r.status, ct: r.headers.get("content-type") || "", text };
}
const GENERIC_FONTS = new Set(["segoe ui", "roboto", "helvetica neue", "helvetica", "arial", "noto sans", "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji", "ubuntu", "sf pro display", "sf pro text", "oxygen", "cantarell", "fira sans", "droid sans", "liberation sans", "sans", "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "inherit", "initial", "unset", "-apple-system", "blinkmacsystemfont", "emoji", "math"]);
function normHex(h) { h = h.toLowerCase(); if (h.length === 4) h = "#" + [...h.slice(1)].map(c => c + c).join(""); return h.length === 7 ? h : null; }
function rgbToHex(m) { const v = m.slice(0, 3).map(Number); if (v.some(x => isNaN(x) || x > 255)) return null; return "#" + v.map(x => x.toString(16).padStart(2, "0")).join(""); }
const isNeutral = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return Math.max(r, g, b) - Math.min(r, g, b) < 18; };

export async function brandExtract(u) {
  const page = await get(u, "text/html,*/*;q=0.5");
  if (!/html/.test(page.ct)) return { url: page.url.href, status: page.status, error: "not an HTML page" };
  const { document } = parseHTML(page.text), base = page.url, abs = h => { try { return new URL(h, base).href; } catch { return null; } };
  const meta = n => document.querySelector(`meta[property="${n}"]`)?.getAttribute("content") || document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") || null;
  const logos = [], add = (url, source, extra = {}) => { const a = url && abs(url); if (a && !logos.some(l => l.url === a) && logos.length < 12) logos.push({ url: a, source, ...extra }); };
  // JSON-LD Organization logo
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { try { const j = JSON.parse(s.textContent); for (const o of [j, ...(j["@graph"] || [])].flat()) { const l = o?.logo; if (l) add(typeof l === "string" ? l : l.url, "json-ld"); } } catch {} }
  document.querySelectorAll('header a[href="/"] img, a[href="/"] img, header [class*="logo" i] img, [class*="logo" i] > img').forEach(i => add(i.getAttribute("src"), "home-link/header img", { alt: i.getAttribute("alt") || null }));
  const homeSvg = document.querySelector('header a[href="/"] svg, a[href="/"] svg, [class*="logo" i] svg'); const inlineSvgLogo = homeSvg ? homeSvg.outerHTML.slice(0, 20000) : null;
  document.querySelectorAll("img, svg image").forEach(i => { const src = i.getAttribute("src") || i.getAttribute("href"); const hint = `${i.getAttribute("alt") || ""} ${i.getAttribute("class") || ""} ${i.getAttribute("id") || ""} ${src || ""}`;
    if (src && /logo|brand/i.test(hint)) add(src, "img[logo]", { alt: i.getAttribute("alt") || null }); });
  document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="icon"], link[rel="shortcut icon"], link[rel="mask-icon"]').forEach(l => add(l.getAttribute("href"), "link:" + l.getAttribute("rel"), { sizes: l.getAttribute("sizes") || null }));
  add(meta("og:image"), "og:image");
  if (!logos.some(l => l.source.startsWith("link:"))) add("/favicon.ico", "default-favicon");
  // CSS: inline <style>, style attributes, first 3 same-site stylesheets
  let css = [...document.querySelectorAll("style")].map(s => s.textContent).join("\n") + "\n" + [...document.querySelectorAll("[style]")].map(e => e.getAttribute("style")).join(";");
  const sheets = [...document.querySelectorAll('link[rel~="stylesheet"]')].map(l => abs(l.getAttribute("href"))).filter(Boolean).slice(0, 3);
  const fetched = await Promise.all(sheets.map(s => get(s, "text/css,*/*;q=0.1", 800_000).then(r => r.status < 400 ? r.text : "").catch(() => "")));
  css += "\n" + fetched.join("\n");
  const counts = new Map(), bump = h => { if (h) counts.set(h, (counts.get(h) || 0) + 1); };
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) bump(normHex(m[0]));
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) bump(rgbToHex(m.slice(1)));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const vars = {}; for (const m of css.matchAll(/--([\w-]*(?:primary|brand|accent|secondary)[\w-]*)\s*:\s*([^;}{]+)/gi)) if (Object.keys(vars).length < 12) vars["--" + m[1]] = m[2].trim().slice(0, 60);
  const fonts = new Map();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) for (const f of m[1].split(",")) { const n = f.trim().replace(/^['"]|['"]$/g, "").replace(/\s*!important$/, ""); if (n && !GENERIC_FONTS.has(n.toLowerCase()) && !n.startsWith("var(") && n.length < 50) fonts.set(n, (fonts.get(n) || 0) + 1); }
  const googleFonts = [...document.querySelectorAll('link[href*="fonts.googleapis.com"]')].flatMap(l => [...(l.getAttribute("href") || "").matchAll(/family=([^:&]+)/g)].map(m => decodeURIComponent(m[1]).replace(/\+/g, " ")));
  const social = {}; document.querySelectorAll("a[href]").forEach(a => { const h = a.getAttribute("href") || "";
    const m = /^https?:\/\/(?:www\.)?(x\.com|twitter\.com|github\.com|linkedin\.com\/company|instagram\.com|youtube\.com|facebook\.com|tiktok\.com|discord\.gg|t\.me)\/([^/?#]+)/i.exec(h);
    if (m && !social[m[1].toLowerCase()] && !/^(share|intent|home|sharer)/i.test(m[2])) social[m[1].toLowerCase()] = h; });
  return { url: u, finalUrl: base.href, status: page.status,
    name: meta("og:site_name") || meta("application-name") || (document.querySelector("title")?.textContent || "").trim().split(/\s[|\-–—·:]\s/)[0] || null,
    title: (document.querySelector("title")?.textContent || "").trim() || null, description: meta("description") || meta("og:description"),
    themeColor: meta("theme-color"), logos, colors: { brandVariables: vars, dominant: ranked.slice(0, 10).map(([hex, n]) => ({ hex, count: n, neutral: isNeutral(hex) })),
      dominantNonNeutral: ranked.filter(([h]) => !isNeutral(h)).slice(0, 5).map(([h]) => h) },
    fonts: { googleFonts: [...new Set(googleFonts)], cssFamilies: [...fonts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f]) => f) },
    inlineSvgLogo, social, stylesheetsScanned: sheets.length, blockedByBotProtection: /just a moment|attention required|access denied/i.test(document.querySelector("title")?.textContent || "") || page.status === 403,
    note: "Heuristic extraction from HTML/CSS (no rendering). Colors are ranked by frequency in CSS; check brandVariables and themeColor first." };
}
