"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  Landmark,
  Home,
} from "lucide-react";

export default function Sidebar() {
  const pathname = usePathname();

  const isActive = (path: string) => pathname === path;

  const baseClasses =
    "relative flex items-center gap-3 px-4 py-3 rounded-lg transition group";

  const activeClasses =
    "text-[#22D3EE] bg-[#0A2A35]";

  const inactiveClasses =
    "text-[#F3F4F4]/70 hover:bg-[#0A2A35]";

  return (
    <aside
      className="
        w-64
        h-screen
        bg-[#020B10]
        border-r border-[#5F9598]/20
        px-6 py-8
      "
    >
      <h2 className="text-sm uppercase tracking-wider text-[#F3F4F4]/60 mb-6">
        Command Center
      </h2>

      <nav className="flex flex-col gap-2">

        {/* Service 1 */}
        <Link
          href="/service1"
          className={`${baseClasses} ${
            isActive("/service1") ? activeClasses : inactiveClasses
          }`}
          aria-current={isActive("/service1") ? "page" : undefined}
        >
          {isActive("/service1") && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 bg-cyan-400 rounded-full" />
          )}

          <Activity size={18} />
          <span>The Payback Pulse</span>
        </Link>


        {/* Service 2 */}
        <Link
          href="/service2"
          className={`${baseClasses} ${
            isActive("/service2") ? activeClasses : inactiveClasses
          }`}
          aria-current={isActive("/service2") ? "page" : undefined}
        >
          {isActive("/service2") && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 bg-cyan-400 rounded-full" />
          )}

          <BarChart3 size={18} />
          <span>The 20 Year Vision</span>
        </Link>


        {/* Service 3 */}
        <Link
          href="/service3"
          className={`${baseClasses} ${
            isActive("/service3") ? activeClasses : inactiveClasses
          }`}
          aria-current={isActive("/service3") ? "page" : undefined}
        >
          {isActive("/service3") && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 bg-cyan-400 rounded-full" />
          )}

          <Landmark size={18} />
          <span>The Subsidy Scout</span>
        </Link>


        {/* Service 4 */}
        <Link
          href="/service4"
          className={`${baseClasses} ${
            isActive("/service4") ? activeClasses : inactiveClasses
          }`}
          aria-current={isActive("/service4") ? "page" : undefined}
        >
          {isActive("/service4") && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 bg-cyan-400 rounded-full" />
          )}

          <Home size={18} />
          <span>The Photon Hunter</span>
        </Link>

      </nav>
    </aside>
  );
}
