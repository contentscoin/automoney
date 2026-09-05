/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as analytics from "../analytics.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as clicks from "../clicks.js";
import type * as commissionRules from "../commissionRules.js";
import type * as content from "../content.js";
import type * as crons from "../crons.js";
import type * as curation from "../curation.js";
import type * as dashboard from "../dashboard.js";
import type * as devices from "../devices.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as jobs from "../jobs.js";
import type * as kyc from "../kyc.js";
import type * as lib_attrangs_adapter from "../lib/attrangs/adapter.js";
import type * as lib_attrangs_mock from "../lib/attrangs/mock.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_commissionEngine from "../lib/commissionEngine.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_mcpTools from "../lib/mcpTools.js";
import type * as lib_meta_adapter from "../lib/meta/adapter.js";
import type * as lib_meta_graph from "../lib/meta/graph.js";
import type * as lib_meta_index from "../lib/meta/index.js";
import type * as lib_meta_mock from "../lib/meta/mock.js";
import type * as lib_onboarding from "../lib/onboarding.js";
import type * as lib_pieces from "../lib/pieces.js";
import type * as lib_rbac from "../lib/rbac.js";
import type * as lib_search_provider from "../lib/search/provider.js";
import type * as lib_stats from "../lib/stats.js";
import type * as lib_time from "../lib/time.js";
import type * as links from "../links.js";
import type * as magazines from "../magazines.js";
import type * as mcp from "../mcp.js";
import type * as meta from "../meta.js";
import type * as orders from "../orders.js";
import type * as products from "../products.js";
import type * as schedules from "../schedules.js";
import type * as settings from "../settings.js";
import type * as settlements from "../settlements.js";
import type * as spaces from "../spaces.js";
import type * as telegram from "../telegram.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  analytics: typeof analytics;
  audit: typeof audit;
  auth: typeof auth;
  clicks: typeof clicks;
  commissionRules: typeof commissionRules;
  content: typeof content;
  crons: typeof crons;
  curation: typeof curation;
  dashboard: typeof dashboard;
  devices: typeof devices;
  http: typeof http;
  invites: typeof invites;
  jobs: typeof jobs;
  kyc: typeof kyc;
  "lib/attrangs/adapter": typeof lib_attrangs_adapter;
  "lib/attrangs/mock": typeof lib_attrangs_mock;
  "lib/audit": typeof lib_audit;
  "lib/commissionEngine": typeof lib_commissionEngine;
  "lib/crypto": typeof lib_crypto;
  "lib/errors": typeof lib_errors;
  "lib/mcpTools": typeof lib_mcpTools;
  "lib/meta/adapter": typeof lib_meta_adapter;
  "lib/meta/graph": typeof lib_meta_graph;
  "lib/meta/index": typeof lib_meta_index;
  "lib/meta/mock": typeof lib_meta_mock;
  "lib/onboarding": typeof lib_onboarding;
  "lib/pieces": typeof lib_pieces;
  "lib/rbac": typeof lib_rbac;
  "lib/search/provider": typeof lib_search_provider;
  "lib/stats": typeof lib_stats;
  "lib/time": typeof lib_time;
  links: typeof links;
  magazines: typeof magazines;
  mcp: typeof mcp;
  meta: typeof meta;
  orders: typeof orders;
  products: typeof products;
  schedules: typeof schedules;
  settings: typeof settings;
  settlements: typeof settlements;
  spaces: typeof spaces;
  telegram: typeof telegram;
  users: typeof users;
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

export declare const components: {};
