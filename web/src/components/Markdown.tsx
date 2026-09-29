import { useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

// Transcript content includes code from repositories under review, so every
// markdown render is sanitized before it reaches the DOM.

const marked = new Marked({ gfm: true, breaks: false });

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const renderer = {
  code({ text, lang }: { text: string; lang?: string | null }) {
    const language = (lang ?? "").split(/\s+/)[0] ?? "";
    let body: string;
    if (language && hljs.getLanguage(language)) {
      body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } else {
      body = escapeHtml(text);
    }
    return `<pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre>`;
  },
};

marked.use({ renderer });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "iframe"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
