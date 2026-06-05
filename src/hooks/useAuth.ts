import { useCallback, useMemo, useEffect, useRef } from 'react'
import { useQuery, useMutation, useAction } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useSession, readHadSession, writeHadSession } from '../lib/auth-client'
import { useImpersonation } from './useImpersonation'

/**
 * Module-level deduplication guard for customer record auto-creation.
 *
 * useAuth is mounted in many components simultaneously (root layout, home page,
 * BookingCalendar, MyBookings, etc.). Without this guard, every instance fires
 * its own useEffect when customerRecord === null, causing a burst of concurrent
 * upsertCustomer calls — one "Not authorized" error per component instance.
 *
 * The Set tracks which emails have already had a creation attempt initiated in
 * this browser session. Only the FIRST instance to check calls the mutation;
 * all others skip immediately. The email is removed on error to allow retry.
 */
const _customerCreateAttempted = new Set<string>()

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
  // ── Impersonation state ───────────────────────────────────────────────
  // When admin impersonates a user, override email/name/role on the returned
  // `user` object so every page (Statements, Profile, etc.) automatically loads
  // that user's data. isAdmin stays true based on real auth so the admin panel
  // and exit-impersonation remain accessible.
  const { impersonatedUser, isImpersonating } = useImpersonation()

  // ── Better Auth session (client-side, has proper isPending) ──────────
  const { data: session, isPending: sessionPending } = useSession()

  // ── Better Auth user from Convex (server-side, real-time) ────────────
  const betterAuthUser = useQuery(api.auth.getCurrentUser)

  // ── Stabilization: track if we were ever authenticated ───────────────
  // This prevents a transient 401/403 (from blocked tracker CORS) from
  // immediately flipping isAuthenticated to false and triggering a redirect.
  //
  // SPEC_AUTH_LOADING_SMOOTHING §3b — seed the ref from the persisted
  // `krickora.hadSession` hint so a hard refresh starts in the "authenticated"
  // stance (showing the loading spinner, not the signed-out header) until the
  // session re-validates. The hint is written when auth is confirmed and cleared
  // on a definitive no-session below + in signOutUser, so a genuinely logged-out
  // visitor never starts true.
  const wasAuthenticatedRef = useRef(readHadSession())
  // Update the ref + persist the hint when we confirm authentication
  if (betterAuthUser && !wasAuthenticatedRef.current) {
    wasAuthenticatedRef.current = true
  }
  // Keep the persisted hint in sync with the live auth state (idempotent writes).
  useEffect(() => {
    if (betterAuthUser) writeHadSession(true)
  }, [betterAuthUser])

  // ── TRUE loading state ───────────────────────────────────────────────
  // We consider it "loading" if:
  // 1. The Better Auth client is still fetching the session (sessionPending), OR
  // 2. The client says we have a session but Convex hasn't returned the user yet, OR
  // 3. We WERE authenticated but Convex user went undefined (transient error) —
  //    keep loading=true instead of flashing unauthenticated UI
  const isInTransientError = wasAuthenticatedRef.current && betterAuthUser === undefined && !sessionPending && !!session?.user
  // SPEC_AUTH_LOADING_SMOOTHING §3b — while the session hint says we had a session,
  // hold "loading" until the Convex identity (getCurrentUser) actually resolves, so a
  // brief sessionPending=false / session=null window on hard refresh shows the spinner
  // instead of flashing the signed-out header. getCurrentUser never throws and resolves
  // to null when unauthenticated, so this can never stick — once betterAuthUser is no
  // longer undefined the term is false and we fall through to the definitive decision.
  const isHintedReauth = wasAuthenticatedRef.current && betterAuthUser === undefined
  const isLoading = sessionPending
    || (!!session?.user && betterAuthUser === undefined)
    || isInTransientError
    || isHintedReauth

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
      // Clear the stabilization flag + persisted hint — user genuinely signed out
      // (or the token expired). Clearing the hint here stops the next refresh from
      // spinning on a session that no longer exists.
      wasAuthenticatedRef.current = false
      writeHadSession(false)
      return false
    }
    // Fallback: keep previous state
    return wasAuthenticatedRef.current
  })()

  // ── Customer record (SPEC_AUTH_LOADING_SMOOTHING §3c) ────────────────
  // Sourced from the merged getCurrentUser query (which now returns the caller's
  // customers row nested as `customer`) instead of a second sequential
  // getCustomerByEmail round-trip. Identity + profile arrive together, so postcode/
  // role/etc. are never briefly undefined after the user resolves (kills the flash
  // gap) and one Convex subscription is dropped. Shape is the full customers doc, so
  // every customerRecord consumer below is unchanged. Trichotomy preserved:
  //   undefined → still loading / logged out (matches the old 'skip' behaviour)
  //   null      → authenticated but no customers row yet (triggers auto-create)
  //   <doc>     → ready. Stays reactive to customers edits (getCurrentUser reads them).
  const customerRecord = betterAuthUser
    ? ((betterAuthUser as any).customer ?? null)
    : undefined

  const allCoachRecords = useQuery(api.queries.listCustomersByRole, { role: 'coach' }) ?? []
  // SEC-1: listCustomers / listCoachInvites are admin-only — they throw "Unauthenticated"
  // for logged-out and non-admin callers. useAuth runs on every page, so calling them
  // unconditionally crashes the whole app at the root. Gate them on the viewer actually
  // being an admin (derived from their own record, which returns null safely when logged out).
  const isAdminViewer = (customerRecord?.role ?? null) === 'admin'
  const allCustomersAll = useQuery(api.queries.listCustomers, isAdminViewer ? {} : 'skip') ?? []
  const coachInviteRecords = useQuery(api.queries.listCoachInvites, isAdminViewer ? {} : 'skip') ?? []

  // ── Convex mutations ─────────────────────────────────────────────────
  const updateCustomerMutation = useMutation(api.mutations.updateCustomer)
  const createCoachInviteMutation = useMutation(api.mutations.createCoachInvite)
  const useCustomerCreditMutation = useMutation(api.mutations.useCustomerCredit)
  const adminSetPasswordAction = useAction(api.adminPassword.adminSetPassword)
  // updateCustomerByEmailMutation: the ONLY mutation used for customer creation/update.
  // Confirmed present in the deployed Convex backend (initial commit, no auth check).
  // Creates the record if it doesn't exist. Used for both:
  //   1. Auto-create on first login/signup (own email)
  //   2. Admin creating a new customer record (any email)
  // upsertCustomer is intentionally NOT used — it calls requireAdmin in the deployed
  // backend and throws "Not authorized" for every non-admin user.
  const updateCustomerByEmailMutation = useMutation(api.mutations.updateCustomerByEmail)

  // ── Auto-create customer record if missing ───────────────────────────
  // Uses updateCustomerByEmail — confirmed deployed in production Convex.
  // This mutation: (1) creates the customer record if it doesn't exist,
  // (2) requires only that the caller is authenticated and uses their own email.
  // It does NOT call requireAdmin for self-updates.
  //
  // NOT using upsertCustomer — it calls requireAdmin in the deployed backend
  // and throws "Not authorized" for every non-admin user.
  //
  // The module-level _customerCreateAttempted Set ensures only ONE call fires
  // across ALL simultaneous useAuth instances (root layout, home page,
  // BookingCalendar, MyBookings, etc.).
  //
  // updateCustomerByEmailMutation is intentionally NOT in the dependency array —
  // Convex useMutation returns a new reference each render, which would cause
  // the effect to re-fire on every render while customerRecord is null.
  useEffect(() => {
    if (betterAuthUser?.email && customerRecord === null) {
      const email = betterAuthUser.email.toLowerCase().trim()
      // Skip if another useAuth instance already initiated this
      if (_customerCreateAttempted.has(email)) return
      _customerCreateAttempted.add(email)
      updateCustomerByEmailMutation({
        email,
        name: betterAuthUser.name ?? betterAuthUser.email.split('@')[0],
      }).catch((err) => {
        console.error('Failed to auto-create customer record:', err)
        // Only allow retry for TRANSIENT errors (network, timeout).
        // Do NOT retry on auth/authorization errors — prevents infinite retry loops.
        const msg: string = err?.message ?? ''
        const isAuthError = msg.includes('Not authorized') || msg.includes('Unauthorized') || msg.includes('not authorized') || msg.includes('Authentication required')
        if (!isAuthError) {
          _customerCreateAttempted.delete(email)
        }
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betterAuthUser?.email, betterAuthUser?.name, customerRecord])


  // ── Derived role from Convex ─────────────────────────────────────────
  const customerRole = customerRecord?.role ?? 'customer'
  const isCoach = customerRole === 'coach'
  const isCustomer = customerRole === 'customer'
  const isAdmin = customerRole === 'admin'

  // Build user object compatible with existing UI
  const user = useMemo(() => {
    if (!betterAuthUser) return null
    const base = {
      id: betterAuthUser.id,
      name: betterAuthUser.name ?? betterAuthUser.email.split('@')[0],
      email: betterAuthUser.email,
      phone: customerRecord?.phone as string | undefined,
      role: customerRole as 'customer' | 'coach' | 'admin',
      color: (customerRecord as any)?.color as string | undefined,
      // SPEC_PROFILE_POSTCODE_SUBURB — drives the hard-block login gate + profile.
      postcode: (customerRecord as any)?.postcode as string | undefined,
      suburb: (customerRecord as any)?.suburb as string | undefined,
      // SIGNUP-VERIFY-LOCKDOWN (2026-06) — drives the non-dismissable "verify your
      // email" gate in __root. true once the Better Auth account is verified.
      emailVerified: (betterAuthUser as any).emailVerified === true,
    }
    // When impersonating, override email/name/role so every page that reads
    // user.email (Statements, Profile, Bookings) loads the impersonated user's
    // data. isAdmin is preserved from real auth so admin pages stay accessible.
    // Impersonated views are never gated (admin is verified).
    if (isImpersonating && impersonatedUser) {
      return {
        ...base,
        name: impersonatedUser.name,
        email: impersonatedUser.email,
        role: impersonatedUser.role as 'customer' | 'coach' | 'admin',
        emailVerified: true,
      }
    }
    return base
  }, [betterAuthUser, customerRecord, customerRole, isImpersonating, impersonatedUser])

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
    // N-10: callers pass the auth subject (user.id), which is NOT customers._id,
    // so the lookups never matched for a normal customer → getCreditBalance always
    // returned 0, hiding the credit badge AND the "apply credit" option at checkout
    // (credit showed on the Payments page, which reads the record directly, but was
    // unusable when booking). Fall back to the signed-in user's own record whether
    // userId is their customers._id OR their auth-subject id.
    if (customerRecord && (customerRecord._id === userId || userId === user?.id)) {
      return customerRecord.creditBalance ?? 0
    }
    return 0
  }, [allCustomersAll, customerRecord, user])

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

  const useCredit = useCallback(async (userId: string, amount: number): Promise<boolean> => {
    // Look up the customer's email from their Convex _id
    const c = allCustomersAll.find((c: any) => c._id === userId)
    if (!c?.email) return false
    try {
      await useCustomerCreditMutation({ email: c.email, amount })
      return true
    } catch {
      return false
    }
  }, [allCustomersAll, useCustomerCreditMutation])

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

  // ── Create user (admin) — uses updateCustomerByEmail ─────────────────
  // updateCustomerByEmail has no requireAdmin check in the deployed Convex backend,
  // so it works for both admin-created records and self-signup auto-create.
  const createUser = useCallback(async (name: string, email: string, _password: string, role: string, phone?: string) => {
    try {
      await updateCustomerByEmailMutation({
        name,
        email: email.toLowerCase().trim(),
        phone: phone ?? '',
        role: role,
      })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? 'Failed to create user' }
    }
  }, [updateCustomerByEmailMutation])

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

  // True once the signed-in user's Convex customer record has actually resolved
  // (not just betterAuthUser). The postcode gate must wait for this, else it flashes
  // on refresh while the record is still in flight (user.postcode is briefly undefined).
  const profileReady = isAuthenticated && customerRecord !== undefined

  return {
    user,
    isAuthenticated,
    profileReady,
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
