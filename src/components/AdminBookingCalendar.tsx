import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getErrorMessage } from '../lib/errors'
import {
  LANES, formatDateKey, formatTime, getAWSTNow, isToday, isSlotBooked,
  getActiveHalfHoursForLane, type Lane, type TimeSlot, type Booking,
} from '../lib/booking-data'
import { getHoursForDate } from '../lib/settings-store'
import { useSettings } from '../hooks/useSettings'
import { useBookings } from '../hooks/useBookingStore'
import AdminManualBookingModal, { type AdminCustomerOption, type BookingConfirmResult } from './AdminManualBookingModal'
import AdminBookingDetailsModal from './AdminBookingDetailsModal'
import LaneBlockModal from './LaneBlockModal'

// Generate days from N months back to N months ahead (AWST aware)
function generateAdminDays(monthsBack: number = 12, monthsAhead: number = 12): Date[] {
  const days: Date[] = []
  const start = getAWSTNow()
  start.setHours(0, 0, 0, 0)
  start.setMonth(start.getMonth() - monthsBack)
  start.setDate(1)
  const end = getAWSTNow()
  end.setHours(0, 0, 0, 0)
  end.setMonth(end.getMonth() + monthsAhead)
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d))
  }
  return days
}

export default function AdminBookingCalendar() {
  const { settings } = useSettings()
  const { bookings, addBooking } = useBookings()
  const deleteBookingMut = useMutation(api.mutations.deleteBooking)
  const handleDeleteBooking = async (bookingId: string, customerName: string) => {
    if (!confirm(`Permanently delete booking for ${customerName}? This cannot be undone.`)) return
    try {
      await deleteBookingMut({ id: bookingId as any })
    } catch (e: any) {
      alert(getErrorMessage(e) ?? 'Failed to delete booking')
    }
  }
  const allCustomers = useQuery(api.queries.listCustomers) ?? []
  const coachColorByEmail = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of allCustomers as any[]) {
      if (c.role === 'coach' && c.color && c.email) map.set(c.email.toLowerCase(), c.color)
    }
    return map
  }, [allCustomers])
  const coachColorById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of allCustomers as any[]) {
      if (c.role === 'coach' && c.color && c._id) map.set(String(c._id), c.color)
    }
    return map
  }, [allCustomers])
  const getCoachColor = (b: Booking): string | undefined => {
    if (!b.isCoachBooking) return undefined
    if (b.customerEmail) {
      const byEmail = coachColorByEmail.get(b.customerEmail.toLowerCase())
      if (byEmail) return byEmail
    }
    if (b.userId) {
      const byId = coachColorById.get(String(b.userId))
      if (byId) return byId
    }
    return undefined
  }
  const getContrastText = (hex?: string): string => {
    if (!hex) return '#fff'
    const h = hex.replace('#', '')
    const full = h.length === 3 ? h.split('').map(x => x + x).join('') : h
    if (full.length !== 6) return '#fff'
    const r = parseInt(full.slice(0, 2), 16)
    const g = parseInt(full.slice(2, 4), 16)
    const bl = parseInt(full.slice(4, 6), 16)
    const luma = (0.299 * r + 0.587 * g + 0.114 * bl) / 255
    return luma > 0.6 ? '#1f2937' : '#fff'
  }
  const allDays = useMemo(() => generateAdminDays(12, 12), [])
  const [selectedDay, setSelectedDay] = useState<Date>(() => {
    const today = getAWSTNow()
    today.setHours(0, 0, 0, 0)
    return allDays.find(d => formatDateKey(d) === formatDateKey(today)) ?? allDays[0]
  })
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<{ lane: Lane; date: Date; startHour: number } | null>(null)
  const [detailsBooking, setDetailsBooking] = useState<Booking | null>(null)

  // Customer selection
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'customer' | 'coach'>('all')

  const filteredCustomers = useMemo(() => {
    const list = allCustomers as any[]
    return list
      .filter((c) => (roleFilter === 'all' ? c.role !== 'admin' : c.role === roleFilter))
      .filter((c) => {
        if (!customerSearch.trim()) return true
        const q = customerSearch.toLowerCase()
        return (
          (c.name ?? '').toLowerCase().includes(q) ||
          (c.email ?? '').toLowerCase().includes(q) ||
          (c.phone ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }, [allCustomers, customerSearch, roleFilter])

  const selectedCustomer: AdminCustomerOption | null = useMemo(() => {
    const c = (allCustomers as any[]).find((c) => c._id === selectedCustomerId)
    if (!c) return null
    return { _id: c._id, name: c.name ?? '', email: c.email ?? '', phone: c.phone, role: c.role ?? 'customer' }
  }, [allCustomers, selectedCustomerId])

  const allTimeSlots = useMemo(() => {
    const { open, close } = getHoursForDate(settings, selectedDay)
    const slots: TimeSlot[] = []
    for (let h = open; h < close; h += 0.5) slots.push({ hour: h, label: formatTime(h) })
    return slots
  }, [selectedDay, settings])
  const dateKey = formatDateKey(selectedDay)

  // Build month groups for navigation
  const monthGroups = useMemo(() => {
    const groups: { key: string; label: string; days: Date[] }[] = []
    for (const d of allDays) {
      const key = `${d.getFullYear()}-${d.getMonth()}`
      const last = groups[groups.length - 1]
      if (!last || last.key !== key) {
        groups.push({
          key,
          label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
          days: [d],
        })
      } else {
        last.days.push(d)
      }
    }
    return groups
  }, [allDays])

  const [activeMonthKey, setActiveMonthKey] = useState<string>(() => {
    const today = getAWSTNow()
    return `${today.getFullYear()}-${today.getMonth()}`
  })
  const activeMonth = monthGroups.find(m => m.key === activeMonthKey) ?? monthGroups[0]

  const monthScrollRef = useRef<HTMLDivElement | null>(null)
  const activeMonthBtnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (activeMonthBtnRef.current && monthScrollRef.current) {
      const btn = activeMonthBtnRef.current
      const container = monthScrollRef.current
      const offset = btn.offsetLeft - container.clientWidth / 2 + btn.clientWidth / 2
      container.scrollTo({ left: Math.max(0, offset), behavior: 'smooth' })
    }
  }, [activeMonthKey])

  const laneActiveHalfHours = useMemo(() => {
    const map = new Map<string, Set<number>>()
    for (const lane of LANES) map.set(lane.id, getActiveHalfHoursForLane(bookings, lane.id, dateKey))
    return map
  }, [bookings, dateKey])

  const visibleTimeSlots = useMemo(() => {
    return allTimeSlots.filter(slot => {
      if (slot.hour === Math.floor(slot.hour)) return true
      for (const activeSet of laneActiveHalfHours.values()) {
        if (activeSet.has(slot.hour)) return true
      }
      return false
    })
  }, [allTimeSlots, laneActiveHalfHours])

  const isPastDay = useMemo(() => {
    const today = getAWSTNow(); today.setHours(0,0,0,0)
    return selectedDay < today
  }, [selectedDay])

  const handleSlotClick = (lane: Lane, slot: TimeSlot) => {
    // UX-5: Admin can override facility closures with explicit confirmation
    if (isDateClosed) {
      if (!confirm('⚠️ This date is marked as closed. Do you want to create an admin booking anyway?')) return
    }
    if (!selectedCustomer) {
      alert('Please select a customer or coach first to make a booking on their behalf.')
      return
    }
    const booked = isSlotBooked(bookings, lane.id, dateKey, slot.hour)
    if (booked) return
    setSelectedSlot({ lane, date: selectedDay, startHour: slot.hour })
    setModalOpen(true)
  }

  // UX-4: Surface booking errors + DI-3/DI-4: return per-date results
  const handleBookingConfirm = async (newBookings: Booking[]): Promise<BookingConfirmResult> => {
    let succeeded = 0; let failed = 0; const failedDates: string[] = []
    const createdIds: string[] = []
    // Defer closing the modal when a payment request is in play so it can show
    // the generated pay link(s) before unmounting.
    const isRequest = newBookings.some(b => b.status === 'pending_payment')
    for (const b of newBookings) {
      try {
        const id = await addBooking(b)
        if (id) createdIds.push(String(id))
        succeeded++
      } catch (e: any) {
        failed++
        const msg = getErrorMessage(e) ?? 'Conflict or server error'
        if (!failedDates.some(d => d.startsWith(b.date))) {
          failedDates.push(`${b.date} (${b.laneId}): ${msg}`)
        }
      }
    }
    if (failed === 0 && !isRequest) {
      setModalOpen(false)
      setSelectedSlot(null)
    }
    return { succeeded, failed, failedDates, createdIds }
  }

  const dayBookings = bookings.filter(b => b.date === dateKey && b.status !== 'cancelled')

  // Lane blocks for selected date
  const laneBlocks = (useQuery(api.laneBlocks.listByDate, { date: dateKey }) ?? []) as any[]
  const isDateClosed = useQuery(api.closures.isClosed, { date: dateKey }) ?? false
  const removeBlockMut = useMutation(api.laneBlocks.removeLaneBlock)
  const [blockModalOpen, setBlockModalOpen] = useState(false)
  const [blockPrefill, setBlockPrefill] = useState<{ laneId: string; startHour: number } | null>(null)
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false)

  const fmtHour = (h: number) => {
    const hr = Math.floor(h)
    const min = Math.round((h - hr) * 60)
    const period = hr >= 12 ? 'pm' : 'am'
    const display = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr
    return min > 0 ? `${display}:${min.toString().padStart(2, '0')}${period}` : `${display}${period}`
  }

  const getBlockForSlot = (laneId: string, hour: number) => {
    return laneBlocks.find((b) => {
      if (b.laneId !== laneId) return false
      const end = b.startHour + b.duration / 60
      return hour >= b.startHour && hour < end
    })
  }

  const handleRemoveBlock = async (id: string, laneName: string) => {
    if (!confirm(`Remove service block on ${laneName}?`)) return
    try { await removeBlockMut({ id: id as any }) } catch (e: any) { alert(getErrorMessage(e) ?? 'Failed') }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 text-xs text-blue-600 dark:text-blue-400">
        <span>🛡️</span>
        <span><strong className="font-semibold">Admin Calendar</strong> — 12-month view · Use the toolbar below to select a customer or coach before booking · Past dates are read-only</span>
      </div>

      {/* Date Picker — month strip + day grid in one card */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm">
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => {
                const awstToday = getAWSTNow()
                const todayKey = `${awstToday.getFullYear()}-${awstToday.getMonth()}`
                setActiveMonthKey(todayKey)
                const today = getAWSTNow(); today.setHours(0,0,0,0)
                const t = allDays.find(d => formatDateKey(d) === formatDateKey(today))
                if (t) setSelectedDay(t)
              }}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-semibold hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
            >
              📅 Today
            </button>
            <span className="text-[10px] text-gray-400">Scroll to view past or future months</span>
          </div>
          <div ref={monthScrollRef} className="flex gap-2 overflow-x-auto pb-1">
            {monthGroups.map(m => {
              const today = getAWSTNow()
              const [yr, mo] = m.key.split('-').map(Number)
              const isPast = yr < today.getFullYear() || (yr === today.getFullYear() && mo < today.getMonth())
              const isCurrent = yr === today.getFullYear() && mo === today.getMonth()
              return (
                <button
                  key={m.key}
                  ref={m.key === activeMonthKey ? activeMonthBtnRef : undefined}
                  onClick={() => {
                    setActiveMonthKey(m.key)
                    setSelectedDay(m.days[0])
                  }}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                    m.key === activeMonthKey
                      ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/30'
                      : isPast
                        ? 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'
                        : isCurrent
                          ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  {isPast && '🕓 '}{m.label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{activeMonth?.label}</h3>
            <span className="text-xs text-gray-500 dark:text-gray-400">{activeMonth?.days.length} days</span>
          </div>
          <div className="grid grid-cols-7 gap-2">
            {activeMonth?.days.map(day => {
              const active = formatDateKey(day) === formatDateKey(selectedDay)
              const today = isToday(day)
              const dayBookCount = bookings.filter(b => b.date === formatDateKey(day) && b.status !== 'cancelled').length
              return (
                <button
                  key={formatDateKey(day)}
                  onClick={() => setSelectedDay(day)}
                  className={`relative flex flex-col items-center py-2 px-1 rounded-xl transition-all duration-200 text-center ${
                    active
                      ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 scale-105'
                      : today
                        ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700'
                        : 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                  }`}
                >
                  <span className="text-[10px] uppercase font-medium opacity-75">
                    {day.toLocaleDateString('en-US', { weekday: 'short' })}
                  </span>
                  <span className="text-base font-bold">{day.getDate()}</span>
                  {dayBookCount > 0 && (
                    <span className={`text-[9px] mt-0.5 px-1 rounded-full ${active ? 'bg-white/30' : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'}`}>
                      {dayBookCount}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Lane × Time Grid */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-4 shadow-sm overflow-x-auto">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
            {selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Customer selector — inline dropdown */}
            <div className="relative">
              {selectedCustomer ? (
                <div className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20">
                  <span className={`w-5 h-5 rounded-full ${selectedCustomer.role === 'coach' ? 'bg-orange-500' : 'bg-emerald-500'} flex items-center justify-center text-white text-[9px] font-bold shrink-0`}>
                    {selectedCustomer.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="font-semibold text-gray-800 dark:text-gray-200 max-w-[120px] truncate">{selectedCustomer.name}</span>
                  <button onClick={() => setSelectedCustomerId('')} className="text-gray-400 hover:text-red-500 ml-0.5 leading-none text-base">×</button>
                </div>
              ) : (
                <button
                  onClick={() => setCustomerDropdownOpen(o => !o)}
                  className="text-[11px] px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:border-emerald-400 dark:hover:border-emerald-600 font-medium transition-colors"
                >
                  👤 Select customer…
                </button>
              )}
              {customerDropdownOpen && !selectedCustomer && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setCustomerDropdownOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-72 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-xl z-40 overflow-hidden">
                    <div className="p-2 space-y-1.5 border-b border-gray-100 dark:border-gray-800">
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
                        <input
                          type="text"
                          autoFocus
                          value={customerSearch}
                          onChange={(e) => setCustomerSearch(e.target.value)}
                          placeholder="Search name, email…"
                          className="w-full pl-7 pr-3 py-1.5 text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg outline-none focus:ring-1 focus:ring-emerald-500 text-gray-800 dark:text-gray-200 placeholder-gray-400"
                        />
                      </div>
                      <div className="flex gap-1">
                        {(['all', 'customer', 'coach'] as const).map(r => (
                          <button key={r} onClick={() => setRoleFilter(r)} className={`flex-1 text-[10px] py-1 rounded-md font-semibold transition-colors ${roleFilter === r ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                            {r.charAt(0).toUpperCase() + r.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="max-h-56 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
                      {filteredCustomers.length === 0 ? (
                        <div className="p-3 text-center text-xs text-gray-400">{customerSearch ? 'No matches' : 'No customers'}</div>
                      ) : filteredCustomers.map((c) => (
                        <button key={c._id} onClick={() => { setSelectedCustomerId(c._id); setCustomerDropdownOpen(false) }} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors text-left">
                          <div className={`w-6 h-6 ${c.role === 'coach' ? 'bg-orange-500' : 'bg-emerald-500'} rounded-full flex items-center justify-center text-white text-[9px] font-bold shrink-0`}>
                            {(c.name ?? '?').charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{c.name}</div>
                            <div className="text-[9px] text-gray-400 truncate">{c.email}</div>
                          </div>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${c.role === 'coach' ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400' : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'}`}>
                            {c.role === 'coach' ? 'Coach' : 'Cust.'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400">{dayBookings.length} bookings</span>
            <button
              onClick={() => { setBlockPrefill(null); setBlockModalOpen(true) }}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 font-semibold hover:bg-orange-200 dark:hover:bg-orange-900/50 transition-colors"
            >
              🔧 Block Lane
            </button>
          </div>
        </div>
        {laneBlocks.length > 0 && (
          <div className="mb-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800/40 rounded-lg p-2.5">
            <div className="text-[11px] font-semibold text-orange-700 dark:text-orange-400 mb-1.5">🔧 Active service blocks ({laneBlocks.length})</div>
            <div className="flex flex-wrap gap-1.5">
              {laneBlocks.map((b: any) => {
                const lane = LANES.find(l => l.id === b.laneId)
                const fmtH = (h: number) => { const hr = Math.floor(h); const m = Math.round((h-hr)*60); const p = hr>=12?'PM':'AM'; const d = hr===0?12:hr>12?hr-12:hr; return `${d}:${m.toString().padStart(2,'0')}${p}` }
                return (
                  <span key={b._id} className="inline-flex items-center gap-1 text-[10px] bg-white dark:bg-gray-800 border border-orange-200 dark:border-orange-800 rounded-full pl-2 pr-1 py-0.5">
                    <span className="font-semibold text-orange-700 dark:text-orange-400">{lane?.shortName ?? b.laneId}</span>
                    <span className="text-gray-600 dark:text-gray-300">{fmtH(b.startHour)}–{fmtH(b.startHour + b.duration/60)}</span>
                    {b.reason && <span className="text-gray-400 italic">· {b.reason}</span>}
                    <button onClick={() => handleRemoveBlock(b._id, lane?.shortName ?? b.laneId)} className="ml-0.5 w-4 h-4 rounded-full bg-red-500 hover:bg-red-600 text-white text-[9px] leading-none flex items-center justify-center">×</button>
                  </span>
                )
              })}
            </div>
          </div>
        )}
        {isDateClosed && (
          <div className="mb-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg p-2.5 text-xs text-red-700 dark:text-red-400 font-semibold">
            🚫 This date is marked as CLOSED — no bookings can be made.
          </div>
        )}
        {isPastDay && (
          <div className="mb-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/40 rounded-lg p-2.5 text-xs text-blue-700 dark:text-blue-400">
            🕓 Viewing historical date — admin can backdate bookings here.
          </div>
        )}
        {!selectedCustomer && !isDateClosed && (
          <div className="mb-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded-lg p-2.5 text-xs text-amber-700 dark:text-amber-400">
            ⚠️ Select a customer or coach above to enable booking. You can still view existing bookings.
          </div>
        )}
        <div className="min-w-[640px]">
          {/* Single CSS grid — bookings use gridRow span so multi-hour blocks render as one cell */}
          <div
            className="grid gap-1"
            style={{
              gridTemplateColumns: '80px repeat(5, 1fr)',
              gridTemplateRows: `auto repeat(${visibleTimeSlots.length}, auto)`,
            }}
          >
            {/* ── Header row ── */}
            <div className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 px-2 py-1 sticky left-0 z-20 bg-white dark:bg-gray-900 border-r border-gray-100 dark:border-gray-800" style={{ gridRow: 1, gridColumn: 1 }}>Time</div>
            {LANES.map((lane, li) => (
              <div key={lane.id} style={{ gridRow: 1, gridColumn: li + 2 }} className="text-[10px] font-semibold text-gray-700 dark:text-gray-300 px-2 py-1 text-center bg-gray-50 dark:bg-gray-800 rounded">
                {lane.icon} {lane.shortName}
              </div>
            ))}

            {/* ── Time labels ── */}
            {visibleTimeSlots.map((slot, rowIdx) => (
              <div key={`t-${slot.hour}`} style={{ gridRow: rowIdx + 2, gridColumn: 1 }} className="text-[11px] text-gray-500 dark:text-gray-400 px-2 py-2 font-medium sticky left-0 z-10 bg-white dark:bg-gray-900 border-r border-gray-100 dark:border-gray-800">
                {slot.label}
              </div>
            ))}

            {/* ── Lane columns with row-spanning bookings ── */}
            {LANES.map((lane, laneIdx) => {
              const cells: React.ReactNode[] = []
              const skippedRows = new Set<number>()

              visibleTimeSlots.forEach((slot, rowIdx) => {
                if (skippedRows.has(rowIdx)) return

                const booked = isSlotBooked(bookings, lane.id, dateKey, slot.hour)
                const block  = !booked ? getBlockForSlot(lane.id, slot.hour) : undefined

                if (booked) {
                  // Only render on the booking's first visible slot
                  if (slot.hour !== booked.startHour) { skippedRows.add(rowIdx); return }
                  const endHour = booked.startHour + booked.duration / 60
                  // Count how many visible rows this booking covers and mark them skipped
                  let spanCount = 0
                  visibleTimeSlots.forEach((s, si) => {
                    if (s.hour >= booked.startHour && s.hour < endHour) {
                      spanCount++
                      if (si !== rowIdx) skippedRows.add(si)
                    }
                  })
                  spanCount = Math.max(1, spanCount)
                  const coachColor    = getCoachColor(booked)
                  const coachTextColor = getContrastText(coachColor)
                  const timeRange = `${fmtHour(booked.startHour)}–${fmtHour(booked.startHour + booked.duration / 60)}`

                  cells.push(
                    <div
                      key={`b-${lane.id}-${slot.hour}`}
                      style={{
                        gridRow: `${rowIdx + 2} / span ${spanCount}`,
                        gridColumn: laneIdx + 2,
                        ...(coachColor ? { backgroundColor: coachColor, color: coachTextColor } : {}),
                      }}
                      className={`relative group text-[10px] py-2 px-1 rounded font-semibold flex flex-col ${
                        coachColor ? '' : 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400'
                      }`}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); setDetailsBooking(booked) }}
                        title={`View / modify booking — ${booked.customerName}`}
                        className="text-left w-full hover:opacity-80 transition-opacity leading-tight flex-1"
                      >
                        <div className="break-words font-semibold">{booked.isCoachBooking ? '🏅 Coach: ' : '🔒 '}{booked.customerName}</div>
                        <div className="text-[9px] opacity-80 mt-0.5 font-medium flex items-center gap-1">
                          {timeRange}
                          {(booked.modificationHistory?.length ?? 0) > 0 && (
                            <span className="opacity-60" title={`${booked.modificationHistory!.length} modification${booked.modificationHistory!.length !== 1 ? 's' : ''}`}>
                              ✏️{booked.modificationHistory!.length}
                            </span>
                          )}
                        </div>
                        {booked.isCoachBooking && booked.notes ? (
                          <div className="mt-1 pt-1 border-t border-white/25">
                            <div
                              className="text-[9px] font-semibold leading-snug"
                              style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as React.CSSProperties}
                              title={booked.notes}
                            >📝 {booked.notes}</div>
                          </div>
                        ) : booked.notes ? (
                          <div className="text-[8px] mt-0.5 opacity-90 font-semibold italic break-words" title={booked.notes}>📝 {booked.notes}</div>
                        ) : null}
                        {booked.isCoachBooking && booked.athleteSlots && booked.athleteSlots.length > 0 && (
                          <div className="mt-1 pt-1 border-t border-white/30 space-y-0.5">
                            <div className="text-[8px] uppercase tracking-wide opacity-80 font-bold">🏏 Athletes ({booked.athleteSlots.length})</div>
                            {booked.athleteSlots.map((a, i) => (
                              <div key={i} className="text-[9px] leading-tight break-words" title={`${a.athleteName} — ${a.durationMinutes}min`}>
                                • {a.athleteName} <span className="opacity-70">({a.durationMinutes}m)</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteBooking(booked.id, booked.customerName) }}
                        title="Delete booking permanently"
                        className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[9px] leading-none opacity-0 group-hover:opacity-100 hover:bg-red-700 transition-opacity flex items-center justify-center shadow"
                      >×</button>
                    </div>
                  )
                  return
                }

                if (block) {
                  // Span block across its duration too
                  const blockEndHour = block.startHour + block.duration / 60
                  let blockSpan = 0
                  visibleTimeSlots.forEach((s, si) => {
                    if (s.hour >= block.startHour && s.hour < blockEndHour) {
                      blockSpan++
                      if (si !== rowIdx) skippedRows.add(si)
                    }
                  })
                  blockSpan = Math.max(1, blockSpan)
                  cells.push(
                    <div key={`blk-${lane.id}-${slot.hour}`}
                         style={{ gridRow: `${rowIdx + 2} / span ${blockSpan}`, gridColumn: laneIdx + 2 }}
                         className="relative group text-[10px] py-2 px-1 rounded font-semibold bg-orange-200 dark:bg-orange-900/40 text-orange-800 dark:text-orange-300">
                      <div className="truncate" title={block.reason ?? 'Service / repair'}>🔧 {block.reason ? block.reason.slice(0, 12) : 'Service'}</div>
                      <button onClick={(e) => { e.stopPropagation(); handleRemoveBlock(block._id, lane.shortName) }} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[9px] leading-none opacity-0 group-hover:opacity-100 hover:bg-red-700 transition-opacity flex items-center justify-center shadow">×</button>
                    </div>
                  )
                  return
                }

                // Empty slot — book button
                cells.push(
                  <div key={`e-${lane.id}-${slot.hour}`}
                       style={{ gridRow: rowIdx + 2, gridColumn: laneIdx + 2 }}
                       className="relative group">
                    <button
                      onClick={() => handleSlotClick(lane, slot)}
                      disabled={!selectedCustomer}
                      className={`w-full text-[10px] py-2 px-1 rounded transition-all ${
                        !selectedCustomer
                          ? 'bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-600 cursor-not-allowed'
                          : 'bg-emerald-50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 hover:scale-105 cursor-pointer'
                      }`}
                    >
                      {selectedCustomer ? '+ Book' : '—'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setBlockPrefill({ laneId: lane.id, startHour: slot.hour }); setBlockModalOpen(true) }}
                      title="Block this lane for service/repair"
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-orange-500 text-white text-[9px] leading-none opacity-0 group-hover:opacity-100 hover:bg-orange-600 transition-opacity flex items-center justify-center shadow"
                    >🔧</button>
                  </div>
                )
              })

              return cells
            })}
          </div>
        </div>
      </div>

      {detailsBooking && (
        <AdminBookingDetailsModal
          booking={detailsBooking}
          onClose={() => setDetailsBooking(null)}
          onSave={(newDate) => {
            setDetailsBooking(null)
            // Navigate calendar to the saved date (which may be different from the original)
            const newDay = allDays.find(d => formatDateKey(d) === newDate)
            if (newDay) {
              setSelectedDay(newDay)
              setActiveMonthKey(`${newDay.getFullYear()}-${newDay.getMonth()}`)
            }
          }}
        />
      )}

      {blockModalOpen && (
        <LaneBlockModal
          date={selectedDay}
          prefill={blockPrefill}
          onClose={() => { setBlockModalOpen(false); setBlockPrefill(null) }}
        />
      )}

      {modalOpen && selectedSlot && selectedCustomer && (
        <AdminManualBookingModal
          lane={selectedSlot.lane}
          date={selectedSlot.date}
          startHour={selectedSlot.startHour}
          customer={selectedCustomer}
          existingBookings={bookings}
          onClose={() => { setModalOpen(false); setSelectedSlot(null) }}
          onConfirm={handleBookingConfirm}
        />
      )}
    </div>
  )
}
