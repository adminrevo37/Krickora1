import { useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'

export interface LaneBlock {
  _id: string
  laneId: string
  date: string
  startHour: number
  duration: number // minutes
  reason?: string
}

export function useLaneBlocks() {
  const raw = useQuery(api.laneBlocks.listAll) ?? []
  const blocks = raw as unknown as LaneBlock[]

  const isLaneBlocked = (laneId: string, dateKey: string, hour: number): LaneBlock | null => {
    for (const b of blocks) {
      if (b.laneId !== laneId || b.date !== dateKey) continue
      const end = b.startHour + b.duration / 60
      if (hour >= b.startHour && hour < end) return b
    }
    return null
  }

  const getBlocksForLaneDate = (laneId: string, dateKey: string): LaneBlock[] => {
    return blocks.filter(b => b.laneId === laneId && b.date === dateKey)
  }

  return { blocks, isLaneBlocked, getBlocksForLaneDate }
}
