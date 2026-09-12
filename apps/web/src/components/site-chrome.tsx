"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { message } from "../messages/zh-CN";
import { usePresentationPreferences } from "../state/use-presentation-preferences";
import { StartGameButton } from "./start-game-button";

/** Route animation leaves root providers mounted; room hooks own connection lifetime. */
export function SiteChrome({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const { motion } = usePresentationPreferences();
  const onTable = pathname.endsWith("/table");
  return (
    <div className="rr-site" data-reduced-motion={motion === "reduce"}>
      <a className="rr-skip" href="#page-content">
        {message("brand.skipContent")}
      </a>
      <header className={`rr-header ${onTable ? "rr-header-compact" : ""}`}>
        <Link className="rr-brand" href="/" aria-label={message("brand.homeLabel")}>
          <span className="rr-brand-symbol" aria-hidden="true">
            ♠
          </span>
          <span>
            {message("brand.name")}
            <small>{message("brand.tagline")}</small>
          </span>
        </Link>
        <nav className="rr-nav" aria-label={message("navigation.home")}>
          {pathname === "/" && (
            <a className="rr-nav-link rr-desktop" href="#how">
              {message("brand.how")}
            </a>
          )}
          <Link
            className="rr-nav-link"
            href="/settings"
            aria-current={pathname === "/settings" ? "page" : undefined}
          >
            {message("navigation.settings")}
          </Link>
          {!onTable && (
            <StartGameButton className="rr-button rr-button-small">
              {message("brand.enter")}
            </StartGameButton>
          )}
        </nav>
      </header>
      <div id="page-content" tabIndex={-1} key={pathname} className="rr-route-enter">
        {children}
      </div>
      {!onTable && (
        <footer className="rr-footer">
          <span>{message("brand.footer")}</span>
          <span>{message("brand.playMoney")}</span>
        </footer>
      )}
    </div>
  );
}
