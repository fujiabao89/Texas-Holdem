import Link from "next/link";

import { message } from "../messages/zh-CN";

export function RouteShell() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white p-8 text-center text-neutral-900">
      <h1 className="text-2xl font-semibold">{message("shell.pendingTitle")}</h1>
      <p className="max-w-md text-neutral-600">{message("shell.pendingDescription")}</p>
      <Link className="rounded-md border border-neutral-300 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2" href="/">
        {message("shell.backHome")}
      </Link>
    </main>
  );
}
