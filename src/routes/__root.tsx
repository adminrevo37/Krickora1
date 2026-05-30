import { useState } from 'react'
import { createRootRoute, Outlet, Link, useNavigate } from '@tanstack/react-router'
import { useAuth } from '../hooks/useAuth'
import { signOutUser } from '../lib/auth-client'
import AuthModal from '../components/AuthModal'
import { useImpersonation } from '../hooks/useImpersonation'

function RootComponent() {
  const { user, isAuthenticated, isAdmin, isCoach, isLoading } = useAuth()
  const { impersonatedUser, isImpersonating, exitImpersonation } = useImpersonation()
  const navigate = useNavigate()
  const [showAuth, setShowAuth] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-3 group">
              <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-green-600 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <span className="text-white text-lg">🏏</span>
              </div>
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-emerald-600 to-green-600 bg-clip-text text-transparent leading-tight">
                  Revolution Sports
                </h1>
                <p className="text-[10px] font-medium text-gray-500 -mt-0.5 tracking-wider uppercase">Training Nets</p>
              </div>
            </Link>

            <div className="flex items-center gap-3">
              {/* Book a Net — primary CTA, always visible */}
              <Link
                to="/"
                className="flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 active:scale-95 text-white font-semibold rounded-xl shadow-md shadow-emerald-500/25 transition-all text-sm whitespace-nowrap"
              >
                <span className="text-base leading-none">🏏</span>
                <span>Book a Net</span>
              </Link>

              {isLoading ? (
                <div className="w-20 h-8 bg-gray-100 rounded-xl animate-pulse" />
              ) : isAuthenticated && user ? (
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
                            <Link to="/admin" onClick={() => setShowUserMenu(false)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
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
                          <Link to="/payments" onClick={() => setShowUserMenu(false)} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
                            <span>💳</span> Payments &amp; Credit
                          </Link>
                          <div className="my-1 border-t border-gray-100" />
                          <button onClick={async () => { await signOutUser(); setShowUserMenu(false) }} className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg">
                            <span>🚪</span> Sign Out
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <button onClick={() => setShowAuth(true)} className="text-sm font-medium px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl shadow-md transition-all">
                  Sign In
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Impersonation banner */}
      {isImpersonating && impersonatedUser && (
        <div className="sticky top-16 z-40 bg-amber-500 text-white text-sm font-medium px-4 py-2 flex items-center justify-between gap-4 shadow-md">
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
              onClick={() => navigate({ to: '/admin', search: { section: impersonatedUser.role === 'coach' ? 'coaches' : 'customers' } })}
              className="text-amber-100 hover:text-white text-xs underline underline-offset-2"
            >
              Back to admin
            </button>
            <button
              onClick={() => { exitImpersonation(); navigate({ to: '/admin', search: { section: impersonatedUser.role === 'coach' ? 'coaches' : 'customers' } }) }}
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
              <span className="font-semibold text-gray-700">Revolution Sports Training Nets</span>
            </div>
            <p className="text-sm text-gray-500">&copy; {new Date().getFullYear()} Revolution Sports Training Nets.</p>
          </div>
        </div>
      </footer>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={() => setShowAuth(false)} />}
    </div>
  )
}

export const Route = createRootRoute({
  component: RootComponent,
})
