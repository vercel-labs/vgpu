import { getProviderData } from "@flags-sdk/vercel";
import { createFlagsDiscoveryEndpoint } from "flags/next";
import { flagDefinitions } from "@/flags";

export const GET = createFlagsDiscoveryEndpoint(() =>
  getProviderData(flagDefinitions),
);
