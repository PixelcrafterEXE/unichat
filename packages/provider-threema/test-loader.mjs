// Maps NodeNext-style "./x.js" specifiers to "./x.ts" so tests run without a build step.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(s, c, next) {
  if (s.startsWith(".") && s.endsWith(".js")) { try { return await next(s.slice(0, -3) + ".ts", c); } catch {} }
  return next(s, c);
}`));
