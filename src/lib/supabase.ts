import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    storage:            AsyncStorage,
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: false,
  },
});

// React Native suspends JS timers while the app is backgrounded, so the auth
// client's autoRefreshToken timer does not fire during that time and can
// leave a stale access token in place on resume. Wiring start/stop to
// AppState forces a refresh check on foreground and stops the refresh timer
// while backgrounded, per Supabase's documented React Native setup.
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// redirectTo is required: without it, Supabase falls back to the Site URL
// and lands the user on the marketing homepage instead of the page that
// forwards into the app via plated://reset-password. Confirmed empirically.
//
// Never throws "no account with that email" — GoTrue's /recover endpoint
// always answers success regardless of whether the address has an account,
// specifically so this can't be used to enumerate registered emails. A
// thrown error here is a real failure (network, rate limit), not a signal
// about account existence.
export async function requestPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: "https://platedapp.uk/reset-password",
  });
  if (error) throw error;
}

// Assumes a live session already exists — see App.tsx's password recovery
// deep link handler, which calls setSession() with the recovery tokens
// before this is ever reachable.
export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}
