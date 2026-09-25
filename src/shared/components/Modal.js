"use client";

import { useEffect, useId, useRef } from "react";
import { cn } from "@/shared/utils/cn";
import Button from "./Button";
import Icon from "./Icon";

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnOverlay = true,
  className,
}) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const sizes = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    full: "max-w-4xl",
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={title ? titleId : undefined}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (closeOnOverlay && event.target === event.currentTarget) onClose(); }}
      className="m-auto w-[calc(100%-2rem)] max-w-none bg-transparent p-0 text-text-main backdrop:bg-scrim/60"
    >
      <div
        className={cn(
          "relative mx-auto w-full bg-surface",
          "border border-border-subtle",
          "rounded-lg shadow-[var(--shadow-elev)]",
          sizes[size],
          className
        )}
      >
        {/* Header */}
        {title && (
          <div className="flex min-h-14 items-center justify-between px-5 border-b border-border-subtle">
            <h2 id={titleId} className="text-lg font-semibold text-text-main">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid size-11 place-items-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="p-6 max-h-[calc(85vh-100px)] overflow-y-auto custom-scrollbar">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 p-6 border-t border-border-subtle">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
  loading = false,
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-text-muted">{message}</p>
    </Modal>
  );
}
