"use client";

import dynamic from "next/dynamic";

const Agentation = dynamic(() => import("agentation").then((module) => module.Agentation), {
  ssr: false,
});

const enabled = process.env.NEXT_PUBLIC_AGENTATION_ENABLED === "1";
const endpoint = process.env.NEXT_PUBLIC_AGENTATION_ENDPOINT;

export function AgentationToolbar() {
  if (!enabled) {
    return null;
  }

  return <Agentation endpoint={endpoint} />;
}
