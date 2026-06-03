import { useState, useEffect } from 'react'
import { useSettings } from '../hooks/useSettings'
import { DAY_KEYS, DAY_LABELS, type DayKey } from '../lib/settings-store'
import RegistrationLockCard from './RegistrationLockCard'

// ── NumberInput: buffers keystrokes locally, saves to Convex only on blur (IMPR-1) ──
function NumberInput({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
}) {
  const [local, setLocal] = useState(String(value))

  // Sync when the prop changes (e.g. another tab updated settings)
  useEffect(() => { setLocal(String(value)) }, [value])

  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <input
        type="number"
        value={local}
        step={step}
        min={min}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const num = Number(local)
          if (!isNaN(num) && num !== value) onChange(num)
        }}
        className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
      />
    </label>
  )
}

// ── ToggleRow: boolean setting with label + description ──
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer">
      <span>
        <span className="text-sm font-medium text-gray-800">{label}</span>
        {description && <span className="block text-xs text-gray-500 mt-0.5">{description}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 shrink-0"
      />
    </label>
  )
}

export default function SettingsPanel() {
  const { settings, updateSettings, updateDayHours, resetSettings, isAdmin } = useSettings()

  if (!isAdmin) return null

  return (
    <div className="space-y-6">
      <RegistrationLockCard />

      {/* Opening Hours */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-800">🕒 Opening Hours</h3>
            <p className="text-sm text-gray-500 mt-0.5">Set daily opening and closing hours</p>
          </div>
        </div>
        <div className="divide-y divide-gray-100">
          {DAY_KEYS.map((day: DayKey) => {
            const h = settings.dailyHours[day]
            return (
              <div key={day} className="px-6 py-3 flex flex-wrap items-center gap-4">
                <div className="w-28 font-medium text-gray-800">{DAY_LABELS[day]}</div>
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={h.closed}
                    onChange={(e) => updateDayHours(day, { closed: e.target.checked })}
                  />
                  Closed
                </label>
                {!h.closed && (
                  <>
                    <label className="text-sm text-gray-600 flex items-center gap-2">
                      Open
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={h.open}
                        onChange={(e) => updateDayHours(day, { open: Number(e.target.value) })}
                        className="w-20 px-2 py-1 border border-gray-200 rounded-lg text-sm"
                      />
                    </label>
                    <label className="text-sm text-gray-600 flex items-center gap-2">
                      Close
                      <input
                        type="number"
                        min={1}
                        max={24}
                        value={h.close}
                        onChange={(e) => updateDayHours(day, { close: Number(e.target.value) })}
                        className="w-20 px-2 py-1 border border-gray-200 rounded-lg text-sm"
                      />
                    </label>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Pricing */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">💲 Pricing</h3>
          <p className="text-sm text-gray-500 mt-0.5">Customer and coach session rates</p>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <NumberInput label="Customer / hour ($)" value={settings.customerPricePerHour} onChange={(v) => updateSettings({ customerPricePerHour: v })} />
          <NumberInput label="Truman / hour ($)" value={settings.trumanPricePerHour} onChange={(v) => updateSettings({ trumanPricePerHour: v })} />
          <NumberInput label="Coach / hour ($)" value={settings.coachPerHour} onChange={(v) => updateSettings({ coachPerHour: v })} />
          <NumberInput label="Coach / 30 min ($)" value={settings.coachPer30Min ?? 15} onChange={(v) => updateSettings({ coachPer30Min: v })} />
        </div>
      </div>

      {/* Booking Rules */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">📋 Booking Rules</h3>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <NumberInput label="Cancellation notice (hours)" value={settings.cancellationHoursBefore} onChange={(v) => updateSettings({ cancellationHoursBefore: v })} />
          <NumberInput label="Min booking notice (minutes)" value={settings.minBookingNoticeMinutes} onChange={(v) => updateSettings({ minBookingNoticeMinutes: v })} />
          <NumberInput label="Max lanes per booking (customer)" value={settings.customerMaxLanesPerBooking ?? 3} onChange={(v) => updateSettings({ customerMaxLanesPerBooking: v })} />
          <NumberInput label="Coach booking window (days)" value={settings.coachBookingWindowDays} onChange={(v) => updateSettings({ coachBookingWindowDays: v })} />
          <NumberInput label="Customer open hour" value={settings.customerOpenHour} onChange={(v) => updateSettings({ customerOpenHour: v })} />
          <NumberInput label="Show release countdown within (hours)" value={settings.releaseCountdownHours ?? 24} onChange={(v) => updateSettings({ releaseCountdownHours: v })} />
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Customer open day</span>
            <select
              value={settings.customerOpenDay}
              onChange={(e) => updateSettings({ customerOpenDay: e.target.value })}
              className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
            >
              {DAY_KEYS.map(d => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* Coach Booking Rules */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">🏏 Coach Booking Rules</h3>
          <p className="text-sm text-gray-500 mt-0.5">Control when each coach tier can start booking sessions</p>
        </div>
        <div className="p-6 space-y-6">
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-3">L1 Coaches</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Open day</span>
                <select
                  value={settings.l1CoachOpenDay}
                  onChange={(e) => updateSettings({ l1CoachOpenDay: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                >
                  <option value="always">Always open</option>
                  {DAY_KEYS.map(d => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
                </select>
              </label>
              <NumberInput label="Open hour" value={settings.l1CoachOpenHour} onChange={(v) => updateSettings({ l1CoachOpenHour: v })} />
            </div>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-3">L2 Coaches</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Open day</span>
                <select
                  value={settings.l2CoachOpenDay}
                  onChange={(e) => updateSettings({ l2CoachOpenDay: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white"
                >
                  <option value="always">Always open</option>
                  {DAY_KEYS.map(d => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
                </select>
              </label>
              <NumberInput label="Open hour" value={settings.l2CoachOpenHour} onChange={(v) => updateSettings({ l2CoachOpenHour: v })} />
            </div>
          </div>
        </div>
      </div>

      {/* Cancellation & Time Locks */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">🔒 Cancellation & Time Locks</h3>
          <p className="text-sm text-gray-500 mt-0.5">Windows that lock changes/cancellations before a session starts</p>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <NumberInput label="Customer cancellation cutoff (hours)" value={settings.customerCancellationHours ?? 2} onChange={(v) => updateSettings({ customerCancellationHours: v })} />
          <NumberInput label="Coach late-cancel charge window (hours)" value={settings.coachLateCancellationHours ?? 24} onChange={(v) => updateSettings({ coachLateCancellationHours: v })} />
          <NumberInput label="Coach reschedule freeze (hours)" value={settings.coachRescheduleFreezeHours ?? 24} onChange={(v) => updateSettings({ coachRescheduleFreezeHours: v })} />
          <NumberInput label="Extension notice (minutes before start)" value={settings.extensionNoticeMinutes ?? 20} onChange={(v) => updateSettings({ extensionNoticeMinutes: v })} />
          <NumberInput label="Modify: max move-earlier inside cutoff (hours)" value={settings.modifyMoveEarlierMaxHours ?? 1} onChange={(v) => updateSettings({ modifyMoveEarlierMaxHours: v })} />
        </div>
      </div>

      {/* Session Durations */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">⏱️ Session Durations</h3>
          <p className="text-sm text-gray-500 mt-0.5">Maximum and minimum bookable durations</p>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <NumberInput label="Customer max duration (minutes)" value={settings.customerMaxDurationMinutes ?? 180} step={30} onChange={(v) => updateSettings({ customerMaxDurationMinutes: v })} />
          <NumberInput label="Coach max duration (minutes)" value={settings.coachMaxDurationMinutes ?? 600} step={30} onChange={(v) => updateSettings({ coachMaxDurationMinutes: v })} />
          <NumberInput label="Min athlete slot (minutes)" value={settings.minAthleteDurationMinutes ?? 15} step={5} onChange={(v) => updateSettings({ minAthleteDurationMinutes: v })} />
        </div>
      </div>

      {/* Payments & Holds */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">💳 Payments & Holds</h3>
          <p className="text-sm text-gray-500 mt-0.5">How long an unpaid checkout holds its slot, and how long a freed slot is reserved for the next waitlisted member</p>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <NumberInput label="Abandoned checkout release (minutes)" value={settings.abandonedCheckoutMinutes ?? 10} onChange={(v) => updateSettings({ abandonedCheckoutMinutes: v })} />
          <NumberInput label="Waitlist offer hold (minutes)" value={settings.waitlistOfferHoldMinutes ?? 15} onChange={(v) => updateSettings({ waitlistOfferHoldMinutes: v })} />
        </div>
      </div>

      {/* Misc (SPEC_ADD_A_MATE) */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">⚙️ Misc Settings</h3>
          <p className="text-sm text-gray-500 mt-0.5">Add-a-Mate and other miscellaneous limits</p>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <NumberInput label="Max mates per booking" value={settings.maxMatesPerBooking ?? 3} onChange={(v) => updateSettings({ maxMatesPerBooking: v })} />
        </div>
      </div>

      {/* Admin Security Gate */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">🛡️ Admin Security Gate</h3>
          <p className="text-sm text-gray-500 mt-0.5">Require admins to re-enter their own password before destructive actions</p>
        </div>
        <div className="p-6 space-y-4">
          <ToggleRow
            label="Require password unlock for admin actions"
            description="When on, destructive admin writes prompt for your account password. The /admin prompt is deployed — safe to enable."
            checked={settings.adminGateEnabled ?? false}
            onChange={(v) => updateSettings({ adminGateEnabled: v })}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <NumberInput label="Unlock duration (minutes)" value={settings.adminUnlockMinutes ?? 45} onChange={(v) => updateSettings({ adminUnlockMinutes: v })} />
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => { if (confirm('Reset all settings to defaults?')) resetSettings() }}
          className="px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg"
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  )
}
