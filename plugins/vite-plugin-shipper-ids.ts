// shipper-ids-plugin-version: 2025-12-30-v4
// NOTE: Keep this version in sync with the API's expected version in `ai-tools.ts`
export const SHIPPER_IDS_PLUGIN_VERSION = "2025-12-30-v4";

import { Plugin } from "vite";
import { parse } from "@babel/parser";
import _traverse, { NodePath } from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import path from "path";

// Handle default exports for CommonJS modules
type TraverseModule = typeof _traverse & { default?: typeof _traverse };
type GenerateModule = typeof _generate & { default?: typeof _generate };

const traverse = (((_traverse as TraverseModule).default || _traverse) as typeof _traverse);
const generate = (((_generate as GenerateModule).default || _generate) as typeof _generate);

// Debug flag - set to true to see all processed files
const DEBUG_SHIPPER_IDS = process.env.DEBUG_SHIPPER_IDS === "true";

export function shipperIdsPlugin(): Plugin {
  let root = "";

  return {
    name: "vite-plugin-shipper-ids",
    enforce: "pre",

    configResolved(config) {
      root = config.root;
      if (DEBUG_SHIPPER_IDS) {
        console.log("[shipper-ids-plugin] Plugin initialized with root:", root);
      }
    },

    transform(code, id) {
      // Only process in dev mode - production builds should not have shipper IDs
      if (process.env.NODE_ENV !== "development") {
        return null;
      }

      // Skip node_modules
      if (id.includes("node_modules")) {
        return null;
      }

      // Only process JSX/TSX files (including virtual modules from TanStack Router)
      // TanStack Router may use module IDs like: /absolute/path/to/routes/index.tsx?v=xxx
      const cleanId = id.split("?")[0]; // Remove query params
      if (!/\.[jt]sx$/.test(cleanId)) {
        return null;
      }

      // Debug: log which files are being processed
      const isRouteFile = id.includes("/routes/") || id.includes("\\routes\\");
      if (DEBUG_SHIPPER_IDS || isRouteFile) {
        console.log("[shipper-ids-plugin] Processing file:", id);
      }

      try {
        // Parse and transform
        const ast = parse(code, {
          sourceType: "module",
          plugins: ["jsx", "typescript"],
        });

        let hasChanges = false;
        let addedCount = 0;

        // Get relative path from src directory
        // Handle both normal paths and virtual module paths
        let sourceFile: string;
        if (cleanId.startsWith(root)) {
          const relativePath = path.relative(path.join(root, "src"), cleanId);
          sourceFile = relativePath.replace(/\.[jt]sx$/, "");
        } else {
          // For virtual modules, try to extract a meaningful path
          const srcIndex = cleanId.indexOf("/src/");
          if (srcIndex !== -1) {
            sourceFile = cleanId.slice(srcIndex + 5).replace(/\.[jt]sx$/, "");
          } else {
            sourceFile = path.basename(cleanId).replace(/\.[jt]sx$/, "");
          }
        }

        traverse(ast, {
          JSXElement(nodePath: NodePath<t.JSXElement>) {
            const { openingElement } = nodePath.node;
            const elementName = openingElement.name;

            // Only process JSX identifiers (skip member expressions like <Foo.Bar />)
            if (!t.isJSXIdentifier(elementName)) return;

            // Check if this is a custom component (PascalCase) or native element
            const isCustomComponent = /^[A-Z]/.test(elementName.name);

            // Skip certain elements that don't make sense to track
            const skipElements = ["Fragment", "Suspense", "StrictMode", "Profiler"];
            if (isCustomComponent && skipElements.includes(elementName.name)) return;

            // Check if already has data-shipper-id
            const hasId = openingElement.attributes.some(
              (attr: t.JSXAttribute | t.JSXSpreadAttribute) =>
                t.isJSXAttribute(attr) &&
                t.isJSXIdentifier(attr.name) &&
                attr.name.name === "data-shipper-id"
            );

            if (hasId) return;

            // Skip elements with spread attributes - they pass through props from parent
            // (e.g., <Comp {...props} /> in wrapper components)
            const hasSpread = openingElement.attributes.some(
              (attr: t.JSXAttribute | t.JSXSpreadAttribute) =>
                t.isJSXSpreadAttribute(attr)
            );

            if (hasSpread) return;

            // Generate stable ID based on location with full relative path
            const loc = openingElement.loc;
            if (!loc) return;

            const shipperId = `${sourceFile}:${loc.start.line}:${loc.start.column}`;

            // Add data-shipper-id attribute
            openingElement.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier("data-shipper-id"),
                t.stringLiteral(shipperId)
              )
            );

            hasChanges = true;
            addedCount++;
          },
        });

        if (!hasChanges) {
          if (DEBUG_SHIPPER_IDS && isRouteFile) {
            console.log("[shipper-ids-plugin] No changes needed for:", id);
          }
          return null;
        }

        if (DEBUG_SHIPPER_IDS || isRouteFile) {
          console.log("[shipper-ids-plugin] Added " + addedCount + " shipper IDs to:", sourceFile);
        }

        const output = generate(ast, {}, code);
        return {
          code: output.code,
          map: output.map,
        };
      } catch (error) {
        console.error(
          "[shipper-ids-plugin] Error transforming file:",
          id,
          error
        );
        return null;
      }
    },
  };
}
