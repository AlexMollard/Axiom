import React, { useCallback, useEffect, useRef, useState } from 'react';

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const confirmBtnRef = useRef(null);
  const cancelBtnRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      previousFocusRef.current = document.activeElement;
      if (!dialog.open) dialog.showModal();
      (danger ? cancelBtnRef : confirmBtnRef).current?.focus();
    } else if (dialog.open) {
      dialog.close();
      previousFocusRef.current?.focus?.();
    }
  }, [open, danger]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      role="alertdialog"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onCancel={event => {
        event.preventDefault();
        onCancel?.();
      }}
      onClick={event => {
        if (event.target !== dialogRef.current) return;
        const r = dialogRef.current.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
          onCancel?.();
        }
      }}
    >
      <div className="confirm-dialog-inner">
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-message">{message}</p>
        <div className="confirm-dialog-actions">
          <button ref={cancelBtnRef} type="button" className="button" onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={danger ? 'button danger-button' : 'button button-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function useConfirm() {
  const [pending, setPending] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback(options => {
    if (resolver.current) resolver.current(false);
    return new Promise(resolve => {
      resolver.current = resolve;
      setPending(typeof options === 'string' ? { title: 'Confirm action', message: options } : options);
    });
  }, []);

  const settle = useCallback(result => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(result);
  }, []);

  const dialog = (
    <ConfirmDialog
      open={Boolean(pending)}
      title={pending?.title || 'Confirm'}
      message={pending?.message || ''}
      confirmLabel={pending?.confirmLabel || 'Confirm'}
      cancelLabel={pending?.cancelLabel || 'Cancel'}
      danger={Boolean(pending?.danger)}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, dialog };
}
