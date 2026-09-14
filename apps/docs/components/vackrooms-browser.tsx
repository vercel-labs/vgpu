"use client";

import { useEffect } from "react";
import { installVackroomsBrowser } from "@/lib/vackrooms-browser";
import { installVackroomsCrt } from "@/lib/vackrooms-crt";

export function VackroomsBrowser() {
  useEffect(() => installVackroomsBrowser(), []);
  useEffect(() => installVackroomsCrt(), []);
  return null;
}
