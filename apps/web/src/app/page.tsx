import Link from "next/link";

import { message } from "../messages/zh-CN";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white p-8 text-center text-neutral-900">
      <h1 className="text-3xl font-bold">{message("home.title")}</h1>
      <p className="text-neutral-600">{message("home.introduction")}</p>
      <nav aria-label={message("navigation.home")} className="flex gap-3">
        <Link className="rounded-md bg-neutral-900 px-4 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2" href="/create">{message("home.createRoom")}</Link>
        <Link className="rounded-md border border-neutral-300 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2" href="/join">{message("home.joinRoom")}</Link>
      </nav>
    </main>
  );
}
