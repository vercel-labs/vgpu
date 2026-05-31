"use client";

import { useEffect, useState } from "react";
import type { ComponentType } from "react";

type AgentationProps = {
  readonly endpoint?: string;
};

const enabled = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_AGENTATION_ENABLED === "1";
const endpoint = process.env.NEXT_PUBLIC_AGENTATION_ENDPOINT;

export function AgentationToolbar() {
  const [Agentation, setAgentation] = useState<ComponentType<AgentationProps> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    void import("agentation").then((module) => {
      if (mounted) setAgentation(() => module.Agentation as ComponentType<AgentationProps>);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!enabled || !Agentation) {
    return null;
  }

  return <Agentation endpoint={endpoint} />;
}
