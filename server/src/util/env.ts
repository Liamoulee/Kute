// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

export const isDevelopment = process.env.NODE_ENV === "development";
export const isProduction = !isDevelopment;
export const envName = isDevelopment ? "development" : "production";
export const envWasSet = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "production";
