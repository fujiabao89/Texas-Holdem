"use client";
import { message } from "../messages/zh-CN";
import { usePresentationPreferences } from "../state/use-presentation-preferences";

export function PokerArt() {
  const { motion } = usePresentationPreferences();
  return (
    <div
      className="hero-art"
      role="img"
      aria-label={message("brand.artLabel")}
      onPointerMove={(event) => {
        if (
          motion === "reduce" ||
          event.pointerType !== "mouse" ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        )
          return;
        const bounds = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty(
          "--tilt-x",
          `${((event.clientX - bounds.left) / bounds.width - 0.5) * 10}deg`,
        );
        event.currentTarget.style.setProperty(
          "--tilt-y",
          `${((event.clientY - bounds.top) / bounds.height - 0.5) * -8}deg`,
        );
      }}
      onPointerLeave={(event) => {
        event.currentTarget.style.setProperty("--tilt-x", "0deg");
        event.currentTarget.style.setProperty("--tilt-y", "0deg");
      }}
    >
      <div className="art-orbit" />
      <div className="art-floor" />
      <div className="art-note">{message("brand.artNote")}</div>
      <div className="cards">
        <div className="playing-card card-back">
          <div className="back-emblem">♠</div>
        </div>
        {(["heart", "spade"] as const).map((suit) => (
          <div key={suit} className={`playing-card card-${suit}`}>
            <div className="corner">
              A<span>{suit === "heart" ? "♥" : "♠"}</span>
            </div>
            <div className="card-suit">{suit === "heart" ? "♥" : "♠"}</div>
            <div className="corner bottom">
              A<span>{suit === "heart" ? "♥" : "♠"}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="chip green">
        <span>100</span>
      </div>
      <div className="chip orange">
        <span>50</span>
      </div>
      <div className="chip tiny">
        <span>25</span>
      </div>
      <div className="dealer">DEALER</div>
      <div className="art-caption">{message("brand.artCaption")}</div>
    </div>
  );
}
