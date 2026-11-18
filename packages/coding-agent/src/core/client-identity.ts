import type { ClientIdentity } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";

/** How pi's requests identify it to providers: a detailed `User-Agent` with pi's version, and no attribution. */
export function getClientIdentity(): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: null,
	};
}
