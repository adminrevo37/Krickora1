// Payment tracking for coach statements

export interface Payment {
  id: string
  coachId: string
  amount: number
  dateReceived: string // YYYY-MM-DD
  note?: string
  createdAt: string
  createdBy: string // admin user id
}

type PaymentListener = (payments: Payment[]) => void

class PaymentStore {
  private payments: Payment[] = []
  private listeners: Set<PaymentListener> = new Set()

  constructor() {
    try {
      const saved = localStorage.getItem('rst_payments')
      if (saved) this.payments = JSON.parse(saved)
    } catch {}
  }

  private persist() {
    localStorage.setItem('rst_payments', JSON.stringify(this.payments))
  }

  private notify() {
    const snapshot = this.getAll()
    this.listeners.forEach(fn => fn(snapshot))
  }

  getAll(): Payment[] {
    return [...this.payments]
  }

  getByCoach(coachId: string): Payment[] {
    return this.payments
      .filter(p => p.coachId === coachId)
      .sort((a, b) => a.dateReceived.localeCompare(b.dateReceived))
  }

  addPayment(payment: Omit<Payment, 'id' | 'createdAt'>): Payment {
    const newPayment: Payment = {
      ...payment,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    this.payments.push(newPayment)
    this.persist()
    this.notify()
    return newPayment
  }

  deletePayment(paymentId: string): boolean {
    const idx = this.payments.findIndex(p => p.id === paymentId)
    if (idx === -1) return false
    this.payments.splice(idx, 1)
    this.persist()
    this.notify()
    return true
  }

  subscribe(listener: PaymentListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

let instance: PaymentStore | null = null
export function getPaymentStore(): PaymentStore {
  if (!instance) instance = new PaymentStore()
  return instance
}
