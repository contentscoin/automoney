"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/** Heartbeats must expire even when an offline device stops updating the database. */
export function useReadiness() {
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setRefreshKey((key) => key + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return useQuery(api.readiness.getMine, { refreshKey });
}
