import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { getErrorMessage } from '../lib/errors'
import { useImpersonation } from '../hooks/useImpersonation'

/**
 * "My Mates" — collapsible profile section (SPEC_ADD_A_MATE) listing the saved
 * mates the account has added to bookings before, ordered by shared-session
 * count. Click-to-delete removes a saved mate (does not affect existing
 * bookings). Collapsed by default.
 */
export default function MyMatesCard() {
  // ADMIN "view as user" — target the VIEWED account's mates when impersonating.
  const { impersonatedUser, isImpersonating } = useImpersonation()
  const acctId =
    isImpersonating && impersonatedUser ? (impersonatedUser.id as Id<'customers'>) : undefined
  const savedMates = useQuery(api.mates.listSavedMates, { forAccountId: acctId }) ?? []
  const removeSaved = useMutation(api.mates.removeSavedMate)
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const handleRemove = async (mateCustomerId: string, name: string) => {
    if (!confirm(`Remove ${name} from your saved mates?`)) return
    setBusyId(mateCustomerId)
    try {
      await removeSaved({ mateCustomerId: mateCustomerId as Id<'customers'>, forAccountId: acctId })
    } catch (err: any) {
      alert(getErrorMessage(err) ?? 'Failed to remove mate')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-6 py-4 border-b border-gray-100 flex items-center justify-between text-left"
      >
        <div>
          <h3 className="text-lg font-bold text-gray-800">My Mates</h3>
          <p className="text-sm text-gray-500 mt-0.5">Friends you've added to bookings ({savedMates.length})</p>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="p-6">
          {savedMates.length === 0 ? (
            <p className="text-sm text-gray-400">No saved mates yet. Add someone to a booking and they'll appear here.</p>
          ) : (
            <div className="space-y-2">
              {savedMates.map((m: any) => (
                <div key={m.customerId} className="flex items-center justify-between rounded-xl border border-gray-100 px-4 py-2.5">
                  <span className="text-sm text-gray-800">
                    {m.displayName} {m.sharedCount > 0 && <span className="text-gray-400">(x{m.sharedCount})</span>}
                  </span>
                  <button
                    onClick={() => handleRemove(m.customerId, m.displayName)}
                    disabled={busyId === m.customerId}
                    className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
