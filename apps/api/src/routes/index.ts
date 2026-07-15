import { registerAdminRoutes } from "./admin.js";
import { registerAuthRoutes } from "./auth.js";
import { registerGenerationRoutes } from "./generation.js";
import { registerImageProjectRoutes } from "./image-projects.js";
import { registerImageRoutes } from "./images.js";
import { registerOrderRoutes } from "./orders.js";
import { registerSystemRoutes } from "./system.js";
import type { ApiRouteApp, ApiRouteContext } from "./types.js";

export function registerApiRoutes(app: ApiRouteApp, context: ApiRouteContext): void {
  registerSystemRoutes(app, context);
  registerAuthRoutes(app, context);
  registerGenerationRoutes(app, context);
  registerImageRoutes(app, context);
  registerImageProjectRoutes(app, context);
  registerOrderRoutes(app, context);
  registerAdminRoutes(app, context);
}

export type { ApiRouteContext } from "./types.js";
