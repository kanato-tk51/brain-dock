"use client";

import { create } from "zustand";

type SessionState = {
  isLocked: boolean;
  checked: boolean;
  setLockState: (locked: boolean) => void;
  markChecked: () => void;
};

export const useSessionStore = create<SessionState>((set) => ({
  isLocked: false,
  checked: false,
  setLockState: (locked) => set({ isLocked: locked, checked: true }),
  markChecked: () => set({ checked: true }),
}));
