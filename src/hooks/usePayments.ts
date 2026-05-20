import { useState, useEffect, useCallback } from 'react'
import { getPaymentStore, type Payment } from '../lib/payment-store'

const store = getPaymentStore()

export function usePayments() {
  const [payments, setPayments] = useState<Payment[]>(() => store.getAll())

  useEffect(() => {
    return store.subscribe((p) => setPayments(p))
  }, [])

  const getByCoach = useCallback((coachId: string) => {
    return store.getByCoach(coachId)
  }, [payments])

  const addPayment = useCallback((payment: Omit<Payment, 'id' | 'createdAt'>) => {
    return store.addPayment(payment)
  }, [])

  const deletePayment = useCallback((paymentId: string) => {
    return store.deletePayment(paymentId)
  }, [])

  return { payments, getByCoach, addPayment, deletePayment }
}
