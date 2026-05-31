"use client";

import dynamic from "next/dynamic";

type AgentationProps = {
  readonly endpoint?: string;
};

const enabled = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_AGENTATION_ENABLED === "1";
const endpoint = process.env.NEXT_PUBLIC_AGENTATION_ENDPOINT;

const Agentation = enabled
  ? dynamic<AgentationProps>(() => import("agentation").then((module) => module.Agentation), {
      ssr: false,
    })
  : null;

export function AgentationToolbar() {
  if (!enabled || !Agentation) {
    return null;
  }

  return <Agentation endpoint={endpoint} />;
}
