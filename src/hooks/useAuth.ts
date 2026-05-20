import { useCallback, useMemo, useEffect, useRef } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useSession } from '../lib/auth-client'

/**
 * useAuth — Fully Convex-native hook using Better Auth session.
 * 
 * KEY FIX (redirect loop prevention):
 * When a blocked tracker causes 401/403 CORS errors, the Convex WebSocket
 * may briefly return undefined for getCurrentUser. Without protection, this
 * causes isAuthenticated to flip to false → protected routes redirect to / → loop.
 * 
 * Solution: Once authenticated, we keep isAuthenticated=true (and isLoading=true)
 * during transient undefined states. We only flip to unauthenticated when the
 * Better Auth session explicitly reports no user (isPending=false, data=null).
 */
export function useAuth() {
  // ── Better Auth session (client-side, has proper isPending) ──────────
  const { data: session, isPending: sessionPending } = useSession()

  // ── Better Auth user from Convex (server-side, real-time) ────────────
  const betterAuthUser = useQuery(api.auth.getCurrentUser)

  // ── Stabilization: track if we were ever authenticated ───────────────
  // This prevents a transient 401/403 (from blocked tracker CORS) from
  // immediately flipping isAuthenticated to false and triggering a redirect.
  const wasAuthenticatedRef = useRef(false)
  const authStableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Update the ref when we confirm authentication
  if (betterAuthUser && !wasAuthenticatedRef.current) {
    wasAuthenticatedRef.current = true
  }

  // ── TRUE loading state ───────────────────────────────────────────────
  // We consider it "loading" if:
  // 1. The Better Auth client is still fetching the session (sessionPending), OR
  // 2. The client says we have a session but Convex hasn't returned the user yet, OR
  // 3. We WERE authenticated but Convex user went undefined (transient error) —
  //    keep loading=true instead of flashing unauthenticated UI
  const isInTransientError = wasAuthenticatedRef.current && betterAuthUser === undefined && !sessionPending && !!session?.user
  const isLoading = sessionPending 
    || (!!session?.user && betterAuthUser === undefined)
    || isInTransientError

  // ── Authentication: only false when we're SURE there's no session ────
  // If we were previously authenticated and now see undefined from Convex,
  // DON'T flip to false — stay authenticated (isLoading will be true).
  // Only go to false when Better Auth session explicitly says no user.
  const isAuthenticated = (() => {
    // Still loading — don't decide yet
    if (isLoading) return wasAuthenticatedRef.current
    // Definitive: we have a user
    if (betterAuthUser) return true
    // Definitive: Better Auth says no session (not pending, no data)
    if (!sessionPending && !session?.user) {
      // Clear the stabilization flag — user genuinely signed out
      wasAuthenticatedRef.current = false
      return false
    }
    // Fallback: keep previous state
    return wasAuthenticatedRef.current
  })()

  // ── Convex queries for real-time cloud data ──────────────────────────
  const customerRecord = useQuery(
    api.queries.getCustomerByEmail,
    betterAuthUser?.email ? { email: betterAuthUser.email } : 'skip'
  )

  const allCoachRecords = useQuery(api.queries.listCustomersByRole, { role: 'coach' }) ?? []
  const allCustomersAll = useQuery(api.queries.listCustomers) ?? []
  const coachInviteRecords = useQuery(api.queries.listCoachInvites) ?? []

  // ── Convex mutations ─────────────────────────────────────────────────
  const updateCustomerMutation = useMutation(api.mutations.updateCustomer)
  const upsertCustomerMutation = useMutation(api.mutations.upsertCustomer)
  const createCoachInviteMutation = useMutation(api.mutations.createCoachInvite)
  const adminSetPasswordAction = useAction(api.adminPassword.adminSetPassword)

  // ── Auto-create customer record if missing ───────────────────────────
  useEffect(() => {
    if (betterAuthUser?.email && customerRecord === null) {
      // User is authenticated but has no customer record — create one
      upsertCustomerMutation({
        name: betterAuthUser.name ?? betterAuthUser.email.split('@')[0],
        email: betterAuthUser.email.toLowerCase().trim(),
        phone: '',
        role: 'customer',
      }).catch((err) => {
        console.error('Failed to auto-create customer record:', err)
      })
    }
  }, [betterAuthUser?.email, betterAuthUser?.name, customerRecord, upsertCustomerMutation])

  // ── Cleanup stabilization timer on unmount ───────────────────────────
  useEffect(() => {
    return () => {
      if (authStableTimerRef.current) {
        clearTimeout(authStableTimerRef.current)
      }
    }
  }, [])

  // ── Derived role from Convex ─────────────────────────────────────────
  const customerRole = customerRecord?.role ?? 'customer'
  const isCoach = customerRole === 'coach'
  const isCustomer = customerRole === 'customer'
  const isAdmin = customerRole === 'admin'

  // Build user object compatible with existing UI
  const user = useMemo(() => {
    if (!betterAuthUser) return null
    return {
      id: betterAuthUser.id,
      name: betterAuthUser.name ?? betterAuthUser.email.split('@')[0],
      email: betterAuthUser.email,
      phone: customerRecord?.phone as string | undefined,
      role: customerRole as 'customer' | 'coach' | 'admin',
      color: (customerRecord as any)?.color as string | undefined,
    }
  }, [betterAuthUser, customerRecord, customerRole])

  // ── Coach list (from Convex, real-time) ──────────────────────────────
  const getAllCoaches = useCallback(() => {
    return allCoachRecords.map(c => ({
      id: c._id,
      _id: c._id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role as 'coach',
    }))
  }, [allCoachRecords])

  // ── All customers (for admin) ────────────────────────────────────────
  const getAllCustomers = useCallback(() => {
    return allCustomersAll.map(c => ({
      id: c._id,
      _id: c._id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role,
      creditBalance: c.creditBalance ?? 0,
      assignedCoachIds: c.assignedCoachIds ?? [],
    }))
  }, [allCustomersAll])

  // ── Get user by ID (from Convex customers) ───────────────────────────
  const getUserById = useCallback((userId: string) => {
    const c = allCustomersAll.find(c => c._id === userId)
    if (!c) return null
    return {
      id: c._id,
      _id: c._id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role,
      creditBalance: c.creditBalance ?? 0,
      assignedCoachIds: c.assignedCoachIds ?? [],
    }
  }, [allCustomersAll])

  // ── Assign/Remove coach ──────────────────────────────────────────────
  const assignCoach = useCallback(async (customerId: string, coachId: string) => {
    try {
      const customer = allCustomersAll.find(c => c._id === customerId) ??
        (customerRecord?._id === customerId ? customerRecord : null)
      if (!customer) return false
      const currentIds: string[] = customer.assignedCoachIds ?? []
      if (currentIds.includes(coachId)) return false
      await updateCustomerMutation({
        id: customerId as any,
        assignedCoachIds: [...currentIds, coachId],
      })
      return true
    } catch (err) {
      console.error('Failed to assign coach:', err)
      return false
    }
  }, [allCustomersAll, customerRecord, updateCustomerMutation])

  const removeCoach = useCallback(async (customerId: string, coachId: string) => {
    try {
      const customer = allCustomersAll.find(c => c._id === customerId) ??
        (customerRecord?._id === customerId ? customerRecord : null)
      if (!customer) return false
      const currentIds: string[] = customer.assignedCoachIds ?? []
      await updateCustomerMutation({
        id: customerId as any,
        assignedCoachIds: currentIds.filter(id => id !== coachId),
      })
      return true
    } catch (err) {
      console.error('Failed to remove coach:', err)
      return false
    }
  }, [allCustomersAll, customerRecord, updateCustomerMutation])

  // ── Credit balance ───────────────────────────────────────────────────
  const getCreditBalance = useCallback((userId: string) => {
    const c = allCustomersAll.find(c => c._id === userId)
    if (c) return c.creditBalance ?? 0
    if (customerRecord && customerRecord._id === userId) return customerRecord.creditBalance ?? 0
    return 0
  }, [allCustomersAll, customerRecord])

  const addCredit = useCallback(async (userId: string, amount: number) => {
    try {
      const c = allCustomersAll.find(c => c._id === userId)
      if (!c) return false
      const current = c.creditBalance ?? 0
      await updateCustomerMutation({
        id: userId as any,
        creditBalance: current + amount,
      })
      return true
    } catch {
      return false
    }
  }, [allCustomersAll, updateCustomerMutation])

  const useCredit = useCallback((_userId: string, _amount: number) => {
    return true
  }, [])

  // ── Coach invites ────────────────────────────────────────────────────
  const getCoachInvites = useCallback(() => {
    return coachInviteRecords.map(inv => ({
      id: inv._id,
      token: inv.token,
      name: inv.name,
      email: inv.email,
      phone: inv.phone ?? '',
      createdBy: inv.createdBy,
      createdAt: inv.createdAt ?? new Date().toISOString(),
      used: inv.used,
      usedAt: inv.usedAt,
    }))
  }, [coachInviteRecords])

  const createCoachInvite = useCallback(async (name: string, email: string, phone: string) => {
    try {
      const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      await createCoachInviteMutation({
        token,
        name,
        email,
        phone,
        createdBy: user?.email ?? 'admin',
      })
      return { success: true, token }
    } catch (err: any) {
      return { success: false, error: err?.message ?? 'Failed to create invite' }
    }
  }, [createCoachInviteMutation, user])

  // ── Create user (admin) — uses upsertCustomer ────────────────────────
  const createUser = useCallback(async (name: string, email: string, _password: string, role: string, phone?: string) => {
    try {
      await upsertCustomerMutation({
        name,
        email: email.toLowerCase().trim(),
        phone: phone ?? '',
        role: role,
      })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? 'Failed to create user' }
    }
  }, [upsertCustomerMutation])

  // ── Change password (admin action) ──────────────────────────────────
  const changeUserPassword = useCallback(async (userId: string, newPassword: string) => {
    try {
      const target = allCustomersAll.find(c => c._id === userId)
      if (!target?.email) return { success: false, error: 'User email not found' }
      await adminSetPasswordAction({ email: target.email, password: newPassword })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? 'Failed to change password' }
    }
  }, [allCustomersAll, adminSetPasswordAction])

  // ── Coach tier (stored in customer record coachTier field) ─
  const getCoachTier = useCallback((userId: string) => {
    const c = allCustomersAll.find(c => c._id === userId)
    return (c?.coachTier as string | undefined) ?? 'L1'
  }, [allCustomersAll])

  const setCoachTier = useCallback(async (userId: string, tier: string) => {
    try {
      await updateCustomerMutation({ id: userId as any, coachTier: tier })
      return true
    } catch (err) {
      console.error('Failed to set coach tier:', err)
      return false
    }
  }, [updateCustomerMutation])

  return {
    user,
    isAuthenticated,
    isCoach,
    isCustomer,
    isAdmin,
    customerRecord,
    getAllCoaches,
    getAllCustomers,
    getUserById,
    assignCoach,
    removeCoach,
    getCreditBalance,
    addCredit,
    useCredit,
    getCoachInvites,
    createCoachInvite,
    createUser,
    changeUserPassword,
    getCoachTier,
    setCoachTier,
    isLoading,
  }
}
