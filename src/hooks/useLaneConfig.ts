import { useEffect, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { getLaneConfigStore, type LaneConfig, type LaneRow, type LaneOverrideRow } from '../lib/lanes'
import { getAWSTNow, formatDateKey } from '../lib/booking-data'

const store = getLaneConfigStore()

/**
 * Hydrates the lane-config store from Convex (SPEC_RECONFIGURABLE_LANES). Mirrors
 * useSettings: a Convex query → push into a localStorage-backed singleton so the
 * synchronous resolvers in src/lib/lanes.ts (read by calendars, the booking
 * popup, pricing) react to admin layout changes live. Call once near the app root.
 *
 * Overrides are fetched for a wide window (today − 1d … +45d) covering the
 * bookable horizon; the volume is tiny (sparse, only non-standard dates).
 */
export function useLaneConfig() {
  const [cfg, setCfg] = useState<LaneConfig>(() => store.get())

  const today = getAWSTNow()
  const start = new Date(today)
  start.setDate(start.getDate() - 1)
  const end = new Date(today)
  end.setDate(end.getDate() + 45)
  const startDate = formatDateKey(start)
  const endDate = formatDateKey(end)

  const lanes = useQuery(api.lanes.listLanes, {}) as LaneRow[] | undefined
  const overrides = useQuery(api.lanes.listLaneOverrides, { startDate, endDate }) as
    | LaneOverrideRow[]
    | undefined

  useEffect(() => store.subscribe(setCfg), [])

  useEffect(() => {
    const next: Partial<LaneConfig> = {}
    if (lanes && lanes.length) next.lanes = lanes
    if (overrides) next.overrides = overrides
    if (next.lanes || next.overrides) store.set(next)
  }, [lanes, overrides])

  return cfg
}

export default useLaneConfig
