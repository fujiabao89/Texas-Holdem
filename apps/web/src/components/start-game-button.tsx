"use client";
import Link from "next/link";
import { useId, useRef, type ReactNode } from "react";
import { message } from "../messages/zh-CN";

export function StartGameButton({
  children,
  className = "rr-button rr-button-primary",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <button className={className} type="button" onClick={() => dialog.current?.showModal()}>
        {children}
        <span className="rr-arrow" aria-hidden="true">
          ↗
        </span>
      </button>
      <dialog
        ref={dialog}
        className="rr-dialog"
        aria-labelledby={titleId}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            event.currentTarget.close();
        }}
      >
        <button
          className="rr-dialog-close"
          aria-label={message("brand.close")}
          type="button"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <p className="rr-kicker">{message("brand.takeSeat")}</p>
        <h2 id={titleId}>{message("brand.entryTitle")}</h2>
        <p className="rr-muted">{message("brand.entryDescription")}</p>
        <div className="rr-entry-options">
          <Link href="/create" className="rr-entry-option" onClick={() => dialog.current?.close()}>
            <span aria-hidden="true">♠</span>
            <strong>{message("home.createRoom")}</strong>
            <small>{message("brand.createHint")}</small>
            <span className="rr-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
          <Link href="/join" className="rr-entry-option" onClick={() => dialog.current?.close()}>
            <span className="rr-orange" aria-hidden="true">
              ♦
            </span>
            <strong>{message("home.joinRoom")}</strong>
            <small>{message("brand.joinHint")}</small>
            <span className="rr-arrow" aria-hidden="true">
              ↗
            </span>
          </Link>
        </div>
      </dialog>
    </>
  );
}
