export type UserRole = 'customer' | 'coach' | 'admin'
export type CoachTier = 'L1' | 'L2' | 'Bowling' | 'BowlingL2'

export interface User {
  id: string
  name: string
  email: string
  phone?: string
  passwordHash: string
  role: UserRole
  coachTier?: CoachTier
  createdAt: string
  assignedCoachIds?: string[]
  creditBalance?: number
}

export interface CoachInvite {
  id: string
  token: string
  name: string
  email: string
  phone: string
  createdBy: string
  createdAt: string
  usedAt?: string
  used: boolean
}

type AuthListener = (user: User | null) => void

class UserStore {
  private users: User[] = []
  private coachInvites: CoachInvite[] = []
  private currentUser: User | null = null
  private listeners: Set<AuthListener> = new Set()

  constructor() {
    try {
      const saved = localStorage.getItem('rst_users')
      if (saved) this.users = JSON.parse(saved)
      const invites = localStorage.getItem('rst_coach_invites')
      if (invites) this.coachInvites = JSON.parse(invites)
      const sessionId = localStorage.getItem('rst_session')
      if (sessionId) this.currentUser = this.users.find(u => u.id === sessionId) ?? null
    } catch {}
    // Ensure admin account always exists and is up to date
    const existingAdmin = this.users.find(u => u.id === 'admin-001')
    if (existingAdmin) {
      existingAdmin.email = 'admin@revolutionsports.com.au'
      existingAdmin.passwordHash = btoa('Revo20261!')
      existingAdmin.role = 'admin'
      existingAdmin.name = existingAdmin.name || 'Admin'
      this.persist()
    } else {
      // Remove any other admin accounts and create the canonical one
      this.users = this.users.map(u => u.role === 'admin' && u.id !== 'admin-001' ? { ...u, role: 'customer' as UserRole } : u)
      this.users.push({
        id: 'admin-001', name: 'Admin', email: 'admin@revolutionsports.com.au',
        passwordHash: btoa('Revo20261!'), role: 'admin', createdAt: new Date().toISOString(),
      })
      this.persist()
    }
    // Also ensure any user with admin email always has admin role
    const adminByEmail = this.users.find(u => u.email === 'admin@revolutionsports.com.au' && u.id !== 'admin-001')
    if (adminByEmail) {
      adminByEmail.role = 'admin'
      this.persist()
    }
    // Ensure all coaches without a tier default to L1
    let needsPersist = false
    for (const u of this.users) {
      if (u.role === 'coach' && !u.coachTier) {
        u.coachTier = 'L1'
        needsPersist = true
      }
    }
    if (needsPersist) this.persist()
  }

  private persist() {
    localStorage.setItem('rst_users', JSON.stringify(this.users))
    localStorage.setItem('rst_coach_invites', JSON.stringify(this.coachInvites))
    if (this.currentUser) localStorage.setItem('rst_session', this.currentUser.id)
    else localStorage.removeItem('rst_session')
  }

  private notify() { this.listeners.forEach(fn => fn(this.currentUser)) }

  getCurrentUser(): User | null { return this.currentUser }
  getUserById(id: string): User | null { return this.users.find(u => u.id === id) ?? null }
  getUserRole(): UserRole | null { return this.currentUser?.role ?? null }
  isAdmin(): boolean { return this.currentUser?.role === 'admin' }
  isCoach(): boolean { return this.currentUser?.role === 'coach' }

  getCoachTier(userId?: string): CoachTier | null {
    const id = userId ?? this.currentUser?.id
    if (!id) return null
    const user = this.users.find(u => u.id === id)
    if (!user || user.role !== 'coach') return null
    return user.coachTier ?? 'L1'
  }

  setCoachTier(userId: string, tier: CoachTier): boolean {
    if (!this.currentUser || this.currentUser.role !== 'admin') return false
    const user = this.users.find(u => u.id === userId)
    if (!user || user.role !== 'coach') return false
    user.coachTier = tier
    if (this.currentUser?.id === userId) this.currentUser.coachTier = tier
    this.persist()
    this.notify()
    return true
  }

  signUp(name: string, email: string, password: string, phone?: string): { success: boolean; error?: string; user?: User } {
    const normalizedEmail = email.toLowerCase().trim()
    if (this.users.find(u => u.email === normalizedEmail)) return { success: false, error: 'An account with this email already exists. Please sign in.' }
    if (password.length < 6) return { success: false, error: 'Password must be at least 6 characters.' }
    if (!name.trim()) return { success: false, error: 'Please enter your name.' }
    const user: User = {
      id: crypto.randomUUID(), name: name.trim(), email: normalizedEmail,
      phone: phone?.trim() || undefined, passwordHash: btoa(password),
      role: 'customer', createdAt: new Date().toISOString(), creditBalance: 0,
    }
    this.users.push(user)
    this.currentUser = user
    this.persist()
    this.notify()
    return { success: true, user }
  }

  signIn(email: string, password: string): { success: boolean; error?: string; user?: User } {
    const normalizedEmail = email.toLowerCase().trim()
    const user = this.users.find(u => u.email === normalizedEmail)
    if (!user) return { success: false, error: 'No account found with this email. Please create an account.' }
    if (user.passwordHash !== btoa(password)) return { success: false, error: 'Incorrect password. Please try again.' }
    this.currentUser = user
    this.persist()
    this.notify()
    return { success: true, user }
  }

  signOut() { this.currentUser = null; localStorage.removeItem('rst_session'); this.notify() }

  updateProfile(updates: Partial<Pick<User, 'name' | 'phone'>>): boolean {
    if (!this.currentUser) return false
    if (updates.name) this.currentUser.name = updates.name.trim()
    if (updates.phone !== undefined) this.currentUser.phone = updates.phone.trim() || undefined
    const idx = this.users.findIndex(u => u.id === this.currentUser!.id)
    if (idx >= 0) this.users[idx] = { ...this.currentUser }
    this.persist(); this.notify()
    return true
  }

  addCredit(userId: string, amount: number): void {
    const user = this.users.find(u => u.id === userId)
    if (!user) return
    user.creditBalance = (user.creditBalance ?? 0) + amount
    if (this.currentUser?.id === userId) this.currentUser.creditBalance = user.creditBalance
    this.persist(); this.notify()
  }

  useCredit(userId: string, amount: number): number {
    const user = this.users.find(u => u.id === userId)
    if (!user) return 0
    const available = user.creditBalance ?? 0
    const used = Math.min(available, amount)
    user.creditBalance = available - used
    if (this.currentUser?.id === userId) this.currentUser.creditBalance = user.creditBalance
    this.persist(); this.notify()
    return used
  }

  getCreditBalance(userId: string): number {
    return this.users.find(u => u.id === userId)?.creditBalance ?? 0
  }

  assignCoach(customerId: string, coachId: string): boolean {
    const customer = this.users.find(u => u.id === customerId)
    if (!customer || customer.role !== 'customer') return false
    if (!customer.assignedCoachIds) customer.assignedCoachIds = []
    if (customer.assignedCoachIds.includes(coachId)) return false
    customer.assignedCoachIds.push(coachId)
    if (this.currentUser?.id === customerId) this.currentUser.assignedCoachIds = customer.assignedCoachIds
    this.persist(); this.notify()
    return true
  }

  removeCoach(customerId: string, coachId: string): boolean {
    const customer = this.users.find(u => u.id === customerId)
    if (!customer) return false
    customer.assignedCoachIds = (customer.assignedCoachIds ?? []).filter(id => id !== coachId)
    if (this.currentUser?.id === customerId) this.currentUser.assignedCoachIds = customer.assignedCoachIds
    this.persist(); this.notify()
    return true
  }

  createCoachInvite(name: string, email: string, phone: string): { success: boolean; error?: string; invite?: CoachInvite } {
    if (!this.currentUser || this.currentUser.role !== 'admin') return { success: false, error: 'Only admins can create coach accounts.' }
    const normalizedEmail = email.toLowerCase().trim()
    if (this.users.find(u => u.email === normalizedEmail)) return { success: false, error: 'An account with this email already exists.' }
    if (this.coachInvites.find(i => i.email === normalizedEmail && !i.used)) return { success: false, error: 'An unused invite already exists for this email.' }
    const token = crypto.randomUUID().replace(/-/g, '')
    const invite: CoachInvite = {
      id: crypto.randomUUID(), token, name: name.trim(), email: normalizedEmail,
      phone: phone.trim(), createdBy: this.currentUser.id, createdAt: new Date().toISOString(), used: false,
    }
    this.coachInvites.push(invite)
    this.persist()
    return { success: true, invite }
  }

  getCoachInvites(): CoachInvite[] { return [...this.coachInvites].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) }
  getInviteByToken(token: string): CoachInvite | null { return this.coachInvites.find(i => i.token === token && !i.used) ?? null }

  setupCoachPassword(token: string, password: string): { success: boolean; error?: string; user?: User } {
    const invite = this.coachInvites.find(i => i.token === token && !i.used)
    if (!invite) return { success: false, error: 'This setup link is invalid or has already been used.' }
    if (password.length < 6) return { success: false, error: 'Password must be at least 6 characters.' }
    if (this.users.find(u => u.email === invite.email)) return { success: false, error: 'An account with this email already exists.' }
    const user: User = {
      id: crypto.randomUUID(), name: invite.name, email: invite.email, phone: invite.phone,
      passwordHash: btoa(password), role: 'coach', coachTier: 'L1', createdAt: new Date().toISOString(),
    }
    this.users.push(user)
    invite.used = true
    invite.usedAt = new Date().toISOString()
    this.currentUser = user
    this.persist(); this.notify()
    return { success: true, user }
  }

  createUser(name: string, email: string, password: string, role: 'coach' | 'customer', phone?: string, coachTier?: CoachTier): { success: boolean; error?: string; user?: User } {
    if (!this.currentUser || this.currentUser.role !== 'admin') return { success: false, error: 'Only admins can create accounts.' }
    if (!name.trim()) return { success: false, error: 'Please enter a name.' }
    if (!email.trim()) return { success: false, error: 'Please enter an email.' }
    if (password.length < 6) return { success: false, error: 'Password must be at least 6 characters.' }
    const normalizedEmail = email.toLowerCase().trim()
    if (this.users.find(u => u.email === normalizedEmail)) return { success: false, error: 'An account with this email already exists.' }
    const user: User = {
      id: crypto.randomUUID(), name: name.trim(), email: normalizedEmail,
      phone: phone?.trim() || undefined, passwordHash: btoa(password),
      role, coachTier: role === 'coach' ? (coachTier ?? 'L1') : undefined,
      createdAt: new Date().toISOString(), creditBalance: 0,
    }
    this.users.push(user)
    this.persist()
    return { success: true, user }
  }

  changeUserPassword(userId: string, newPassword: string): { success: boolean; error?: string } {
    if (!this.currentUser || this.currentUser.role !== 'admin') return { success: false, error: 'Only admins can change passwords.' }
    if (newPassword.length < 6) return { success: false, error: 'Password must be at least 6 characters.' }
    const user = this.users.find(u => u.id === userId)
    if (!user) return { success: false, error: 'User not found.' }
    user.passwordHash = btoa(newPassword)
    this.persist()
    return { success: true }
  }

  getAllCoaches(): User[] { return this.users.filter(u => u.role === 'coach') }
  getAllCustomers(): User[] { return this.users.filter(u => u.role === 'customer') }

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

let instance: UserStore | null = null
export function getUserStore(): UserStore {
  if (!instance) instance = new UserStore()
  return instance
}
