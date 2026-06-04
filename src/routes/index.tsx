import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import BookingCalendar from '../components/BookingCalendar'
import AdminBookingCalendar from '../components/AdminBookingCalendar'
import AuthModal from '../components/AuthModal'
import { useAuth } from '../hooks/useAuth'
import { useImpersonation } from '../hooks/useImpersonation'

export const Route = createFileRoute('/')({
  component: HomePage,
  // SPEC_SCHEDULE_DAY_VIEW §4: "Book Now → that day" deep-link (?date=YYYY-MM-DD).
  validateSearch: (search: Record<string, unknown>): { date?: string } => {
    const d = search.date
    return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? { date: d } : {}
  },
})

function HomePage() {
  const { isAuthenticated, isAdmin, isLoading } = useAuth()
  const { isImpersonating, impersonatedUser } = useImpersonation()
  const { date: initialDate } = Route.useSearch()
  const [showAuth, setShowAuth] = useState(false)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup')

  const openSignUp = () => { setAuthMode('signup'); setShowAuth(true) }
  const openSignIn  = () => { setAuthMode('signin');  setShowAuth(true) }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // ── Logged-in users go straight to the booking calendar ──
  if (isAuthenticated) {
    // Admin impersonating a user — show the customer view for that user
    if (isAdmin && isImpersonating && impersonatedUser) {
      return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Book a Training Net</h1>
            <p className="text-gray-500 mt-1">
              Customer view for <strong>{impersonatedUser.name}</strong> ({impersonatedUser.email})
            </p>
          </div>
          <BookingCalendar impersonatedEmail={impersonatedUser.email} initialDate={initialDate} />
        </div>
      )
    }
    if (isAdmin) {
      return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900">Booking Calendar</h1>
            <p className="text-gray-500 mt-1">Admin view — full 12-month history and forward bookings</p>
          </div>
          <AdminBookingCalendar />
        </div>
      )
    }
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Book a Training Net</h1>
          <p className="text-gray-500 mt-1">Reserve your lane and start training</p>
        </div>
        <BookingCalendar initialDate={initialDate} />
      </div>
    )
  }

  // ── Unauthenticated visitors see the marketing landing page ──
  return (
    <>
      <LandingPage onSignIn={openSignIn} onSignUp={openSignUp} />
      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={() => setShowAuth(false)}
          initialMode={authMode}
        />
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Landing page — shown to unauthenticated visitors
// ─────────────────────────────────────────────────────────────────────────────
function LandingPage({ onSignIn, onSignUp }: { onSignIn: () => void; onSignUp: () => void }) {
  const settings = useQuery(api.queries.getSiteSettings)

  /** Format a fractional hour like 9 → "9am", 21 → "9pm" */
  const fmtH = (h: number) => {
    const hr = h % 12 === 0 ? 12 : h % 12
    return `${hr}${h < 12 ? 'am' : 'pm'}`
  }

  const lanes = [
    {
      id: 'bm1', icon: '🎯', name: 'Bowling Machine 1', type: 'machine' as const,
      desc: 'Dial in your preferred speed and line for consistent, repeatable net sessions.',
    },
    {
      id: 'bm2', icon: '🎯', name: 'Bowling Machine 2', type: 'machine' as const,
      desc: 'Great for technical batting work, footwork drills, and high-rep practice.',
    },
    {
      id: 'bm3', icon: '🎯', name: 'Bowling Machine 3', type: 'machine' as const,
      desc: 'Dual-configuration lane — choose Standard delivery or the premium Truman machine.',
      variants: true,
    },
    {
      id: 'ru1', icon: '🏏', name: '9m Run Up 1', type: 'runup' as const,
      desc: 'Full 9-metre run up for seamers and spinners — or face a live bowler.',
    },
    {
      id: 'ru2', icon: '🏏', name: '9m Run Up 2', type: 'runup' as const,
      desc: 'Full 9-metre run up. Perfect for working on your bowling action and rhythm.',
    },
  ]

  const steps = [
    { n: 1, icon: '👤', title: 'Create a free account',   desc: 'Sign up with your name and email — takes under 30 seconds.' },
    { n: 2, icon: '📅', title: 'Pick your lane & time',   desc: 'Choose from 5 lanes. See live availability and select your slot.' },
    { n: 3, icon: '💳', title: 'Pay securely online',     desc: 'Stripe-powered checkout. No card details stored on our servers.' },
    { n: 4, icon: '🔑', title: 'Show up & train',         desc: 'Receive a unique gate access code by email. Walk in and get to work.' },
  ]

  return (
    <div className="bg-white overflow-x-hidden">

      {/* ── HERO ──────────────────────────────────────────────────────────── */}
      <section className="relative bg-gradient-to-br from-emerald-600 via-emerald-700 to-green-800 overflow-hidden">
        {/* Subtle background glows */}
        <div className="absolute top-0 left-0 w-80 h-80 bg-white/5 rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none" />
        <div className="absolute bottom-0 right-0 w-[30rem] h-[30rem] bg-white/5 rounded-full translate-x-1/3 translate-y-1/3 pointer-events-none" />

        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-28 text-center">
          {/* Pill badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/15 backdrop-blur-sm border border-white/20 text-white/90 text-sm font-medium mb-6">
            <span>🏏</span>
            <span>Revolution Sports — Perth Cricket Training</span>
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white tracking-tight leading-[1.1]">
            Train on your terms.<br />
            <span className="text-emerald-200">Book a net in seconds.</span>
          </h1>

          <p className="mt-6 text-lg sm:text-xl text-white/75 max-w-2xl mx-auto leading-relaxed">
            Five fully-equipped cricket training lanes — bowling machines and full run-up nets.
            Book online, pay securely, and get your gate access code instantly.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onSignUp}
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-white text-emerald-700 font-bold text-base shadow-lg hover:bg-emerald-50 transition-all active:scale-95"
            >
              Create Account — It's Free
            </button>
            <button
              onClick={onSignIn}
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-transparent text-white font-semibold text-base border border-white/40 hover:bg-white/10 transition-all active:scale-95"
            >
              Sign In
            </button>
          </div>

          {/* Trust strip */}
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-white/60 text-sm">
            {[
              '✅ Instant confirmation',
              '🔐 Unique access codes',
              '📱 Mobile-friendly',
              '💳 Secure Stripe payments',
            ].map(s => <span key={s}>{s}</span>)}
          </div>
        </div>
      </section>

      {/* ── LANES ─────────────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-20 bg-gray-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">5 Lanes Available</h2>
            <p className="mt-2 text-gray-500 text-base sm:text-lg">
              Bowling machines and full run-up nets — something for every player
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {lanes.map(lane => (
              <div
                key={lane.id}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 hover:shadow-md hover:-translate-y-0.5 transition-all"
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0 ${
                    lane.type === 'machine' ? 'bg-blue-50' : 'bg-emerald-50'
                  }`}>
                    {lane.icon}
                  </div>
                  <div>
                    <div className="font-bold text-gray-800 text-sm leading-snug">{lane.name}</div>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full inline-block mt-0.5 ${
                      lane.type === 'machine'
                        ? 'bg-blue-100 text-blue-600'
                        : 'bg-emerald-100 text-emerald-600'
                    }`}>
                      {lane.type === 'machine' ? 'Bowling Machine' : '9m Run Up'}
                    </span>
                  </div>
                </div>

                <p className="text-sm text-gray-500 leading-relaxed">{lane.desc}</p>

                {lane.variants && (
                  <div className="mt-3 flex gap-2">
                    <span className="text-[11px] px-2.5 py-1 bg-gray-100 rounded-lg text-gray-600 font-medium">Standard</span>
                    <span className="text-[11px] px-2.5 py-1 bg-amber-100 rounded-lg text-amber-700 font-medium">⭐ Truman</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ───────────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-20 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">Straightforward Pricing</h2>
            <p className="mt-2 text-gray-500 text-base sm:text-lg">
              No memberships, no lock-ins — just pay for what you book
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-5">
            {/* Standard lane */}
            <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-6 text-center">
              <div className="text-3xl mb-3">🎯</div>
              <div className="font-bold text-gray-800 mb-0.5">Standard Lane</div>
              <div className="text-[11px] text-gray-500 mb-4">BM 1, BM 2, BM 3 Std, RU 1, RU 2</div>
              <div className="text-4xl font-extrabold text-emerald-600">
                {settings ? `$${settings.customerPricePerHour}` : <span className="text-2xl text-gray-300">—</span>}
              </div>
              <div className="text-sm text-gray-500 mt-0.5">per hour</div>
              {(settings as any)?.customerPrice90Min != null && (
                <div className="mt-2 text-sm font-semibold text-emerald-600">${(settings as any).customerPrice90Min} / 90 min</div>
              )}
            </div>

            {/* Truman */}
            <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-6 text-center relative">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-amber-400 text-white text-[10px] font-bold rounded-full uppercase tracking-wide whitespace-nowrap shadow-sm">
                Premium
              </div>
              <div className="text-3xl mb-3">⭐</div>
              <div className="font-bold text-gray-800 mb-0.5">Truman Machine</div>
              <div className="text-[11px] text-gray-500 mb-4">BM 3 — Truman configuration</div>
              <div className="text-4xl font-extrabold text-amber-600">
                {settings ? `$${settings.trumanPricePerHour}` : <span className="text-2xl text-gray-300">—</span>}
              </div>
              <div className="text-sm text-gray-500 mt-0.5">per hour</div>
              {(settings as any)?.trumanPrice90Min != null && (
                <div className="mt-2 text-sm font-semibold text-amber-600">${(settings as any).trumanPrice90Min} / 90 min</div>
              )}
            </div>

            {/* Opening hours */}
            <div className="rounded-2xl border-2 border-blue-200 bg-blue-50 p-6 text-center sm:col-span-1">
              <div className="text-3xl mb-3">🕐</div>
              <div className="font-bold text-gray-800 mb-0.5">Opening Hours</div>
              <div className="text-[11px] text-gray-500 mb-4">7 days a week</div>
              <div className="text-2xl sm:text-3xl font-extrabold text-blue-600">
                {settings?.openingHour != null && settings?.closingHour != null
                  ? `${fmtH(settings.openingHour)} – ${fmtH(settings.closingHour)}`
                  : <span className="text-2xl text-gray-300">—</span>
                }
              </div>
              <div className="text-sm text-gray-500 mt-1">Daily</div>
            </div>

            {/* Location */}
            <div className="rounded-2xl border-2 border-purple-200 bg-purple-50 p-6 text-center sm:col-span-1">
              <div className="text-3xl mb-3">📍</div>
              <div className="font-bold text-gray-800 mb-0.5">Location</div>
              <div className="text-[11px] text-gray-500 mb-4">Stirling, Perth WA</div>
              <div className="text-sm font-semibold text-purple-700 leading-snug">
                78 Jones Street<br />Stirling WA 6021
              </div>
              <div className="text-xs text-gray-500 mt-2">Free on-site parking</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-20 bg-gray-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">How It Works</h2>
            <p className="mt-2 text-gray-500 text-base sm:text-lg">
              From sign-up to net session in four easy steps
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 sm:gap-8">
            {steps.map((s, i) => (
              <div key={s.n} className="text-center relative">
                {/* Connector line — desktop only */}
                {i < steps.length - 1 && (
                  <div className="hidden lg:block absolute top-7 left-[calc(50%+28px)] right-0 h-px bg-emerald-200 -z-0" />
                )}
                <div className="relative mx-auto w-14 h-14 rounded-2xl bg-white border-2 border-emerald-200 shadow-sm flex items-center justify-center text-2xl mb-4 z-10">
                  {s.icon}
                  <div className="absolute -top-2.5 -right-2.5 w-6 h-6 bg-emerald-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center shadow">
                    {s.n}
                  </div>
                </div>
                <h3 className="font-bold text-gray-800 text-sm sm:text-base mb-1 leading-snug">{s.title}</h3>
                <p className="text-xs sm:text-sm text-gray-500 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHAT TO BRING ─────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-20 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">What to Bring</h2>
            <p className="mt-2 text-gray-500 text-base sm:text-lg">
              Everything you need for your training session
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 max-w-3xl mx-auto">
            {[
              { icon: '👟', title: 'Cricket Shoes', desc: 'Trainers or cricket shoes with grip' },
              { icon: '🏏', title: 'Your Gear', desc: 'Bat, pads, gloves — or hire on-site' },
              { icon: '💧', title: 'Water', desc: 'Stay hydrated during your session' },
              { icon: '👕', title: 'Comfy Clothes', desc: 'Anything you can move freely in' },
            ].map((item) => (
              <div key={item.title} className="rounded-2xl border border-gray-100 bg-gray-50 p-5 text-center">
                <div className="text-4xl mb-3">{item.icon}</div>
                <div className="font-semibold text-gray-800 text-sm mb-1">{item.title}</div>
                <div className="text-xs text-gray-500 leading-relaxed">{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── BOTTOM CTA ────────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-20 bg-gradient-to-br from-emerald-600 to-green-700">
        <div className="max-w-2xl mx-auto px-4 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">Ready to Book?</h2>
          <p className="text-white/75 text-lg mb-8">
            Create your free account and get your first session booked today.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onSignUp}
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-white text-emerald-700 font-bold text-base shadow-lg hover:bg-emerald-50 transition-all active:scale-95"
            >
              Get Started — Free
            </button>
            <button
              onClick={onSignIn}
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-transparent text-white font-semibold text-base border border-white/40 hover:bg-white/10 transition-all active:scale-95"
            >
              Already have an account?
            </button>
          </div>
        </div>
      </section>

    </div>
  )
}
