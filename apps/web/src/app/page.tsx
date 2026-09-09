import Link from "next/link";

import { message } from "../messages/zh-CN";
import { PokerArt } from "../components/poker-art";
import { StartGameButton } from "../components/start-game-button";

export default function Home() {
  return (
    <main className="landing-page">
      <div className="wrap">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow">{message("brand.eyebrow")}</div>
            <h1 id="hero-title">
              {message("brand.headlineFirst")}
              <span className="second">
                {message("brand.headlineSecond")}
                <em>{message("brand.headlineAccent")}</em>
              </span>
            </h1>
            <p>
              {message("brand.introFirst")}
              <br />
              {message("brand.introSecond")}
            </p>
            <div className="actions">
              <StartGameButton>{message("brand.start")}</StartGameButton>
              <Link className="rr-button" href="/join">
                {message("brand.haveCode")}
                <span className="rr-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </div>
            <div className="fine-print">
              <span>{message("brand.noDownload")}</span>
              <b>·</b>
              <span>{message("brand.privateRoom")}</span>
              <b>·</b>
              <span>{message("brand.chipsOnly")}</span>
            </div>
          </div>
          <PokerArt />
        </section>
        <section className="facts" aria-label={message("brand.features")}>
          <div className="facts-intro">
            Less setup.
            <br />
            More poker.
          </div>
          {(["people", "game", "private"] as const).map((key, index) => (
            <div className="fact" key={key}>
              <span className="fact-symbol" aria-hidden="true">
                {["♧", "♤", "♢"][index]}
              </span>
              <div>
                <strong>{message(`brand.facts.${key}.title`)}</strong>
                <small>{message(`brand.facts.${key}.description`)}</small>
              </div>
            </div>
          ))}
        </section>
        <section className="how" id="how" aria-labelledby="how-title">
          <div className="section-top">
            <div>
              <p className="kicker">01 / TAKE YOUR SEAT</p>
              <h2 id="how-title">
                {message("brand.howFirst")}
                <br />
                {message("brand.howSecond")}
              </h2>
            </div>
            <p>{message("brand.howDescription")}</p>
          </div>
          <div className="steps">
            {(["create", "invite", "play"] as const).map((key, index) => (
              <article className="step" key={key}>
                <span className="step-num">0{index + 1}</span>
                <span className="step-mark" aria-hidden="true">
                  {["♣", "♦", "♠"][index]}
                </span>
                <h3>{message(`brand.steps.${key}.title`)}</h3>
                <p>{message(`brand.steps.${key}.description`)}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="closing">
          <div>
            <h2>The table is yours.</h2>
            <p>{message("brand.closing")}</p>
          </div>
          <StartGameButton>{message("brand.closingAction")}</StartGameButton>
        </section>
      </div>
    </main>
  );
}
