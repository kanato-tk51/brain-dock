"use client";

import { create } from "zustand";
import type { EntryType, Sensitivity } from "@/domain/schemas";

type Filters = {
  types: EntryType[];
  tags: string[];
  fromUtc?: string;
  toUtc?: string;
  sensitivity?: Sensitivity;
};

type UiState = {
  searchText: string;
  filters: Filters;
  setSearchText: (value: string) => void;
  toggleType: (type: EntryType) => void;
  setSensitivity: (value?: Sensitivity) => void;
  setDateRange: (fromUtc?: string, toUtc?: string) => void;
  setTags: (tags: string[]) => void;
  clearFilters: () => void;
};

const defaultFilters: Filters = {
  types: [],
  tags: [],
  sensitivity: undefined,
};

export const useUiStore = create<UiState>((set) => ({
  searchText: "",
  filters: defaultFilters,
  setSearchText: (value) => set({ searchText: value }),
  toggleType: (type) =>
    set((state) => {
      const exists = state.filters.types.includes(type);
      const types = exists
        ? state.filters.types.filter((v) => v !== type)
        : [...state.filters.types, type];
      return {
        filters: {
          ...state.filters,
          types,
        },
      };
    }),
  setSensitivity: (value) =>
    set((state) => ({
      filters: {
        ...state.filters,
        sensitivity: value,
      },
    })),
  setDateRange: (fromUtc, toUtc) =>
    set((state) => ({
      filters: {
        ...state.filters,
        fromUtc,
        toUtc,
      },
    })),
  setTags: (tags) =>
    set((state) => ({
      filters: {
        ...state.filters,
        tags,
      },
    })),
  clearFilters: () => set({ filters: defaultFilters, searchText: "" }),
}));
