/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as audit from "../audit.js";
import type * as channels from "../channels.js";
import type * as co from "../co.js";
import type * as creao_callback from "../creao/callback.js";
import type * as creao_http from "../creao/http.js";
import type * as creao_runs from "../creao/runs.js";
import type * as creao_verify from "../creao/verify.js";
import type * as creao_verifyData from "../creao/verifyData.js";
import type * as crons from "../crons.js";
import type * as dev from "../dev.js";
import type * as dispatcher from "../dispatcher.js";
import type * as executor from "../executor.js";
import type * as feed from "../feed.js";
import type * as gate from "../gate.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as inbox from "../inbox.js";
import type * as issues from "../issues.js";
import type * as labels from "../labels.js";
import type * as lib_catalog from "../lib/catalog.js";
import type * as lib_co from "../lib/co.js";
import type * as lib_envelope from "../lib/envelope.js";
import type * as lib_executor from "../lib/executor.js";
import type * as lib_gate from "../lib/gate.js";
import type * as lib_labelSpecs from "../lib/labelSpecs.js";
import type * as lib_nessie from "../lib/nessie.js";
import type * as lib_radar from "../lib/radar.js";
import type * as lib_recurring from "../lib/recurring.js";
import type * as lib_routing from "../lib/routing.js";
import type * as lib_rules from "../lib/rules.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as lib_types from "../lib/types.js";
import type * as nessie from "../nessie.js";
import type * as nessieApi from "../nessieApi.js";
import type * as onboarding from "../onboarding.js";
import type * as radar from "../radar.js";
import type * as rules from "../rules.js";
import type * as seed from "../seed.js";
import type * as seedData from "../seedData.js";
import type * as story from "../story.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  audit: typeof audit;
  channels: typeof channels;
  co: typeof co;
  "creao/callback": typeof creao_callback;
  "creao/http": typeof creao_http;
  "creao/runs": typeof creao_runs;
  "creao/verify": typeof creao_verify;
  "creao/verifyData": typeof creao_verifyData;
  crons: typeof crons;
  dev: typeof dev;
  dispatcher: typeof dispatcher;
  executor: typeof executor;
  feed: typeof feed;
  gate: typeof gate;
  health: typeof health;
  http: typeof http;
  inbox: typeof inbox;
  issues: typeof issues;
  labels: typeof labels;
  "lib/catalog": typeof lib_catalog;
  "lib/co": typeof lib_co;
  "lib/envelope": typeof lib_envelope;
  "lib/executor": typeof lib_executor;
  "lib/gate": typeof lib_gate;
  "lib/labelSpecs": typeof lib_labelSpecs;
  "lib/nessie": typeof lib_nessie;
  "lib/radar": typeof lib_radar;
  "lib/recurring": typeof lib_recurring;
  "lib/routing": typeof lib_routing;
  "lib/rules": typeof lib_rules;
  "lib/time": typeof lib_time;
  "lib/tokens": typeof lib_tokens;
  "lib/types": typeof lib_types;
  nessie: typeof nessie;
  nessieApi: typeof nessieApi;
  onboarding: typeof onboarding;
  radar: typeof radar;
  rules: typeof rules;
  seed: typeof seed;
  seedData: typeof seedData;
  story: typeof story;
  tasks: typeof tasks;
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
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  marketingPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"marketingPool">;
  customerPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"customerPool">;
  financePool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"financePool">;
  leadershipPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"leadershipPool">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
  aggregate: import("@convex-dev/aggregate/_generated/component.js").ComponentApi<"aggregate">;
};
