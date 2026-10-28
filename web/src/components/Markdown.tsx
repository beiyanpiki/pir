import XMarkdown from "@ant-design/x-markdown";

/** Markdown rendering for model prose and findings; sanitized by XMarkdown. */
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
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
