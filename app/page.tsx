"use client"

import React, { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence, useScroll, useTransform } from "framer-motion"
import {
  ArrowRight, Sun, BarChart3, Cpu, CheckCircle2,
  Zap, Shield, Calculator, ChevronDown, Menu, X,
  Play, Star, Users, Building, MapPin, IndianRupee, Leaf
} from "lucide-react"

// ================= CONSTANTS & DATA =================

const NAV_LINKS = [
  { id: "get-started", label: "Get Started" },
  { id: "features", label: "Features" },
  { id: "how-it-works", label: "Why Zenith" },
  { id: "intelligence", label: "Intelligence" },
  { id: "testimonials", label: "Testimonials" },
  { id: "pricing", label: "Pricing" },
  { id: "faq", label: "FAQ" }
]




const BENTO_FEATURES = [
  {
    title: "Deterministic Financial Modeling",
    desc: "Get precise payback periods, IRR, and NPV calculations customized to your state's grid tariffs.",
    icon: <Calculator size={24} className="text-emerald-400" />,
    colSpan: "md:col-span-2",
    delay: 0.1
  },
  {
    title: "Subsidy Logic",
    desc: "Applies PM Surya Ghar subsidy rules based on MNRE guidelines for eligibility estimates.",
    icon: <Shield size={24} className="text-cyan-400" />,
    colSpan: "md:col-span-1",
    delay: 0.2
  },
  {
    title: "AI Explanations",
    desc: "Complex tier-based tariffs broken down into readable, actionable language.",
    icon: <Cpu size={24} className="text-purple-400" />,
    colSpan: "md:col-span-1",
    delay: 0.3
  },
  {
    title: "Installer Export",
    desc: "Generate white-labeled PDF proposals to close residential clients faster.",
    icon: <Building size={24} className="text-amber-400" />,
    colSpan: "md:col-span-2",
    delay: 0.4
  }
]

const TESTIMONIALS = [
  {
    name: "Manya Tiwari Roy",
    role: "Homeowner, Bengaluru",
    text: "The idea behind Zenith is a game-changer. Providing homeowners with a deterministic ROI and a transparent look at the solar process is exactly what’s missing in the market right now."
  },
  {
    name: "Akshat Roy",
    role: "Renewable Energy Consultant",
    text: "The automated system sizing approach solves the biggest bottleneck in residential solar—the site survey. This reduces time-to-deploy significantly."
  },
  {
    name: "Neelam Kumari",
    role: "EPC Manager, Patna",
    text: "Zenith bridges the trust gap. Auto subsidy and tariff analysis makes solar accessible and understandable for everyone."
  },
  {
    name: "Jaisheel Kumar",
    role: "Installer Partner, Delhi",
    text: "Connecting vetted installers with homeowners who already have high-accuracy feasibility reports creates a seamless ecosystem."
  }
]

const FAQS = [
  { q: "How accurate is the Zenith Feasibility Score?", a: "Our FS-Score uses structured financial modelling and state tariff logic to generate realistic projections based on your inputs."},
  { q: "Does this include the PM Surya Ghar scheme?", a: "Yes — Zenith aligns subsidy calculations with current MNRE rooftop solar guidelines and estimates eligibility automatically." },
  { q: "Is Zenith free for homeowners?", a: "The basic feasibility report is free. Premium features (white-labeled proposals, CRM exports) are paid." },
  { q: "Can I connect with an installer through Zenith?", a: "Yes — you can opt-in to receive quotes from our network of verified installers after generating a report." }
]

// ================= MAIN COMPONENT =================



export default function WelcomePage() {
  const router = useRouter()

const navigateProtected = (path: string) => {
  const isLoggedIn = localStorage.getItem("isLoggedIn");

  if (isLoggedIn) {
    router.push(path);
  } else {
    localStorage.setItem("redirectAfterLogin", path);
    router.push("/login");
  }
};


  const [isScrolled, setIsScrolled] = useState(false)
  const { scrollYProgress } = useScroll()
  const opacity = useTransform(scrollYProgress, [0, 0.05], [1, 0])

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 50)
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <div className="min-h-screen bg-[#06090f] text-gray-50 font-sans selection:bg-emerald-500/30 overflow-x-hidden">
      {/* GLOBAL BACKGROUND GLOWS */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-emerald-600/10 blur-[150px] rounded-full" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-cyan-600/10 blur-[150px] rounded-full" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.04] mix-blend-overlay" />
      </div>

      
      <main className="relative z-10 flex flex-col items-center w-full">
        <HeroSection opacity={opacity} navigateProtected={navigateProtected} />

<BentoFeaturesSection />          {/* Features */}

<ProblemSolutionSection />        {/* Why Zenith*/}

<SolarIntelligenceSection navigateProtected={navigateProtected} />      {/* Intelligence */}

<InteractivePreviewSection />     {/* Sample Projection */}



<TestimonialsSection />

<PricingSection navigateProtected={navigateProtected} />

<FAQSection />                    {/* Always last */}

        
      </main>

      <Footer />
    </div>
  )
}

// ================= SUB-COMPONENTS =================

function scrollToId(id?: string) {
  if (!id) return
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
}

function HeroSection({
  opacity,
  navigateProtected
}: {
  opacity: any;
  navigateProtected: (path: string) => void;
}) {
   const router = useRouter();
  return (
<section
  id="get-started"
  className="w-full max-w-[84rem] mx-auto px-16 lg:px-20 pt-34 pb-12 flex flex-col lg:flex-row items-center gap-12 min-h-[84vh] scroll-mt-32"
>

      {/* TEXT */}
      <motion.div
        style={{ opacity }}
        initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: "easeOut" }}
        className="flex-1 text-center lg:text-left z-10"
      >
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-semibold mb-6 backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          PM Surya Ghar Subsidy Supported
        </div>

        <h1 className="text-5xl sm:text-6xl lg:text-[5.5rem] font-extrabold leading-[1.02] mb-5 tracking-tighter">
          Solar ROI, <br className="hidden lg:block" />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-500">
            Demystified.
          </span>
        </h1>

        <p className="text-[1.15rem] text-gray-400 mb-7 max-w-[42rem] mx-auto lg:mx-0 leading-relaxed font-light">
          A deterministic feasibility engine built for the Indian grid. Structured financial modelling with MNRE-aligned subsidy logic — fast, transparent, actionable.
        </p>

        <div className="flex flex-col sm:flex-row items-center gap-4 justify-center lg:justify-start">
          <button
            onClick={() => navigateProtected("/engine")}
            className="bg-emerald-500 text-black hover:bg-emerald-400 px-6 py-3.5 rounded-full font-bold hover:bg-gray-200 transition-all shadow-[0_0_20px_rgba(255,255,255,0.06)] flex items-center gap-3"
          >
            How Zenith Works? <Zap size={18} />
          </button>

          <button
            onClick={() => router.push("/demo")}
            className="w-full sm:w-auto bg-white/5 border border-white/10 px-6 py-3.5 rounded-full font-semibold hover:bg-white/10 transition-all flex items-center justify-center gap-2"
          >
            <Play size={18} className="fill-white" /> Watch Demo
          </button>
        </div>
      </motion.div>
    </section>
  )
}

function ProblemSolutionSection() {
  return (
    <section className="w-full max-w-[84rem] mx-auto px-16 lg:px-20 py-24 scroll-mt-12" id="how-it-works">
      <div className="text-center mb-18">
        <h2 className="text-4xl md:text-5xl font-bold mb-6">Stop guessing your ROI.</h2>
        <p className="text-xl text-gray-400 max-w-2xl mx-auto">Zenith brings deterministic intelligence to your roof — quick, accurate feasibility and subsidy insights without the sales call.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        <div className="bg-red-500/10 border border-red-500/20 rounded-3xl p-10">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center text-red-400 font-bold">X</div>
            <h3 className="text-2xl font-semibold text-gray-300">The Old Way</h3>
          </div>
          <ul className="space-y-6 text-gray-400">
            <li className="flex items-start gap-3"><span className="text-red-400 mt-1">✗</span> Wait days for physical site visits.</li>
            <li className="flex items-start gap-3"><span className="text-red-400 mt-1">✗</span> Confusing quotes with hidden BOS costs.</li>
            <li className="flex items-start gap-3"><span className="text-red-400 mt-1">✗</span> Unclear tracking of MNRE subsidy disbursement.</li>
          </ul>
        </div>

        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-3xl p-10 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/10 blur-[80px]" />
          <div className="flex items-center gap-3 mb-8 relative z-10">
            <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 font-bold">✓</div>
            <h3 className="text-2xl font-semibold text-white">The Zenith Way</h3>
          </div>
          <ul className="space-y-6 text-gray-300 relative z-10">
            <li className="flex items-start gap-3"><CheckCircle2 className="text-emerald-400 mt-0.5" size={20} /> Automated system sizing based on usage & roof area.</li>
            <li className="flex items-start gap-3"><CheckCircle2 className="text-emerald-400 mt-0.5" size={20} /> Transparent BOM pricing breakdown.</li>
            <li className="flex items-start gap-3"><CheckCircle2 className="text-emerald-400 mt-0.5" size={20} /> Auto-calculated state tariffs & net-metering ROI.</li>
          </ul>
        </div>
      </div>
    </section>
  )
}

function SolarIntelligenceSection({
  navigateProtected
}: {
  navigateProtected: (path: string) => void;
}) {
  const router = useRouter()

  return (
    <section 
  id="intelligence"
  className="w-full bg-[#020202] text-white px-16 lg:px-20 py-16 scroll-mt-28"
>

      <div className="text-center max-w-4xl mx-auto mb-18">
        <h2 className="text-4xl md:text-5xl font-black uppercase tracking-tight mb-6">
          Intelligent Solar Decision Layers
        </h2>
        <p className="text-zinc-400 text-lg md:text-xl">
          From feasibility scoring to subsidy optimization —
          everything required to deploy rooftop solar intelligently.
        </p>
      </div>

      <div className="space-y-24 max-w-[84rem] mx-auto">

        {/* 1 — FS SCORE */}
        <div className="grid md:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div className="relative h-[380px] md:h-[420px] rounded-3xl overflow-hidden border border-white/10">
            <img
              src="/images/service1.jpg"
              className="absolute inset-0 w-full h-full object-cover opacity-100"
            />
            <div className="absolute inset-0 bg-black/30" />
          </div>

          <div>
            <h3 className="text-3xl md:text-4xl font-black mb-6 uppercase">
              1. The Payback Pulse
            </h3>

            <p className="text-zinc-400 text-lg leading-relaxed mb-8">
              The Payback Pulse is the ultimate mood ring for a home’s energy bill. 
              By dropping in a location or tossing a digital copy of an electricity bill the platform's way, 
              the system crunches the numbers in the background to see how a specific roof handles the sun.
              The AI then steps in to deliver a straight-talk verdict on whether going solar actually makes sense for the user’s wallet.
              It cuts through the technical noise to show exactly how much green stays in the bank, turning complex feasibility stats into a clear, no-nonsense "go" or "no-go" for the project.
            </p>

            <button
              onClick={() => navigateProtected("/service1")}
              className="px-8 py-4 bg-emerald-500 text-black font-bold uppercase tracking-widest rounded-xl hover:bg-emerald-400 hover:text-black transition-all duration-200"
            >
              Analyze Now
            </button>
          </div>
        </div>

        {/* 2 — FORECAST */}
        <div className="grid md:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div className="order-2 md:order-1">
            <h3 className="text-3xl md:text-4xl font-black mb-6 uppercase">
              The 20-Year Vision
            </h3>

            <p className="text-zinc-400 text-lg leading-relaxed mb-8">
            The 20-Year Vision is like having a crystal ball for a home's financial future.
            Instead of guessing how the years ahead will play out, the system runs high-tech simulations to see how the solar setup handles everything from rising energy prices to those golden tax perks. 
            Once the engine finishes the heavy lifting, the AI steps in to translate the complex long-term data into a simple, easy-to-read map of how the investment grows and pays off over two decades. It’s all about visualizing the long-game win, turning complicated cash-flow projections into a clear, stress-free strategy for the future.
            </p>

            <button
              onClick={() => navigateProtected("/service2")}
              className="px-8 py-4 bg-emerald-500 text-black font-bold uppercase tracking-widest rounded-xl hover:bg-emerald-400 hover:text-black transition-all duration-200"
            >
              View Projection
            </button>
          </div>

          <div className="relative h-[380px] md:h-[420px] rounded-3xl overflow-hidden border border-white/10 order-1 md:order-2">
            <img
              src="/images/service2.jpg"
              className="absolute inset-0 w-full h-full object-cover opacity-100"
            />
            <div className="absolute inset-0 bg-black/30" />
          </div>
        </div>

        {/* 3 — SUBSIDY */}
        <div className="grid md:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div className="relative h-[380px] md:h-[420px] rounded-3xl overflow-hidden border border-white/10">
            <img
              src="/images/service3.jpg"
              className="absolute inset-0 w-full h-full object-cover opacity-100"
            />
            <div className="absolute inset-0 bg-black/30" />
          </div>

          <div>
            <h3 className="text-3xl md:text-4xl font-black mb-6 uppercase">
              The Subsidy Scout
            </h3>

            <p className="text-zinc-400 text-lg leading-relaxed mb-8">
              The Subsidy Scout serves as a personal guide through the maze of Indian government solar incentives.
              Instead of getting bogged down in confusing paperwork, the system automatically checks a user’s 
              details against schemes like the PM Surya Ghar to see if they qualify for a boost. 
              Once the eligibility check is complete, the AI explains exactly what is on the table, 
              summarizing how these incentives shrink the total installation price and shorten the path to savings.
               It’s the easiest way to ensure no government benefits are left on the table.
            </p>

            <button
              onClick={() => navigateProtected("/service3")}
              className="px-8 py-4 bg-emerald-500 text-black font-bold uppercase tracking-widest rounded-xl hover:bg-emerald-400 hover:text-black transition-all duration-200"
            >
              Check Eligibility
            </button>
          </div>
        </div>

        {/* 4 — ROOFTOP */}
        <div className="grid md:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div className="order-2 md:order-1">
            <h3 className="text-3xl md:text-4xl font-black mb-6 uppercase">
              The Photon Hunter
            </h3>

            <p className="text-zinc-400 text-lg leading-relaxed mb-8">
              The Photon Hunter turns roof analysis into a futuristic virtual tour.
               By simply uploading a quick video of the roof, the system’s backend analyzes the orientation, 
               shading, and usable area to see where the light hits best. The AI then explains this visual data,
                generating a clear summary of the potential energy production and where the panels should actually live.
                 It serves as a digital dress rehearsal, letting users see the perfect setup and energy potential 
                 before a single technician even grabs a ladder.

            </p>

            <button
              onClick={() => navigateProtected("/service4")}
              className="px-8 py-4 bg-emerald-500 text-black font-bold uppercase tracking-widest rounded-xl hover:bg-emerald-400 hover:text-black transition-all duration-200"
            >
              Analyze Rooftop
            </button>
          </div>

          <div className="relative h-[380px] md:h-[420px] rounded-3xl overflow-hidden border border-white/10 order-1 md:order-2">
            <img
              src="/images/service4.jpg"
              className="absolute inset-0 w-full h-full object-cover opacity-100"
            />
            <div className="absolute inset-0 bg-black/30" />
          </div>
        </div>

      </div>
    </section>
  )
}




function BentoFeaturesSection() {
  return (
    <section className="w-full max-w-[84rem] mx-auto px-16 lg:px-20 py-16" id="features">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {BENTO_FEATURES.map((feat, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-100px" }} transition={{ duration: 0.5, delay: feat.delay }}
            className={`${feat.colSpan} bg-white/[0.02] border border-white/10 hover:border-white/20 transition-all rounded-3xl p-7 group relative overflow-hidden`}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="mb-6 inline-block p-4 rounded-2xl bg-white/5 border border-white/10 group-hover:scale-110 transition-transform duration-300">
              {feat.icon}
            </div>
            <h3 className="text-2xl font-bold mb-3 text-white">{feat.title}</h3>
            <p className="text-gray-400 leading-relaxed">{feat.desc}</p>
          </motion.div>
        ))}
      </div>
    </section>
  )
}

function InteractivePreviewSection() {
  return (
    <section className="w-full py-16 px-16 lg:px-20">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ duration: 0.8 }}
        className="w-full max-w-[84rem] mx-auto rounded-[3rem] bg-gradient-to-b from-[#0a0a0a] to-[#050505] border border-white/10 p-4 md:p-7 shadow-[0_0_100px_rgba(52,211,105,0.05)]"
      >
        <div className="text-center mb-12 pt-8">
          <div className="inline-block mb-4 px-4 py-1 text-xs font-semibold bg-white/5 border border-white/10 rounded-full text-gray-400">
            Sample Projection
          </div>

          <h2 className="text-3xl md:text-5xl font-bold mb-4">A Dashboard built for clarity.</h2>
          <p className="text-gray-400">Complex solar math, beautifully simplified.</p>
        </div>

        <div className="w-full border border-white/10 rounded-2xl overflow-hidden bg-[#030303] shadow-2xl">
          <div className="flex border-b border-white/5 bg-[#0a0a0a]">
            <div className="px-6 py-4 border-b-2 border-emerald-500 text-emerald-400 font-medium text-sm">Overview</div>
            <div className="px-6 py-4 text-gray-500 text-sm font-medium">Financials</div>
            <div className="px-6 py-4 text-gray-500 text-sm font-medium">System Design</div>
          </div>

          <div className="p-8 grid md:grid-cols-3 gap-8">
            <div className="col-span-2 space-y-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { l: "System Size", v: "5.4 kW", i: <Zap size={16} className="text-amber-400" /> },
                  { l: "Est. Generation", v: "7,800 kWh", i: <Sun size={16} className="text-yellow-400" /> },
                  { l: "Gross Cost", v: "₹2.7L", i: <IndianRupee size={16} className="text-gray-400" /> },
                  { l: "Net Cost", v: "₹1.92L", i: <Shield size={16} className="text-emerald-400" /> },
                ].map((stat, i) => (
                    <div key={i} className="bg-white/5 border border-white/5 p-4 rounded-xl">
                    <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">{stat.i} {stat.l}</div>
                      <div className="text-xl font-bold text-white">{stat.v}</div>
                  </div>
                ))}
              </div>

              <div className="bg-white/5 border border-white/5 rounded-xl p-6 h-64 flex flex-col justify-end gap-2 relative">
                <div className="absolute top-6 left-6 text-sm font-medium text-gray-400">25-Year Cash Flow</div>
                <div className="flex items-end gap-2 h-32">
                  {[10, 20, 30, -40, -50, 60, 70, 80, 90, 100].map((h, i) => (
                    <div key={i} className={`flex-1 rounded-t-sm transition-all duration-1000 ${h < 0 ? 'bg-red-500/50' : 'bg-emerald-500'}`} style={{ height: `${Math.abs(h)}%` }} />
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6 flex flex-col justify-center">
              <h4 className="text-lg font-bold text-emerald-400 mb-2">Payback Period</h4>
              <div className="text-5xl font-black text-white mb-6">3.2 <span className="text-xl text-gray-400 font-normal">Years</span></div>
              <div className="space-y-4">
                <div className="flex justify-between text-sm border-b border-white/10 pb-2"><span className="text-gray-400">Monthly Bill Pre-Solar</span><span>₹5,500</span></div>
                <div className="flex justify-between text-sm border-b border-white/10 pb-2"><span className="text-gray-400">Monthly Bill Post-Solar</span><span className="text-emerald-400">₹320</span></div>
                <div className="flex justify-between text-sm border-b border-white/10 pb-2"><span className="text-gray-400">Lifetime Savings</span><span className="font-bold">₹15.4L</span></div>
              </div>
              <button className="w-full mt-8 bg-emerald-500 text-black py-3 rounded-lg font-bold hover:bg-emerald-400 transition">Export PDF</button>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  )
}

function TestimonialsSection() {
  return (
    <section className="w-full max-w-[84rem] mx-auto px-16 lg:px-20 py-20" id="testimonials">
      <div className="text-center mb-14">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">Trusted by India's Transition</h2>
        <p className="text-gray-400">From homeowners to top-tier EPCs.</p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
        {TESTIMONIALS.map((t, i) => (
          <div key={i} className="bg-white/5 border border-white/10 p-8 rounded-3xl flex flex-col justify-between">
            <div>
              <div className="flex gap-1 mb-4">
                {[...Array(5)].map((_, j) => <Star key={j} size={16} className="fill-amber-400 text-amber-400" />)}
              </div>
              <p className="text-gray-300 leading-relaxed text-sm mb-6">"{t.text}"</p>
            </div>
            <div>
              <p className="font-bold text-white">{t.name}</p>
              <p className="text-xs text-gray-400">{t.role}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function PricingSection({
  navigateProtected
}: {
  navigateProtected: (path: string) => void;
}) {
  return (
    <section className="w-full max-w-[84rem] mx-auto px-16 lg:px-20 py-20" id="pricing">
      <div className="text-center mb-14">
        <h2 className="text-3xl md:text-4xl font-bold mb-4">Built for Real Solar Decisions.</h2>
        <p className="text-gray-400">
          Whether you're installing on your own roof or closing rooftop deals.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">

        {/* ================= HOMEOWNER ================= */}
        <div className="bg-[#0a0a0a] border border-white/10 p-10 rounded-3xl">

          <h3 className="text-2xl font-bold mb-2">
            Homeowner Planning Toolkit
          </h3>

          <p className="text-gray-400 text-sm mb-8">
            Designed for Indian households evaluating rooftop solar before speaking to installers.
          </p>

          <div className="text-5xl font-black mb-4">
            ₹0 <span className="text-lg text-gray-500 font-normal">/forever</span>
          </div>

          <p className="text-xs text-gray-500 mb-6">
            No credit card. No sales pressure.
          </p>

          <ul className="space-y-4 mb-10 text-sm text-gray-300">
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              Feasibility Score with ROI & Payback Analysis
            </li>
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              PM Surya Ghar Subsidy Eligibility & Slab Estimate
            </li>
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              25-Year Savings & Electricity Inflation Projection
            </li>
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              Basic Rooftop Size & Generation Estimation
            </li>
          </ul>

          <button
            onClick={() => navigateProtected("/service1")}
            className="w-full py-4 rounded-xl border border-white/20 hover:bg-white/5 transition font-semibold"
          >
            Analyze My Roof
          </button>
        </div>


        {/* ================= EPC PRO ================= */}
        <div className="bg-gradient-to-b from-emerald-900/40 to-[#0a0a0a] border border-emerald-500/50 p-10 rounded-3xl relative">

          <div className="absolute top-0 right-10 transform -translate-y-1/2 bg-emerald-500 text-black text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
            Most Popular
          </div>

          <h3 className="text-2xl font-bold mb-2 text-white">
            EPC & Installer Intelligence Suite
          </h3>

          <p className="text-emerald-400/80 text-sm mb-8">
            Built for solar businesses closing residential rooftop projects in India.
          </p>

          <div className="text-5xl font-black mb-4">
            ₹2,499 <span className="text-lg text-gray-500 font-normal">/month</span>
          </div>

          <p className="text-xs text-gray-500 mb-6">
            14-day free trial. Cancel anytime.
          </p>

          <ul className="space-y-4 mb-10 text-sm text-gray-300">
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              Client-Ready White-Labeled Proposal PDF
            </li>
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              Advanced IRR, NPV & Cashflow Modelling
            </li>
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              Lead Export & CRM-Ready Customer Reports
            </li>
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              Rooftop Layout & System Configuration Summary
            </li>
            <li className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-emerald-400"/>
              Priority Policy & Technical Updates
            </li>
          </ul>

          <button
            onClick={() => window.location.href = "/pricing"}
            className="w-full py-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black transition font-bold shadow-[0_0_20px_rgba(52,211,105,0.3)]"
          >
            Activate Pro Suite
          </button>
        </div>

      </div>
    </section>
  )

}

function FAQSection() {
  const [activeFaq, setActiveFaq] = useState<number | null>(null)

  return (
    <section className="w-full max-w-4xl mx-auto px-16 lg:px-20 py-20" id="faq">
      <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">Frequently Asked Questions</h2>
      <div className="space-y-4">
        {FAQS.map((faq, i) => (
          <div key={i} className="border border-white/10 bg-white/[0.02] rounded-2xl overflow-hidden transition-all hover:border-white/20">
            <button
              onClick={() => setActiveFaq(activeFaq === i ? null : i)}
              className="w-full px-6 py-6 flex items-center justify-between text-left focus:outline-none"
            >
              <span className="font-medium text-lg text-gray-200">{faq.q}</span>
              <ChevronDown className={`transition-transform duration-300 ${activeFaq === i ? "rotate-180 text-emerald-400" : "text-gray-500"}`} />
            </button>
            <AnimatePresence>
              {activeFaq === i && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="px-6 pb-6 text-gray-400 text-sm leading-relaxed"
                >
                  {faq.a}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </section>
  )
}

function BottomCTA({
  navigateProtected
}: {
  navigateProtected: (path: string) => void;
}) {
  return (
    <section className="w-full max-w-7xl mx-auto px-6 py-32">
      <div className="w-full bg-gradient-to-br from-emerald-600 to-cyan-700 rounded-[3rem] p-12 md:p-24 text-center relative overflow-hidden shadow-2xl">

        <div className="absolute inset-0 bg-black/20" />

        <div className="relative z-10 max-w-3xl mx-auto">

          <h2 className="text-4xl md:text-6xl font-extrabold mb-6 text-white leading-tight">
            Calculate Your Solar ROI in 60 Seconds.
          </h2>

          <p className="text-xl text-emerald-50 mb-10 font-medium opacity-90">
            Get instant feasibility, subsidy estimate and 25-year savings projection — before talking to any installer.
          </p>

          <button
              onClick={() => navigateProtected("/service1")}
            className="bg-white text-black px-10 py-5 rounded-full font-extrabold text-lg hover:scale-105 transition-transform shadow-[0_20px_40px_rgba(0,0,0,0.3)] flex items-center gap-3 mx-auto"
          >
            Start Free Analysis <Zap size={20} className="fill-black" />
          </button>

        </div>
      </div>
    </section>
  )
}


function Footer() {
  return (
    <footer className="w-full border-t border-white/10 bg-[#020202] pt-16 pb-10 px-16 lg:px-20 relative z-10">
      <div className="max-w-[84rem] mx-auto grid grid-cols-2 md:grid-cols-5 gap-8 mb-14">
        <div className="col-span-2">
          <div className="flex items-center gap-2 mb-6">
            <Sun size={24} className="text-emerald-400" />
            <h1 className="text-2xl font-bold text-white">Zenith</h1>
          </div>
          <p className="text-gray-500 text-sm max-w-sm mb-6 leading-relaxed">
            India-focused solar feasibility and subsidy intelligence platform. Deterministic calculations. AI-assisted insights. Structured decision output.
          </p>
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 cursor-pointer transition">𝕏</div>
            <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 cursor-pointer transition">in</div>
          </div>
        </div>

        <div>
          <h4 className="text-white font-semibold mb-4 tracking-wide">Product</h4>
          <ul className="space-y-3 text-sm text-gray-500">
            <li><button onClick={() => scrollToId("features")} className="hover:text-emerald-400 transition">Feasibility Engine</button></li>
            <li><button className="hover:text-emerald-400 transition">Subsidy Tracker</button></li>
            <li><button className="hover:text-emerald-400 transition">For EPCs</button></li>
            <li><button className="hover:text-emerald-400 transition">Pricing</button></li>
          </ul>
        </div>

        <div>
          <h4 className="text-white font-semibold mb-4 tracking-wide">Resources</h4>
          <ul className="space-y-3 text-sm text-gray-500">
            <li><button className="hover:text-emerald-400 transition">MNRE Guidelines</button></li>
            <li><button className="hover:text-emerald-400 transition">State Tariffs</button></li>
            <li><button className="hover:text-emerald-400 transition">Solar ROI Calculator</button></li>
            <li><button className="hover:text-emerald-400 transition">Blog</button></li>
          </ul>
        </div>

        <div>
          <h4 className="text-white font-semibold mb-4 tracking-wide">Legal</h4>
          <ul className="space-y-3 text-sm text-gray-500">
            <li><button className="hover:text-emerald-400 transition">Privacy Policy</button></li>
            <li><button className="hover:text-emerald-400 transition">Terms of Service</button></li>
            <li><button className="hover:text-emerald-400 transition">MNRE Disclaimer</button></li>
          </ul>
        </div>
      </div>

      <div className="max-w-[84rem] mx-auto border-t border-white/10 pt-8 flex flex-col md:flex-row items-center justify-between text-sm text-gray-600 font-medium">
        <p>© {new Date().getFullYear()} Zenith Technologies. All rights reserved.</p>
        <div className="flex items-center gap-2 mt-4 md:mt-0">
          <MapPin size={14} /> Built in Bhubaneswar, India.
        </div>
      </div>
    </footer>
  )
}
