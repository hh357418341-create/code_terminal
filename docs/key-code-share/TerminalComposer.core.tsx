import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

export interface TerminalComposerTarget {
  sendRawInput: (input: string) => void;
  sendComposerInput: (input: string) => void;
  interrupt: () => void;
  focus: () => void;
}

const navigationInput: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Home: "\x1b[H",
  End: "\x1b[F",
};

export function TerminalComposer({ terminal }: { terminal: TerminalComposerTarget }) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const allowNextLineBreakRef = useRef(false);
  const suppressNextLineBreakRef = useRef(false);
  const [value, setValue] = useState("");

  function focusComposer() {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function submit(input = value) {
    const text = input.trimEnd();
    if (!text) return;

    terminal.sendComposerInput(text);
    setValue("");
    focusComposer();
  }

  function sendEnterToTerminal() {
    terminal.sendRawInput("\r");
  }

  function sendNavigationToTerminal(key: string) {
    if (value.trim()) return false;

    const raw = navigationInput[key];
    if (!raw) return false;

    terminal.sendRawInput(raw);
    return true;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing) return;

    if (event.key === "Escape") {
      event.preventDefault();
      if (value) {
        setValue("");
      } else {
        terminal.focus();
      }
      return;
    }

    if (event.key.toLowerCase() === "c" && event.ctrlKey && !event.shiftKey && !event.altKey) {
      const target = event.currentTarget;
      const hasSelection = target.selectionStart !== target.selectionEnd;
      if (!hasSelection) {
        event.preventDefault();
        terminal.interrupt();
      }
      return;
    }

    if (event.key === "Enter") {
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        allowNextLineBreakRef.current = true;
        return;
      }

      if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        suppressNextLineBreakRef.current = true;

        if (event.currentTarget.value.trim()) {
          submit(event.currentTarget.value);
        } else {
          sendEnterToTerminal();
        }
        return;
      }
    }

    if (
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      sendNavigationToTerminal(event.key)
    ) {
      event.preventDefault();
    }
  }

  function handleBeforeInput(event: FormEvent<HTMLTextAreaElement>) {
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.inputType !== "insertLineBreak" && inputEvent.inputType !== "insertParagraph") {
      return;
    }

    if (allowNextLineBreakRef.current) {
      allowNextLineBreakRef.current = false;
      return;
    }

    event.preventDefault();

    if (suppressNextLineBreakRef.current) {
      suppressNextLineBreakRef.current = false;
      return;
    }

    if (event.currentTarget.value.trim()) {
      submit(event.currentTarget.value);
    } else {
      sendEnterToTerminal();
    }
  }

  return (
    <form
      className="terminal-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={inputRef}
        rows={2}
        value={value}
        enterKeyHint="send"
        placeholder="输入给当前会话"
        spellCheck={false}
        onBeforeInput={handleBeforeInput}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        onKeyDownCapture={handleKeyDown}
      />
      <button disabled={!value.trim()} type="submit">
        发送
      </button>
    </form>
  );
}

