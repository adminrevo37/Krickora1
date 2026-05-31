import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useAuth } from '../hooks/useAuth'

export const Route = createFileRoute('/join')({
  component: JoinPage,
  validateSearch: (search: Record<string, unknown>) => ({
    token: (search.token as string | undefined) ?? '',
  }),
})

/**
 * /join?token=XXX (SPEC_ADD_A_MATE SMS invite landing). An unregistered mate
 * taps the SMS link. If signed in → consume the invite + add them to the booking.
 * If not signed in → prompt to sign in / register, then they return here.
 * Dead tokens (cancelled / removed / expired / already-started) still convert
 * the visitor to an account — they're just routed onward, not added.
 */
function JoinPage() {
  const { token } = Route.useSearch()
  const navigate = useNavigate()
  const { user, isAuthenticated, isLoading } = useAuth()

  const invite = useQuery(api.mates.getBookingInvite, token ? { token } : 'skip')
  const acceptInvite = useMutation(api.mates.acceptBookingInvite)

  const [accepting, setAccepting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const handleAccept = async () => {
    setAccepting(true)
    try {
      const res = await acceptInvite({ token })
      setResult(res.status)
      if (res.status === 'joined') {
        setTimeout(() => navigate({ to: '/bookings' }), 1500)
      }
    } catch {
      setResult('error')
    } finally {
      setAccepting(false)
    }
  }

  if (!token) {
    return <Centered emoji="🔗" title="Invalid invite link" />
  }

  if (invite === undefined || isLoading) {
    return <Centered emoji="⏳" title="Loading invite…" />
  }

  // Dead token → still send them to sign-up so they get an account.
  if (invite.status === 'invalid' || invite.status === 'expired' || invite.status === 'joined') {
    const msg =
      invite.status === 'expired'
        ? 'This invite has expired.'
        : invite.status === 'joined'
          ? 'This invite has already been used.'
          : 'This invite is no longer valid.'
    return (
      <Centered emoji="🏏" title={msg} subtitle="Create a free account to book your own nets at Cricket Revolution.">
        <button onClick={() => navigate({ to: '/' })} className="mt-4 px-5 py-2 bg-emerald-600 text-white rounded-xl font-medium">
          Sign up
        </button>
      </Centered>
    )
  }

  // Valid pending invite.
  if (!isAuthenticated || !user) {
    return (
      <Centered
        emoji="👥"
        title={`${invite.ownerName} invited you to a Cricket Revolution booking`}
        subtitle={`${invite.laneName} · ${invite.date} · ${invite.timeSlot}. Sign in or create an account to join and get the door code.`}
      >
        <button onClick={() => navigate({ to: '/' })} className="mt-4 px-5 py-2 bg-emerald-600 text-white rounded-xl font-medium">
          Sign in / Sign up
        </button>
        <p className="text-xs text-gray-400 mt-2">After signing in, return to this link to join.</p>
      </Centered>
    )
  }

  if (result) {
    const map: Record<string, { emoji: string; title: string; sub?: string }> = {
      joined: { emoji: '✅', title: "You're on the booking!", sub: 'Redirecting to your bookings…' },
      already_mate: { emoji: '👍', title: "You're already on this booking." },
      own_booking: { emoji: '👍', title: "That's your own booking." },
      full: { emoji: '⚠️', title: 'This booking is already full.' },
      expired: { emoji: '⌛', title: 'This invite has expired.' },
      invalid: { emoji: '🔗', title: 'This invite is no longer valid.' },
      error: { emoji: '⚠️', title: 'Something went wrong. Please try again.' },
    }
    const r = map[result] ?? map.error
    return (
      <Centered emoji={r.emoji} title={r.title} subtitle={r.sub}>
        <button onClick={() => navigate({ to: '/bookings' })} className="mt-4 px-5 py-2 bg-emerald-600 text-white rounded-xl font-medium">
          View My Bookings
        </button>
      </Centered>
    )
  }

  return (
    <Centered
      emoji="👥"
      title={`Join ${invite.ownerName}'s booking`}
      subtitle={`${invite.laneName} · ${invite.date} · ${invite.timeSlot} · ${invite.duration}`}
    >
      <button
        onClick={handleAccept}
        disabled={accepting}
        className="mt-4 px-6 py-2.5 bg-emerald-600 text-white rounded-xl font-medium hover:bg-emerald-700 disabled:opacity-50"
      >
        {accepting ? 'Joining…' : 'Join this booking'}
      </button>
    </Centered>
  )
}

function Centered({ emoji, title, subtitle, children }: { emoji: string; title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-center">
      <div className="text-5xl mb-4">{emoji}</div>
      <h1 className="text-2xl font-bold text-gray-800 mb-2">{title}</h1>
      {subtitle && <p className="text-gray-500">{subtitle}</p>}
      {children}
    </div>
  )
}
