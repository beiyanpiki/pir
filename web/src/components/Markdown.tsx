import { memo, useEffect, useRef, useState } from "react";
import XMarkdown from "@ant-design/x-markdown";

/**
 * Markdown rendering for model prose and findings; sanitized by XMarkdown.
 *
 * Memoized on purpose: a session thread can hold hundreds of kilobytes of prose,
 * and XMarkdown parses every block it is given. Without this, any parent state
 * change (scroll position, filter typing, live tick) re-parsed the whole thread
 * and dropped frames.
 */
function MarkdownView({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="pir-markdown">
      <XMarkdown
        content={content}
        openLinksInNewTab
        streaming={streaming ? { hasNextChunk: true, tail: true } : undefined}
      />
    </div>
  );
}

const MemoMarkdown = memo(MarkdownView);

/** Large blocks mount their rich markdown only when the reader is near them. */
const DEFER_ABOVE = 1_500;
const NEAR_VIEWPORT = "1200px 0px";

/**
 * Renders a long block as plain text until it is near the viewport, then swaps
 * in XMarkdown. A 49-block thread here carries 240 kB of prose, and parsing all
 * of it up front blocked the main thread for hundreds of milliseconds.
 *
 * The text stays in the DOM while deferred, so browser find, Ctrl+End and
 * assistive technology still see the content (dogfood F-223); only the markdown
 * parsing is postponed.
 */
function Deferred({ content, streaming }: { content: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible || streaming) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: NEAR_VIEWPORT },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible, streaming]);

  if (visible || streaming) return <MarkdownView content={content} streaming={streaming} />;
  return (
    <div ref={ref} className="pir-markdown is-deferred">
      <p className="wf-plain-text">{content}</p>
    </div>
  );
}

export const Markdown = memo(function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  if (content.length > DEFER_ABOVE && !streaming) return <Deferred content={content} streaming={streaming} />;
  return <MemoMarkdown content={content} streaming={streaming} />;
});
