import { useState, useEffect } from 'react'
import { createRootRoute, Outlet, Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuth } from '../hooks/useAuth'
import { trackPageView, setTrackerUserId } from '../lib/tracker'
import { signOutUser } from '../lib/auth-client'
import AuthModal from '../components/AuthModal'
import PostcodeRequiredModal from '../components/PostcodeRequiredModal'
import EmailVerificationGate from '../components/EmailVerificationGate'
import PwaUpdater from '../components/PwaUpdater'
import InstallPrompt, { openInstallHelp } from '../components/InstallPrompt'
import AnnouncementHost from '../components/AnnouncementHost'
import PushReminderBanners from '../components/PushReminderBanners'
import { useImpersonation } from '../hooks/useImpersonation'
import { useLaneConfig } from '../hooks/useLaneConfig'

function RootComponent() {
  const { user, isAuthenticated, profileReady, isAdmin, isCoach, isLoading } = useAuth()
  const { impersonatedUser, isImpersonating, exitImpersonation } = useImpersonation()
  // SPEC_RECONFIGURABLE_LANES: hydrate the lane-config store once for the whole app.
  useLaneConfig()
  const navigate = useNavigate()
  const [showAuth, setShowAuth] = useState(false)
  // SPEC_SIGNUP_UPDATES_2026-06 G1 — which mode the AuthModal opens in, set by the
  // two explicit logged-out header buttons (Log In to Book / Sign Up).
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup')
  const [showUserMenu, setShowUserMenu] = useState(false)

  const openAuth = (mode: 'signin' | 'signup') => { setAuthMode(mode); setShowAuth(true) }

  // SPEC_ANALYTICS_BUILD_2026-06 — attribute analytics to the signed-in user and
  // log a pageview on every client route change (the first pageview is emitted by
  // initTracker in main.tsx). pathname is read from the router so SPA navigations
  // are captured, not just hard loads.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => { setTrackerUserId(user?.id ?? null) }, [user?.id])
  useEffect(() => { trackPageView() }, [pathname])

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* paddingTop = iOS safe-area inset so the header content clears the status
          bar in the installed PWA (0 in a normal browser tab). The raw inset
          conservatively clears the centered Dynamic Island/notch for full-width
          content; the logo/buttons sit at the left/right edges (beside the island),
          so we tighten by ~10px to sit just below the status-bar signal/clock and
          not waste a tall empty bar. The white/blur bg still fills behind the bar. */}
      <header
        className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-gray-200"
        style={{ paddingTop: 'max(0px, calc(env(safe-area-inset-top) - 0.625rem))' }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-3 group">
              <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-green-600 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <span className="text-white text-lg">🏏</span>
              </div>
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-red-600 to-red-500 bg-clip-text text-transparent leading-tight">
                  Cricket Revolution
                </h1>
                <p className="text-[10px] font-medium text-gray-500 -mt-0.5 tracking-wider uppercase">Training Nets</p>
              </div>
            </Link>

            <div className="flex items-center gap-3">
              {isLoading ? (
                <div className="w-20 h-8 bg-gray-100 rounded-xl animate-pulse" />
              ) : isAuthenticated && user ? (
                <>
                {/* Book a Net — primary CTA, only for logged-in users (G1) */}
                <Link
                  to="/"
                  className="flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 active:scale-95 text-white font-semibold rounded-xl shadow-md shadow-emerald-500/25 transition-all text-sm whitespace-nowrap"
                >
                  <span className="text-base leading-none">🏏</span>
                  <span>Book a Net</span>
                </Link>
                {/* Facility access quick-link — customers only (coaches/admins know the
                    site). Icon-only on mobile to keep the header from wrapping. */}
                {!isAdmin && !isCoach && (
                  <Link
                    to="/facility"
                    title="How to find us"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl bg-amber-50 border border-amber-200 hover:bg-amber-100 active:scale-95 transition-all text-amber-700 whitespace-nowrap"
                  >
                    <span className="text-base leading-none">📍</span>
                    <span className="text-sm font-medium hidden sm:inline">Facility</span>
                  </Link>
                )}
                <div className="relative">
                  <button
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 transition-all"
                  >
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold bg-emerald-500">
                      {user.name.trim().split(/\s+/).map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('')}
                    </div>
                    <span className="text-sm font-medium text-gray-700 hidden sm:inline">{user.name.split(' ')[0]}</span>
                    {isAdmin && <span className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-bold uppercase">Admin</span>}
                    {isCoach && !isAdmin && <span className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600 font-bold uppercase">Coach</span>}
                  </button>
                  {showUserMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                      <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-gray-200 shadow-xl z-50 overflow-hidden">
                        <div className="p-3 border-b border-gray-100">
                          <div className="text-sm font-semibold text-gray-800">{user.name}</div>
                          <div className="text-xs text-gray-500">{user.email}</div>
                        </div>
                        <div className="p-1">
                          {isAdmin && (
                            <Link to="/rev-ops-7k2p" onClick={() => setShowUserMenu(false)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
                              <span>⚙️</span> Admin Panel
                            </Link>
                          )}
                          {(isCoach || isAdmin) && (
                            <Link to="/statements" onClick={() => setShowUserMenu(false)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
                              <span>📊</span> Statements
                            </Link>
                          )}
                          <Link to="/profile" onClick={() => setShowUserMenu(false)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
                            <span>👤</span> My Profile
                          </Link>
                          <Link to="/bookings" onClick={() => setShowUserMenu(false)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
                            <span>📅</span> My Bookings
                          </Link>
                          {/* Bug 8: hide Payments & Credit from coaches (and an admin
                              impersonating a coach) — coaches use Statements. */}
                          {!((isCoach && !isAdmin) || (isImpersonating && impersonatedUser?.role === 'coach')) && (
                            <Link to="/payments" onClick={() => setShowUserMenu(false)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
                              <span>💳</span> Payments &amp; Credit
                            </Link>
                          )}
                          <button onClick={() => { setShowUserMenu(false); openInstallHelp() }} className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
                            <span>📲</span> Install app
                          </button>
                          <div className="my-1 border-t border-gray-100" />
                          <button onClick={async () => { await signOutUser(); setShowUserMenu(false) }} className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg">
                            <span>🚪</span> Sign Out
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                </>
              ) : (
                <>
                  {/* G1 — explicit, equal-weight logged-out entry points */}
                  <button
                    onClick={() => openAuth('signin')}
                    className="text-sm font-semibold px-3 py-1.5 sm:px-4 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl shadow-md transition-all whitespace-nowrap"
                  >
                    <span className="sm:hidden">Log In</span>
                    <span className="hidden sm:inline">Log In to Book</span>
                  </button>
                  <button
                    onClick={() => openAuth('signup')}
                    className="text-sm font-semibold px-3 py-1.5 sm:px-4 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl shadow-md transition-all whitespace-nowrap"
                  >
                    Sign Up
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Install-app / push reminder banners (red). Browser → permanent install nag;
          installed PWA → dismissable push-test helper. Authenticated users, all pages. */}
      <PushReminderBanners />

      {/* SPEC_INAPP_BANNERS — admin-managed in-app banner strip + pop-up modal.
          Self-gates on auth resolving (no flash); renders nothing when there's
          nothing to show. */}
      <AnnouncementHost />

      {/* Impersonation banner */}
      {isImpersonating && impersonatedUser && (
        <div
          className="sticky z-40 bg-amber-500 text-white text-sm font-medium px-4 py-2 flex items-center justify-between gap-4 shadow-md"
          style={{ top: 'calc(4rem + max(0px, calc(env(safe-area-inset-top) - 0.625rem)))' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base leading-none shrink-0">👁️</span>
            <span className="truncate">
              Viewing as <strong>{impersonatedUser.name}</strong>
              <span className="hidden sm:inline"> ({impersonatedUser.email})</span>
              {impersonatedUser.role === 'coach' && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-white/20 font-bold uppercase tracking-wide">Coach</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => navigate({ to: '/rev-ops-7k2p', search: { section: impersonatedUser.role === 'coach' ? 'coaches' : 'customers' } })}
              className="text-amber-100 hover:text-white text-xs underline underline-offset-2"
            >
              Back to admin
            </button>
            <button
              onClick={() => { exitImpersonation(); navigate({ to: '/rev-ops-7k2p', search: { section: impersonatedUser.role === 'coach' ? 'coaches' : 'customers' } }) }}
              className="px-3 py-1 bg-white text-amber-700 rounded-lg text-xs font-bold hover:bg-amber-50 transition-colors"
            >
              Exit
            </button>
          </div>
        </div>
      )}

      <main>
        <Outlet />
      </main>

      <footer className="bg-white border-t border-gray-200 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-lg">🏏</span>
              <span className="font-semibold text-red-600">Cricket Revolution Training Nets</span>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => openInstallHelp()} className="text-sm text-gray-500 hover:text-gray-700 underline underline-offset-2">
                Install app
              </button>
              <p className="text-sm text-gray-500">&copy; {new Date().getFullYear()} Cricket Revolution Training Nets.</p>
            </div>
          </div>
        </div>
      </footer>

      {/* PWA: SW update toast + install/enable nudge (SPEC_PWA_PUSH_NOTIFICATIONS) */}
      <PwaUpdater />
      <InstallPrompt />

      {showAuth && <AuthModal initialMode={authMode} onClose={() => setShowAuth(false)} onSuccess={() => setShowAuth(false)} />}

      {/* SIGNUP-VERIFY-LOCKDOWN — non-dismissable gate: a signed-in CUSTOMER (not admin,
          not coach, not while impersonating) must verify their email before proceeding.
          Coaches are EXEMPT — they're known/trusted migrated accounts, so verification is
          needless onboarding friction (booking itself no longer requires it — see
          SIGNUP-NO-LOCKDOWN in createBooking). Takes precedence over the postcode gate;
          auto-unmounts when emailVerified flips. */}
      {isAuthenticated && user && profileReady && user.role !== 'admin' && user.role !== 'coach' && !isImpersonating &&
        user.emailVerified === false && (
          <EmailVerificationGate email={user.email} />
        )}

      {/* SPEC_PROFILE_POSTCODE_SUBURB — hard-block gate: signed-in CUSTOMERS (not admin,
          not coach, not while impersonating) must supply postcode + suburb before using
          the app. Coaches are EXEMPT — postcode is only used for customer/athlete
          catchment analytics, so it's needless friction onboarding coaches. Only after
          email is verified (the verify gate above shows first). */}
      {isAuthenticated && user && profileReady && user.role !== 'admin' && user.role !== 'coach' && !isImpersonating &&
        user.emailVerified !== false && (!user.postcode || !user.suburb) && (
          <PostcodeRequiredModal email={user.email} />
        )}
    </div>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
})
