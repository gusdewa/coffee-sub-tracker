import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import { watchUser } from './firebase'

export interface AuthState {
  user: User | null
  loading: boolean
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ user: null, loading: true })
  useEffect(() => watchUser((user) => setState({ user, loading: false })), [])
  return state
}
