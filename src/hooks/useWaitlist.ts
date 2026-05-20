import { useState, useEffect, useCallback } from 'react'
import { getWaitlistStore, type WaitlistEntry, type WaitlistNotification } from '../lib/waitlist-store'

const store = getWaitlistStore()

export function useWaitlist(userId?: string) {
  const [entries, setEntries] = useState<WaitlistEntry[]>(() => store.getAll())
  const [notifications, setNotifications] = useState<WaitlistNotification[]>(() =>
    userId ? store.getNotifications(userId) : []
  )

  useEffect(() => {
    const unsub1 = store.subscribe(setEntries)
    const unsub2 = store.subscribeNotifications((all) => {
      setNotifications(userId ? all.filter(n => n.userId === userId) : [])
    })
    return () => { unsub1(); unsub2() }
  }, [userId])

  const addToWaitlist = useCallback((items: Omit<WaitlistEntry, 'id' | 'createdAt' | 'notified'>[]) => {
    return store.addToWaitlist(items)
  }, [])

  const removeFromWaitlist = useCallback((entryId: string) => {
    return store.removeFromWaitlist(entryId)
  }, [])

  const isOnWaitlist = useCallback((uId: string, laneId: string, date: string, hour: number) => {
    return store.isOnWaitlist(uId, laneId, date, hour)
  }, [])

  const getWaitlistCount = useCallback((laneId: string, date: string, hour: number) => {
    return store.getForSlot(laneId, date, hour).length
  }, [])

  const notifyWaitlistedUsers = useCallback((laneId: string, laneName: string, date: string, hours: number[]) => {
    return store.notifyWaitlistedUsers(laneId, laneName, date, hours)
  }, [])

  const dismissNotification = useCallback((notifId: string) => {
    store.dismissNotification(notifId)
  }, [])

  const getUserEntries = useCallback((uId: string) => {
    return entries.filter(e => e.userId === uId)
  }, [entries])

  return {
    entries,
    notifications,
    addToWaitlist,
    removeFromWaitlist,
    isOnWaitlist,
    getWaitlistCount,
    notifyWaitlistedUsers,
    dismissNotification,
    getUserEntries,
  }
}
