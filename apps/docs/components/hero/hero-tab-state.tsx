"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

export type HeroTab = "Prompt" | "CLI" | "Skill";

interface HeroTabState {
  readonly activeTab: HeroTab;
  readonly setActiveTab: (tab: HeroTab) => void;
}

const HeroTabContext = createContext<HeroTabState | null>(null);

export function HeroTabProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTab] = useState<HeroTab>("Prompt");
  const value = useMemo(() => ({ activeTab, setActiveTab }), [activeTab]);

  return (
    <HeroTabContext.Provider value={value}>{children}</HeroTabContext.Provider>
  );
}

export function useHeroTab(): HeroTabState {
  const state = useContext(HeroTabContext);
  if (!state) {
    throw new Error("useHeroTab must be used inside HeroTabProvider.");
  }
  return state;
}
