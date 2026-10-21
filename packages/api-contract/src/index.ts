// SPDX-License-Identifier: MIT
/**
 * `@paylink/api-contract`: the public contract of the PayPal edition's API (`apps/api`), shared by the Worker and the
 * web edition (docs/paypal/SPEC.md §13, ADR 0018). Types and constants only, no dependency: importing it pulls no
 * server code into a page.
 *
 * | Module     | Routes                                              | Owner (docs/paypal/SPEC.md "Ownership") |
 * |------------|-----------------------------------------------------|------------------------------------------|
 * | common.ts  | route table, problems, PayPal and chain enumerations | foundation                               |
 * | session.ts | POST /v1/session                                    | reconciler                               |
 * | twin.ts    | POST /v1/twin, GET /v1/twin/:key, GET /v1/rails/:key | PayPal spine                             |
 * | desk.ts    | GET /v1/desk, POST /v1/desk/sweep, /:id/{approve,reject,undo} | reconciler                     |
 * | check.ts   | POST /v1/check                                      | reconciler                               |
 * | ai.ts      | POST /v1/ai/draft                                   | AI                                       |
 * | health.ts  | GET /v1/health                                      | foundation                               |
 *
 * @packageDocumentation
 */
export * from "./ai.ts";
export type * from "./check.ts";
export * from "./common.ts";
export type * from "./desk.ts";
export * from "./health.ts";
export * from "./session.ts";
export type * from "./twin.ts";
