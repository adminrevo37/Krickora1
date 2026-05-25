export interface ImpersonatedUser {
  id: string
  name: string
  email: string
  role: string
}

const STORAGE_KEY = 'rst_impersonate'
export const IMPERSONATION_EVENT = 'rst:impersonation-change'

export function getImpersonation(): ImpersonatedUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function startImpersonation(user: ImpersonatedUser): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
  window.dispatchEvent(new Event(IMPERSONATION_EVENT))
}

export function stopImpersonation(): void {
  localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new Event(IMPERSONATION_EVENT))
}
