// Builds the docs/ GitHub Pages site from the uploaded tutorial documents.
//
//   node scripts/build-docs-site.js
//
// - Converts each .docx to HTML with mammoth (the .pdf tutorial is already
//   covered by the in-repo TUTORIAL.md, so it maps to the existing tutorial.html)
// - Scrubs identifiable / sensitive values, replacing them with neutral samples
// - Wraps each page in a dark theme with a "Home" nav bar and formatted code
// - Generates docs/index.html — a landing page linking to every tutorial page
//
// Requires the `mammoth` dev dependency.

const mammoth = require("mammoth");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const UPLOADS = "/Users/ginad/.kiro/crew/uploads";

// ── Source documents → page metadata ───────────────────────────────────────
// order controls the landing-page card order.
const PAGES = [
  {
    slug: "go-basics",
    title: "Go Basics",
    blurb: "The Go language fundamentals — every topic from Go by Example with runnable playground links.",
    src: `${UPLOADS}/c3c1af49d041422c908ee8b59dccf753_GO_Basics.docx`,
    append: "go-basics-gobyexample.html",
  },
  {
    slug: "go-stdlib",
    title: "Go Standard Library",
    blurb: "The common standard-library packages you reach for every day: fmt, strings, errors, os, encoding/json, and more.",
    src: `${UPLOADS}/25ae1c889d8d4439bfaff446c52f9de2_Go_Standard_Library__common_.docx`,
    headings: "numbered",
  },
  {
    slug: "gin-gonic",
    title: "Gin Gonic",
    blurb: "The Gin web framework — routing, middleware, request binding, and rendering.",
    src: `${UPLOADS}/084fb9cc6bc44fd4adbbb1c7ff752915_Gin-Gonic_Updated.docx`,
  },
  {
    slug: "go-gin-templ",
    title: "Go + Gin + templ + Docker",
    blurb: "Putting Gin together with templ for type-safe server-rendered HTML, then deploying with Docker, Compose, Swarm, and Traefik.",
    src: `${UPLOADS}/d1e070915d9d4828b46563072d41260e_Go-Gin-Templ.docx`,
    append: "go-gin-templ-docker.html",
  },
  {
    slug: "ent-sql",
    title: "Ent & SQL",
    blurb: "The Ent ORM and working with SQL databases in Go.",
    src: `${UPLOADS}/21acacba80e1434f99751e293c797db7_ENT-SQL.docx`,
  },
  {
    slug: "tutorial",
    title: "Full-Stack Tutorial (this project)",
    blurb: "The complete gin-templ-datastar walkthrough: the admin panel this repo builds, end to end.",
    // Generated separately from TUTORIAL.md by scripts/build-tutorial.js → tutorial.html
    src: null,
    href: "tutorial.html",
  },
];

// Promote numbered section lines like:  9. "os": Files and Processes
// (a leading "N." followed by a package name) to real <h2> headings.
// Used by docs whose sections are numbered rather than heading-styled.
function promoteNumberedHeadings(html) {
  let maxSeen = 0; // highest section number promoted so far
  return html.replace(/<p>\s*(?:<strong>)?\s*(\d{1,3})\.\s+([\s\S]*?)(?:<\/strong>)?\s*<\/p>/gi, (m, numStr, rest) => {
    const num = parseInt(numStr, 10);
    const text = rest.replace(/<[^>]+>/g, "").trim();
    const bareQuotedPkg = /^["“][a-z/0-9._-]+["”](\s+and\s+["“][a-z/0-9._-]+["”])?$/i.test(text);
    // Sections form a monotonically increasing run (1,2,3,…). A number that
    // moves the sequence FORWARD is a real section; one that jumps backward is
    // a restarting in-content list (cheat sheet / learning order) — skip it.
    const continuesSequence = num >= maxSeen && num <= maxSeen + 5;
    if (bareQuotedPkg) {
      // A bare "pkg" line is only a heading if it continues the section run.
      if (!continuesSequence) return m;
      maxSeen = num;
      return `<h2>${num}. ${text}</h2>`;
    }
    // Lines with a ": Title" or descriptive words after the package/topic.
    const hasColonTitle = /:\s+\S/.test(text);
    const hasQuotedPkgTitle = /^["“][a-z/0-9._-]+["”]/i.test(text) && text.split(/\s+/).length >= 3;
    const isShortTopicTitle = text.length <= 45 && text.split(/\s+/).length <= 6 &&
      !/[.!?]$/.test(text) && /^[A-Z"“]/.test(text);
    const looksHeading = (hasColonTitle || hasQuotedPkgTitle || isShortTopicTitle) && continuesSequence;
    if (looksHeading) { maxSeen = num; return `<h2>${num}. ${text}</h2>`; }
    return m;
  });
}

// Some docs (e.g. go-stdlib) never used Word heading styles — every section
// title is just a bold paragraph like <p><strong>The fmt package</strong></p>.
// Promote those to real <h2> so they can anchor a table of contents. A bold
// paragraph is treated as a heading when it is the WHOLE paragraph, is short,
// and doesn't read like a sentence.
function promoteBoldHeadings(html) {
  return html.replace(/<p>\s*<strong>([\s\S]*?)<\/strong>\s*<\/p>/gi, (m, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const words = text.split(/\s+/).length;
    const looksHeading =
      text.length >= 3 && text.length <= 70 &&
      words <= 9 &&
      !/[.!?]$/.test(text) &&          // not a sentence
      !/ - /.test(text);               // not a "Term - definition" line
    return looksHeading ? `<h2>${text}</h2>` : m;
  });
}

// ── Table of contents ───────────────────────────────────────────────────────
// Assign an id to every h2/h3 and build a nested TOC that links to them.
function slugify(text, used) {
  let base = text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "section";
  let s = base, n = 2;
  while (used.has(s)) { s = `${base}-${n++}`; }
  used.add(s);
  return s;
}

function addTocAndIds(html) {
  const used = new Set();
  const entries = [];
  const withIds = html.replace(/<(h2|h3)>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => {
    const textOnly = inner.replace(/<[^>]+>/g, "").trim();
    if (!textOnly) return m;
    const id = slugify(textOnly, used);
    entries.push({ level: tag === "h2" ? 2 : 3, id, text: textOnly });
    return `<${tag} id="${id}">${inner}</${tag}>`;
  });

  if (entries.length < 2) return { html: withIds, toc: "" }; // not worth a TOC

  const items = entries.map((e) =>
    `<li class="toc-l${e.level}"><a href="#${e.id}">${e.text}</a></li>`
  ).join("\n");
  const toc = `<nav class="toc" aria-label="Table of contents">
  <p class="toc-title">Contents</p>
  <ul>
${items}
  </ul>
</nav>`;
  return { html: withIds, toc };
}

// ── Code block extraction ───────────────────────────────────────────────────
// Word stores code samples inside single-column tables ("code boxes"). mammoth
// renders those as <table>…<br/>…</table>. Detect those and turn them into
// real <pre><code> blocks so they render as monospaced, non-wrapped code.
function decodeEntities(s) {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<[^>]+>/g, "")      // strip any remaining inline tags (<strong>, etc.)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatCodeBlocks(html) {
  return html
    // Drop empty tables Word leaves behind.
    .replace(/<table>\s*<\/table>/gi, "")
    .replace(/<table>[\s\S]*?<\/table>/gi, (table) => {
      const cellCount = (table.match(/<t[dh]\b/gi) || []).length;
      const inner = stripTags(table).trim();
      if (inner === "") return "";
      const multiline = /<br\s*\/?>/i.test(table) || /<\/p>\s*<p>/i.test(table);
      // Strong code signal — Go/SQL/templ statements, calls, or shell commands.
      const codeTokens = /(func\b|package \w|import\b|:=|fmt\.|gin\.|router\.|c\.\w+\(|templ\.|http\.\w|log\.\w|json\.\w|strings\.\w|filepath\.\w|os\.\w|<-|\breturn\b|\bvar \w|\bconst \w|type \w+ (struct|interface)|=\s*&?\w+\{|\)\.\w+\(|\bnil\b|\[\]byte|SELECT |INSERT |UPDATE |DELETE |^\s*(curl|go|npm|npx|air|templ|make|export) )/im.test(inner);
      // Single-column table (1 header/data cell) that looks like code.
      if (cellCount <= 2 && (multiline || codeTokens)) {
        const code = decodeEntities(table).replace(/\n{3,}/g, "\n\n").trim();
        const escaped = code
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<pre><code>${escaped}</code></pre>`;
      }
      return table; // genuine data table — keep as-is
    });
}

// Some docs store code as a RUN of consecutive <p> lines (one <p> per line),
// often introduced by a lone language-fence paragraph like <p>go</p>. Collapse
// those runs into a single <pre><code> block.
const FENCE = /^(go|bash|sh|html|sql|json|yaml|toml|dockerfile|makefile|js|ts|templ|text)$/i;
function stripTags(s) {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function isCodeLine(text) {
  const t = text.trim();
  if (t === "") return false;
  // Reject prose that merely MENTIONS code: a quoted identifier followed by a
  // description dash ("strings.Split" - Splits a string), or bullet/definition
  // lines, or a natural sentence ending in punctuation.
  if (/["'`][^"'`]+["'`]\s*[-–—]\s/.test(t)) return false;
  if (/^[-*•]\s/.test(t) && !/[{};]/.test(t)) return false;
  if (/^\s{2,}\S/.test(text)) return true;                 // indented → code
  // Standalone structural lines (closing braces/parens, opening a block).
  if (/^[\})\];]+[,;]?$/.test(t)) return true;
  if (/^(\{|\(|\[)$/.test(t)) return true;
  // KEY=VALUE env / config lines (all-caps key).
  if (/^[A-Z][A-Z0-9_]*=/.test(t)) return true;
  // Shell commands.
  if (/^(curl|go|npm|npx|air|templ|make|cd|export|git|docker|sqlite3|psql|mysql)\b/.test(t)) return true;
  // Go / templ / SQL code statements.
  if (/(func |package |import |:=|fmt\.|gin\.|router\.|c\.\w+\(|templ\.|http\.\w|log\.\w|json\.\w|<-|return |var \w+ |const \w+ |type \w+ (struct|interface)|=\s*&?\w+\{|\}\s*\{|SELECT |INSERT |UPDATE |DELETE )/.test(t)) {
    // …but not a prose sentence that merely mentions a token.
    const looksProse = /[.:]$/.test(t) && t.split(" ").length > 8 && !/[{};=]/.test(t);
    return !looksProse;
  }
  return false;
}
function collapseCodeParagraphs(html) {
  // Split into a flat list of top-level <p>…</p> and everything-else chunks.
  const parts = html.split(/(<p>[\s\S]*?<\/p>)/g).filter((s) => s !== "");
  const out = [];
  let i = 0;

  // Net bracket depth of a code line: +1 per unclosed ( { [ , -1 per ) } ].
  const bracketDelta = (t) => {
    const open = (t.match(/[([{]/g) || []).length;
    const close = (t.match(/[)\]}]/g) || []).length;
    return open - close;
  };

  while (i < parts.length) {
    const part = parts[i];
    const pm = part.match(/^<p>([\s\S]*?)<\/p>$/);
    if (pm) {
      const text = stripTags(pm[1]);
      const fenceStarts = FENCE.test(text.trim());
      if (fenceStarts || isCodeLine(text)) {
        const lines = [];
        if (!fenceStarts) lines.push(text);
        // Track bracket depth: while >0 we are INSIDE a multi-line construct
        // (import ( … ), a struct literal, a multi-line call) and MUST keep
        // consuming every line until it balances — even lines that don't look
        // like code on their own, e.g. an import path "net/http".
        let depth = fenceStarts ? 0 : bracketDelta(text);
        let j = i + 1;
        while (j < parts.length) {
          const nm = parts[j].match(/^<p>([\s\S]*?)<\/p>$/);
          if (!nm) break;
          const t = stripTags(nm[1]);
          const inBlock = depth > 0;
          if (inBlock || t.trim() === "" || isCodeLine(t) || /^[\})\];]/.test(t.trim())) {
            lines.push(t);
            depth += bracketDelta(t);
            if (depth < 0) depth = 0;
            j++;
            // If we just balanced an import/paren block, allow the run to end
            // naturally on the next non-code line (loop condition handles it).
          } else break;
        }
        if (lines.length >= 2 || (fenceStarts && lines.length >= 1)) {
          // Trim trailing blank lines.
          while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
          const code = lines.join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          out.push(`<pre><code>${code.trim()}</code></pre>`);
          i = j;
          continue;
        }
      }
    }
    out.push(part);
    i++;
  }
  return out.join("")
    // Drop any orphaned lone fence-label paragraphs (e.g. a stray <p>go</p>).
    .replace(/<p>\s*(go|bash|sh|html|sql|json|yaml|toml|dockerfile|makefile|js|ts|templ|text)\s*<\/p>/gi, "");
}

// ── Sensitive / identifiable value scrubbing ────────────────────────────────
// Replace real names, project names, and connection details with neutral samples.
function scrub(html) {
  return html
    // Real project/db name -> generic
    .replace(/openlisting/gi, "myapp")
    // Any DSN with embedded credentials -> obvious placeholder
    .replace(/([a-z]+):\/\/[^:@\/\s"<]+:[^@\/\s"<]+@[^\/\s"<]+/gi, "$1://user:password@localhost")
    .replace(/[a-z0-9_]+:[^@\s"<]+@tcp\([^)]+\)/gi, "user:password@tcp(localhost:3306)")
    // Any private/real-looking IP in examples -> documentation address
    .replace(/\b(?!127\.0\.0\.1)(?!0\.0\.0\.0)(?:\d{1,3}\.){3}\d{1,3}\b/g, "203.0.113.10");
}

// ── Page shell ──────────────────────────────────────────────────────────────
const STYLE = `<style>
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2d3148;--text:#e2e4f0;--muted:#8b8fa8;--accent:#7c87ff;--code-bg:#1e2130;}
*{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
html{scroll-behavior:smooth;}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.75;}
.nav{position:sticky;top:0;z-index:10;background:rgba(15,17,23,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:16px;}
.nav a{color:var(--accent);text-decoration:none;font-weight:600;font-size:0.9rem;}
.nav a:hover{text-decoration:underline;}
.nav .crumb{color:var(--muted);font-size:0.85rem;}
.container{max-width:920px;margin:0 auto;padding:40px 36px 96px;}
h1{font-size:2.5rem;font-weight:800;color:#fff;margin:28px 0 16px;line-height:1.2;letter-spacing:-0.01em;}
h2{font-size:1.45rem;font-weight:600;color:var(--accent);margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--border);scroll-margin-top:70px;}
h3{font-size:1.15rem;font-weight:600;color:#c5caff;margin:30px 0 10px;scroll-margin-top:70px;}
h4,h5,h6{font-size:1rem;font-weight:600;color:var(--muted);margin:22px 0 8px;}
h4.gbe-topic{color:#c5caff;font-size:1.02rem;margin:26px 0 8px;padding-left:20px;position:relative;scroll-margin-top:70px;}
h4.gbe-topic::before{content:"▸";position:absolute;left:0;color:var(--accent);}
p{margin-bottom:14px;color:#cdd0e0;}
a{color:var(--accent);}
strong{color:#eef0fb;}
code{background:#252836;color:#c5caff;padding:2px 6px;border-radius:4px;font-family:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;font-weight:400;}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:10px;padding:18px 22px;overflow-x:auto;margin:18px 0;}
pre code{background:none;padding:0;color:#e6e9f5;font-size:0.95rem;line-height:1.7;white-space:pre;font-weight:400;}
pre code strong, pre code b{font-weight:400;color:inherit;}
table{width:100%;border-collapse:collapse;margin:20px 0;font-size:0.9em;}
th{background:#252836;color:var(--accent);text-align:left;padding:10px 14px;font-weight:600;font-size:0.8em;border-bottom:2px solid var(--border);}
td{padding:9px 14px;border-bottom:1px solid var(--border);color:#cdd0e0;vertical-align:top;}
ul,ol{padding-left:26px;margin-bottom:14px;}
li{margin-bottom:6px;color:#cdd0e0;}
blockquote{border-left:3px solid var(--accent);margin:18px 0;padding:12px 18px;background:rgba(124,135,255,.07);color:var(--muted);border-radius:0 6px 6px 0;}
img{max-width:100%;border-radius:8px;}
hr{border:none;border-top:1px solid var(--border);margin:36px 0;}
.toc{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px 22px;margin:24px 0 36px;}
.toc-title{font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px;}
.toc ul{list-style:none;padding:0;margin:0;}
.toc li{margin:2px 0;}
.toc a{color:#c5caff;text-decoration:none;font-size:0.92rem;}
.toc a:hover{color:var(--accent);text-decoration:underline;}
.toc-l2{margin-left:0;}
.toc-l3{margin-left:18px;}
.toc-l3 a{color:var(--muted);font-size:0.88rem;}
.toc-back{position:fixed;bottom:24px;right:24px;background:var(--accent);color:#fff;padding:9px 14px;border-radius:8px;font-size:0.8rem;font-weight:600;text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,.4);opacity:.88;}
.toc-back:hover{opacity:1;}
.playground-float{position:fixed;bottom:24px;right:90px;background:#1a1d27;color:var(--accent);border:1px solid var(--accent);padding:8px 12px;border-radius:8px;font-size:0.75rem;font-weight:600;text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,.4);opacity:.88;}
.playground-float:hover{opacity:1;background:rgba(124,135,255,.12);text-decoration:none;}
pre{position:relative;}
.copy-btn{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:var(--muted);padding:4px 8px;border-radius:5px;font-size:0.7rem;font-family:inherit;cursor:pointer;opacity:0;transition:opacity .2s,background .15s;}
pre:hover .copy-btn{opacity:1;}
.copy-btn:hover{background:rgba(124,135,255,.15);color:var(--accent);border-color:var(--accent);}
.copy-btn.copied{color:#4ade80;border-color:#4ade80;}
</style>`;

function pageShell(title, bodyHtml, toc) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — gin-templ-datastar</title>
${STYLE}
</head>
<body>
<nav class="nav">
  <a href="index.html">&#8592; Home</a>
  <span class="crumb">${title}</span>
</nav>
<div class="container">
<h1 class="page-title">${title}</h1>
${toc}
${bodyHtml}
</div>
<a href="https://go.dev/play/" target="_blank" class="playground-float">▶ Go Playground</a>
<a href="#" class="toc-back">&#8593; Top</a>
<script>
document.querySelectorAll('pre').forEach(function(pre) {
  var btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.addEventListener('click', function() {
    var code = pre.querySelector('code');
    var text = code ? code.textContent : pre.textContent;
    navigator.clipboard.writeText(text).then(function() {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });
  pre.appendChild(btn);
});
</script>
</body>
</html>`;
}

// ── Convert + write each doc page ───────────────────────────────────────────
(async () => {
  fs.mkdirSync(DOCS, { recursive: true });

  for (const p of PAGES) {
    if (!p.src) continue; // tutorial.html is produced by build-tutorial.js
    const { value } = await mammoth.convertToHtml({ path: p.src });
    // Demote any document-internal <h1> to <h2> so the injected page title is
    // the single, largest heading; the doc's own top-level headings sit under it.
    const demoted = value.replace(/<(\/?)h1(\s[^>]*)?>/gi, "<$1h2$2>");
    const formatted = scrub(collapseCodeParagraphs(formatCodeBlocks(demoted)));
    // Section headings: numbered docs (go-stdlib) promote "N. …" lines;
    // everything else promotes bold-only paragraph titles.
    const headed = p.headings === "numbered"
      ? promoteNumberedHeadings(formatted)
      : promoteBoldHeadings(formatted);
    // Append hand-authored supplemental HTML (already has <h2>/<pre> markup, so
    // it skips the docx code-reconstruction pipeline). Done BEFORE addTocAndIds
    // so the supplement's headings are anchored and appear in the page TOC.
    let combined = headed;
    if (p.append) {
      const supPath = path.join(__dirname, "supplements", p.append);
      combined += "\n" + fs.readFileSync(supPath, "utf8");
    }
    const { html: withIds, toc } = addTocAndIds(combined);
    fs.writeFileSync(path.join(DOCS, `${p.slug}.html`), pageShell(p.title, withIds, toc));
    console.log(`Wrote docs/${p.slug}.html`);
  }

  // ── Landing page ──────────────────────────────────────────────────────────
  const cards = PAGES.map((p) => {
    const href = p.href || `${p.slug}.html`;
    return `    <a class="card" href="${href}">
      <h3>${p.title}</h3>
      <p>${p.blurb}</p>
      <span class="go">Open &#8594;</span>
    </a>`;
  }).join("\n");

  const indexBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Golang Tutorial</title>
${STYLE}
<style>
.hero{padding:56px 0 28px;text-align:center;}
.hero h1{font-size:2.4rem;margin-bottom:10px;}
.hero p{color:var(--muted);font-size:1.05rem;max-width:640px;margin:0 auto;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;margin-top:36px;}
.card{display:flex;flex-direction:column;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;text-decoration:none;transition:border-color .15s,transform .15s;}
.card:hover{border-color:var(--accent);transform:translateY(-2px);text-decoration:none;}
.card h3{color:#fff;margin:0;font-size:1.1rem;}
.card p{color:var(--muted);font-size:0.9rem;margin:0;flex:1;}
.card .go{color:var(--accent);font-size:0.85rem;font-weight:600;margin-top:6px;}
.footer{text-align:center;color:var(--muted);font-size:0.8rem;margin-top:56px;}
.footer a{color:var(--accent);}
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    <h1>Golang Tutorial</h1>
    <p>A hands-on guide to server-rendered Go — the language basics, the standard library, Gin, templ, Datastar, and Ent/SQL. Pick a topic to begin.</p>
  </div>
  <div class="grid">
${cards}
  </div>
  <div class="footer">
    Source: <a href="https://github.com/danegigi/go-tut">github.com/danegigi/go-tut</a>
  </div>
</div>
</body>
</html>`;

  fs.writeFileSync(path.join(DOCS, "index.html"), indexBody);
  console.log("Wrote docs/index.html (landing page)");
})();
