import { App as AntApp, Button, type ButtonProps } from "antd";
import { CopyOutlined } from "@ant-design/icons";

export function CopyButton({ text, label = "Copy", ariaLabel, ...rest }: { text: string; label?: string; ariaLabel?: string } & Pick<ButtonProps, "size" | "type" | "icon">) {
  const { message } = AntApp.useApp();
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      void message.success("Copied to clipboard");
    } catch {
      void message.error("The clipboard is unavailable in this browser");
    }
  };
  return (
    <Button
      size={rest.size}
      type={rest.type}
      icon={rest.icon ?? <CopyOutlined />}
      aria-label={ariaLabel ?? (label || "Copy to clipboard")}
      onClick={() => void copy()}
    >
      {label}
    </Button>
  );
}