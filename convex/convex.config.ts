import { defineApp } from "convex/server";
// LOCAL INSTALL: mount our own betterAuth component (convex/betterAuth/) whose
// schema declares the admin-plugin fields (role/banned/banReason/banExpires/mode).
// The packaged @convex-dev/better-auth/convex.config component's adapter.create
// validator omits those fields → sign-up 422 FAILED_TO_CREATE_USER. The local
// adapter.ts re-exports the same create/findOne/... API but validates against the
// local schema. @see https://convex-better-auth.netlify.app/features/local-install
import betterAuth from "./betterAuth/convex.config";

const app = defineApp();
app.use(betterAuth);

export default app;
