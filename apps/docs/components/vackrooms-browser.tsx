"use client";

import { useEffect } from "react";
import { installVackroomsBrowser } from "@/lib/vackrooms-browser";

export function VackroomsBrowser() {
  useEffect(() => installVackroomsBrowser(), []);
  return null;
}
