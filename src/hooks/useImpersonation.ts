import { useState, useEffect, useCallback } from 'react'
import {
  getImpersonation,
  startImpersonation,
  stopImpersonation,
  IMPERSONATION_EVENT,
  ImpersonatedUser,
} from '../lib/impersonation'

export function useImpersonation() {
  const [impersonatedUser, setImpersonatedUser] = useState<ImpersonatedUser | null>(getImpersonation)

  useEffect(() => {
    const handler = () => setImpersonatedUser(getImpersonation())
    window.addEventListener(IMPERSONATION_EVENT, handler)
    return () => window.removeEventListener(IMPERSONATION_EVENT, handler)
  }, [])

  const impersonate = useCallback((user: ImpersonatedUser) => {
    startImpersonation(user)
    setImpersonatedUser(user)
  }, [])

  const exitImpersonation = useCallback(() => {
    stopImpersonation()
    setImpersonatedUser(null)
  }, [])

  return {
    impersonatedUser,
    isImpersonating: impersonatedUser !== null,
    impersonate,
    exitImpersonation,
  }
}
