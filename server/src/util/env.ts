// ========================= //
// = Copyright (c) NullDev = //
// =     - SPDX: MIT -     = //
// ========================= //

// NODE_ENV decides how the server behaves. The package scripts set it (start:dev, start:prod), and so does
// pm2.ecosystem.json. Anything that is not exactly "development" counts as production: a server that was
// started without the variable must not write real reports into the development database.
export const isDevelopment = process.env.NODE_ENV === "development";
export const isProduction = !isDevelopment;
export const envName = isDevelopment ? "development" : "production";
// whether NODE_ENV was set to one of the two values at all
export const envWasSet = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "production";
