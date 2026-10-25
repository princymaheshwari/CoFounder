/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as creao_callback from "../creao/callback.js";
import type * as creao_http from "../creao/http.js";
import type * as creao_runs from "../creao/runs.js";
import type * as creao_verify from "../creao/verify.js";
import type * as creao_verifyData from "../creao/verifyData.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as lib_envelope from "../lib/envelope.js";
import type * as lib_types from "../lib/types.js";
import type * as seed from "../seed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "creao/callback": typeof creao_callback;
  "creao/http": typeof creao_http;
  "creao/runs": typeof creao_runs;
  "creao/verify": typeof creao_verify;
  "creao/verifyData": typeof creao_verifyData;
  health: typeof health;
  http: typeof http;
  "lib/envelope": typeof lib_envelope;
  "lib/types": typeof lib_types;
  seed: typeof seed;
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
