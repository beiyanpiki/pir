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

/** Large blocks mount their markdown only when the reader is near them. */
const DEFER_ABOVE = 1_500;
const NEAR_VIEWPORT = "1200px 0px";

/**
 * Parses markdown only when it is about to be read. A long review thread can
 * carry physiques of prose (this one has 240 kB across 49 blocks); parsing all
 * of it up front blocked the main thread for hundreds of milliseconds.
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
  // An empty, intrinsically-sized slot keeps the scrollbar honest until the
  // real block materialises; the estimate is only a placeholder.
  return (
    <div
      ref={ref}
      className="pir-markdown is-deferred"
      style={{ minHeight: Math.min(2_400, Math.round(content.length / 90) * 22) }}
      aria-hidden
    />
  );
}

export const Markdown = memo(function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  if (content.length > DEFER_ABOVE && !streaming) return <Deferred content={content} streaming={streaming} />;
  return <MemoMarkdown content={content} streaming={streaming} />;
});
