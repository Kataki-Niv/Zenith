"use client";


import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Sun, Menu, X } from "lucide-react";

const NAV_LINKS = [
  { id: "get-started", label: "Get Started" },
  { id: "features", label: "Features" },
  { id: "how-it-works", label: "Why Zenith" },
  { id: "intelligence", label: "Intelligence" },
  { id: "testimonials", label: "Testimonials" },
  { id: "pricing", label: "Pricing" },
  { id: "faq", label: "FAQ" },
];

export default function Navbar() {
  const router = useRouter();
  const pathname = usePathname();

  const [isScrolled, setIsScrolled] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const syncLoginState = useCallback(() => {
    const loginState = localStorage.getItem("isLoggedIn");
    setIsLoggedIn(loginState === "true");
  }, []);

  // Scroll detection
  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Login detection
  useEffect(() => {
    const handleStorageChange = () => syncLoginState();

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("auth-changed", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("auth-changed", handleStorageChange);
    };
  }, [syncLoginState]);

  useEffect(() => {
    syncLoginState();
  }, [pathname, syncLoginState]);

  const handleLogout = () => {
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("redirectAfterLogin");
    setIsLoggedIn(false);
    window.dispatchEvent(new Event("auth-changed"));
    router.push("/");
  };

  const scrollToId = (id?: string) => {
    if (!id) return;

    if (pathname !== "/") {
      router.push("/");
      setTimeout(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth" });
      }, 300);
    } else {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth" });
    }
  };

  return (
    <nav
      className={`fixed top-0 w-full z-50 transition-all duration-300 border-b ${
        isScrolled
           ? "bg-[#030303]/80 backdrop-blur-xl border-white/10 py-4"
           : "bg-transparent border-transparent py-6"
      }`}
    >
      <div className="max-w-[84rem] mx-auto px-16 lg:px-20 flex items-center justify-between">
        {/* Brand */}
        <div
          className="flex items-center gap-3 cursor-pointer group -ml-2"
          onClick={() => {
            router.push("/");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 flex items-center justify-center">
            <Sun size={22} className="text-black" />
          </div>
          <span className="text-2xl font-bold tracking-tight text-white">
            Zenith
          </span>
        </div>

        {/* Desktop Links */}
        <div className="hidden lg:flex items-center gap-8 whitespace-nowrap">
          {NAV_LINKS.map((link) => (
            <button
              key={link.id}
              onClick={() => scrollToId(link.id)}
              className="text-sm font-medium text-gray-400 hover:text-white transition-colors"
            >
              {link.label}
            </button>
          ))}
        </div>

        {/* Desktop Actions */}
        <div className="hidden lg:flex items-center gap-5">
          {!isLoggedIn ? (
            <button
              onClick={() => router.push("/login")}
              className="text-sm font-medium text-gray-300 hover:text-white transition"
            >
              Sign In
            </button>
          ) : (
            <button
              onClick={handleLogout}
              className="text-sm font-medium text-gray-400 hover:text-white transition"
            >
              Log Out
            </button>
          )}
        </div>

        {/* Mobile Toggle */}
        <button
          className="lg:hidden text-white"
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? <X size={28} /> : <Menu size={28} />}
        </button>
      </div>
    </nav>
  );
}
