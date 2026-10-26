"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./lib";

const LINKS = [
  { href: "/", label: "Review Desk", icon: Icon.desk, match: (p: string) => p === "/" || p.startsWith("/report") },
  { href: "/rulebook", label: "Nidhi's Rulebook", icon: Icon.book, match: (p: string) => p.startsWith("/rulebook") },
];

export default function Nav() {
  const path = usePathname() || "/";
  return (
    <nav className="nav">
      {LINKS.map(({ href, label, icon: I, match }) => (
        <Link key={href} href={href} id={`nav-${href === "/" ? "desk" : href.slice(1)}`} className={match(path) ? "active" : ""}>
          <I />
          {label}
        </Link>
      ))}
    </nav>
  );
}
