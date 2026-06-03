/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountMerge from "../accountMerge.js";
import type * as adminGate from "../adminGate.js";
import type * as adminGateActions from "../adminGateActions.js";
import type * as adminPassword from "../adminPassword.js";
import type * as adminPasswordTrigger from "../adminPasswordTrigger.js";
import type * as analytics from "../analytics.js";
import type * as athletes from "../athletes.js";
import type * as auth from "../auth.js";
import type * as closures from "../closures.js";
import type * as crons from "../crons.js";
import type * as emails from "../emails.js";
import type * as faults from "../faults.js";
import type * as googleCalendar from "../googleCalendar.js";
import type * as googleCalendarMutations from "../googleCalendarMutations.js";
import type * as http from "../http.js";
import type * as laneBlocks from "../laneBlocks.js";
import type * as lanes from "../lanes.js";
import type * as lib_adminGuard from "../lib/adminGuard.js";
import type * as lib_bookingWindow from "../lib/bookingWindow.js";
import type * as lib_credit from "../lib/credit.js";
import type * as lib_discounts from "../lib/discounts.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_lanes from "../lib/lanes.js";
import type * as lib_locations from "../lib/locations.js";
import type * as lib_names from "../lib/names.js";
import type * as lib_priceDefaults from "../lib/priceDefaults.js";
import type * as lib_pricing from "../lib/pricing.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_slotHolds from "../lib/slotHolds.js";
import type * as lib_systemCancel from "../lib/systemCancel.js";
import type * as lib_waPostcodes from "../lib/waPostcodes.js";
import type * as lockMutations from "../lockMutations.js";
import type * as locks from "../locks.js";
import type * as mates from "../mates.js";
import type * as mutations from "../mutations.js";
import type * as queries from "../queries.js";
import type * as registrationLock from "../registrationLock.js";
import type * as reminderAction from "../reminderAction.js";
import type * as reminderQueries from "../reminderQueries.js";
import type * as slotHolds from "../slotHolds.js";
import type * as statements from "../statements.js";
import type * as stripe from "../stripe.js";
import type * as stripeWebhook from "../stripeWebhook.js";
import type * as users from "../users.js";
import type * as waitlist from "../waitlist.js";
import type * as webhooks from "../webhooks.js";
import type * as weeklySummary from "../weeklySummary.js";
import type * as weeklySummaryQueries from "../weeklySummaryQueries.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountMerge: typeof accountMerge;
  adminGate: typeof adminGate;
  adminGateActions: typeof adminGateActions;
  adminPassword: typeof adminPassword;
  adminPasswordTrigger: typeof adminPasswordTrigger;
  analytics: typeof analytics;
  athletes: typeof athletes;
  auth: typeof auth;
  closures: typeof closures;
  crons: typeof crons;
  emails: typeof emails;
  faults: typeof faults;
  googleCalendar: typeof googleCalendar;
  googleCalendarMutations: typeof googleCalendarMutations;
  http: typeof http;
  laneBlocks: typeof laneBlocks;
  lanes: typeof lanes;
  "lib/adminGuard": typeof lib_adminGuard;
  "lib/bookingWindow": typeof lib_bookingWindow;
  "lib/credit": typeof lib_credit;
  "lib/discounts": typeof lib_discounts;
  "lib/email": typeof lib_email;
  "lib/lanes": typeof lib_lanes;
  "lib/locations": typeof lib_locations;
  "lib/names": typeof lib_names;
  "lib/priceDefaults": typeof lib_priceDefaults;
  "lib/pricing": typeof lib_pricing;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/slotHolds": typeof lib_slotHolds;
  "lib/systemCancel": typeof lib_systemCancel;
  "lib/waPostcodes": typeof lib_waPostcodes;
  lockMutations: typeof lockMutations;
  locks: typeof locks;
  mates: typeof mates;
  mutations: typeof mutations;
  queries: typeof queries;
  registrationLock: typeof registrationLock;
  reminderAction: typeof reminderAction;
  reminderQueries: typeof reminderQueries;
  slotHolds: typeof slotHolds;
  statements: typeof statements;
  stripe: typeof stripe;
  stripeWebhook: typeof stripeWebhook;
  users: typeof users;
  waitlist: typeof waitlist;
  webhooks: typeof webhooks;
  weeklySummary: typeof weeklySummary;
  weeklySummaryQueries: typeof weeklySummaryQueries;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
