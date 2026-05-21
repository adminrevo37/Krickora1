import { useSettings } from '../hooks/useSettings'
import { DAY_KEYS, DAY_LABELS, type DayKey } from '../lib/settings-store'
import RegistrationLockCard from './RegistrationLockCard'

export default function SettingsPanel() {
  const { settings, updateSettings, updateDayHours, resetSettings, isAdmin } = useSettings()

  if (!isAdmin) return null

  const numberInput = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    step = 1,
    min = 0,
  ) => (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
      />
    </label>
  )

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
          {numberInput('Customer / hour ($)', settings.customerPricePerHour, (v) => updateSettings({ customerPricePerHour: v }))}
          {numberInput('Truman / hour ($)', settings.trumanPricePerHour, (v) => updateSettings({ trumanPricePerHour: v }))}
          {numberInput('Coach / hour ($)', settings.coachPerHour, (v) => updateSettings({ coachPerHour: v }))}
          {numberInput('Coach / 30 min ($)', settings.coachPer30Min, (v) => updateSettings({ coachPer30Min: v }))}
        </div>
      </div>

      {/* Booking Rules */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">📋 Booking Rules</h3>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {numberInput('Cancellation notice (hours)', settings.cancellationHoursBefore, (v) => updateSettings({ cancellationHoursBefore: v }))}
          {numberInput('Min booking notice (minutes)', settings.minBookingNoticeMinutes, (v) => updateSettings({ minBookingNoticeMinutes: v }))}
          {numberInput('Coach booking window (days)', settings.coachBookingWindowDays, (v) => updateSettings({ coachBookingWindowDays: v }))}
          {numberInput('Customer open hour', settings.customerOpenHour, (v) => updateSettings({ customerOpenHour: v }))}
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
              {numberInput('Open hour', settings.l1CoachOpenHour, (v) => updateSettings({ l1CoachOpenHour: v }))}
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
              {numberInput('Open hour', settings.l2CoachOpenHour, (v) => updateSettings({ l2CoachOpenHour: v }))}
            </div>
          </div>
        </div>
      </div>

      {/* Advanced Booking Rules */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-800">🔧 Advanced Booking Rules</h3>
          <p className="text-sm text-gray-500 mt-0.5">Fine-tune duration limits, notice windows, and athlete session minimums</p>
        </div>
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {numberInput('Customer max duration (min)', settings.customerMaxDurationMinutes, (v) => updateSettings({ customerMaxDurationMinutes: v }), 30, 30)}
          {numberInput('Coach max duration (min)', settings.coachMaxDurationMinutes, (v) => updateSettings({ coachMaxDurationMinutes: v }), 30, 30)}
          {numberInput('Min athlete session (min)', settings.minAthleteDurationMinutes, (v) => updateSettings({ minAthleteDurationMinutes: v }), 5, 5)}
          {numberInput('Extension notice (min)', settings.extensionNoticeMinutes, (v) => updateSettings({ extensionNoticeMinutes: v }))}
          {numberInput('Coach reschedule freeze (hours)', settings.coachRescheduleFreezeHours, (v) => updateSettings({ coachRescheduleFreezeHours: v }))}
        </div>
        <div className="px-6 pb-4 text-xs text-gray-400 space-y-1">
          <p>• <strong>Customer max duration</strong> — longest session a customer can book (default 120 min)</p>
          <p>• <strong>Coach max duration</strong> — longest coach booking slot (default 600 min)</p>
          <p>• <strong>Min athlete session</strong> — shortest individual athlete slot in a coach booking (default 15 min)</p>
          <p>• <strong>Extension notice</strong> — customer must extend a booking more than N minutes before it starts (default 20)</p>
          <p>• <strong>Coach reschedule freeze</strong> — coaches cannot self-reschedule within N hours of session start (default 24)</p>
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
