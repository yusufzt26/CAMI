// Turns the VITE_LOCAL=1 build into one self-contained HTML fragment (scripts and styles inline)
// for hosting as a single-page preview. Usage: node scripts/inline-preview.mjs dist-preview out.html
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, out] = process.argv.slice(2);
const html = readFileSync(join(dir, "index.html"), "utf8");
const asset = (href) => readFileSync(join(dir, href.replace(/^\//, "")), "utf8");
const scripts = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((m) => asset(m[1]));
const styles = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => asset(m[1]));
const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "CAMI";
const safe = (js) => js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const page = `<title>${title}</title>
<meta name="description" content="Browser-only preview of the CAMI VMC G-code verifier: FANUC interpreter, cutter compensation and Z-map material removal.">
<style>
${styles.join("\n")}
</style>
<div id="root"></div>
${scripts.map((s) => `<script type="module">\n${safe(s)}\n</script>`).join("\n")}
`;
writeFileSync(out, page);
console.log(`${out}: ${(page.length / 1024).toFixed(0)} KB`);
