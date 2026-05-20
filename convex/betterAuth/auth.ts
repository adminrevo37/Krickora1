/**
 * Static Auth Export for Schema Generation
 * Run: npx @better-auth/cli generate -y
 * Shipper auth template version: convex-better-auth-0.10.10+better-auth-1.4.9
 * @see https://convex-better-auth.netlify.app/features/local-install
 */
import { createAuth } from "../auth";

// Export a static instance for Better Auth schema generation
export const auth = createAuth({} as never);
