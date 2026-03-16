"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

const handleLogin = () => {
  setError("");

  // 1️⃣ Check empty fields
  if (!email || !password) {
    setError("Please fill all fields");
    return;
  }

  // 2️⃣ Check credentials
  if (email === "admin@zenith.com" && password === "zenith123") {
    localStorage.setItem("isLoggedIn", "true");
    window.dispatchEvent(new Event("auth-changed"));

    const redirectPath = localStorage.getItem("redirectAfterLogin");

    if (redirectPath) {
      router.replace(redirectPath);
      localStorage.removeItem("redirectAfterLogin");
    } else {
      router.replace("/");
    }

  } else {
    setError("Invalid email or password");
  }
};

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#06090f] px-4 pt-24 text-gray-50">
      <div
        className="w-full max-w-md rounded-3xl p-10
        bg-white/[0.04]
        border border-white/10
        shadow-2xl shadow-emerald-950/20"
      >
        <h1 className="text-3xl font-semibold text-center text-gray-50">
          Welcome back
        </h1>
        <p className="text-center text-gray-400 mt-2 mb-10">
          Login to your Zenith dashboard
        </p>

        {/* Email */}
        <div className="mb-6">
          <label className="block text-sm text-gray-300 mb-2">
            Email or Username
          </label>
          <input
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@zenith.com"
            className="
              w-full rounded-xl px-4 py-3
              bg-white/5
              text-gray-50
              placeholder:text-gray-500
              border border-white/10
              focus:outline-none focus:border-emerald-400
            "
          />
        </div>

        {/* Password */}
        <div className="mb-4">
          <label className="block text-sm text-gray-300 mb-2">
            Password
          </label>

          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="
                w-full rounded-xl px-4 py-3 pr-12
                bg-white/5
                text-gray-50
                border border-white/10
                focus:outline-none focus:border-emerald-400
              "
            />

            {/* Toggle button */}
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2
                text-sm text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {/* Forgot password */}
        <div className="text-right mb-6">
          <button className="text-sm text-emerald-400 hover:text-emerald-300 hover:underline">
            Forgot password?
          </button>
        </div>

        {/* Error message */}
        {error && (
          <p className="text-sm text-red-400 text-center mb-4">
            {error}
          </p>
        )}

        {/* Login button */}
        <button
          onClick={handleLogin}
          className="
            w-full py-3 rounded-xl
            bg-emerald-500
            text-black
            font-semibold
            hover:bg-emerald-400
            transition
          "
        >
          Login
        </button>

        <p className="text-center text-sm text-gray-400 mt-8">
          Don’t have an account?{" "}
          <span className="text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer">
            Sign up
          </span>
        </p>
      </div>
    </div>
  );
}
