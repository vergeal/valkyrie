import { useState } from "react";
import type { SavedConnection } from "../api";

export interface ConfirmDialogState {
  title: string;
  message: string;
  danger: boolean;
  resolve: (confirmed: boolean) => void;
}

export interface TextDialogState {
  title: string;
  value: string;
  resolve: (value: string | null) => void;
}

export interface MessageBoxState {
  title: string;
  message: string;
}

export interface ConnectionDialogState {
  mode: "new" | "edit" | "copy";
  connection?: SavedConnection | null;
  /** 「新建连接 → 某种库」进来时的默认类型 */
  initialType?: string;
}

/**
 * Dialog 只管状态与打开 / 关闭；具体业务动作仍属于对应 domain。
 */
export function useDialogs() {
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [textDialog, setTextDialog] = useState<TextDialogState | null>(null);
  const [messageBox, setMessageBox] = useState<MessageBoxState | null>(null);
  const [connectionDialog, setConnectionDialog] = useState<ConnectionDialogState | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  function askText(title: string, value = ""): Promise<string | null> {
    return new Promise(resolve => setTextDialog({ title, value, resolve }));
  }

  function answerText(value: string | null) {
    textDialog?.resolve(value);
    setTextDialog(null);
  }

  function askConfirm(message: string, title = "确认", danger = false): Promise<boolean> {
    return new Promise(resolve => setConfirmDialog({ message, title, danger, resolve }));
  }

  function answerConfirm(confirmed: boolean) {
    confirmDialog?.resolve(confirmed);
    setConfirmDialog(null);
  }

  return {
    confirmDialog, setConfirmDialog, askConfirm, answerConfirm,
    textDialog, setTextDialog, askText, answerText,
    messageBox, setMessageBox,
    connectionDialog, setConnectionDialog,
    managerOpen, setManagerOpen,
    optionsOpen, setOptionsOpen
  };
}
