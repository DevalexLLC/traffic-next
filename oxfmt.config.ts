import { defineConfig } from "oxfmt";

export default defineConfig({
  // `.sonarlint/connectedMode.json` is written by the SonarLint IDE extension, which reformats it
  // on its own terms; formatting it here just makes `fmt:check` fail the next time the IDE
  // rewrites it.
  ignorePatterns: ["dist/", ".sonarlint/"],
  sortImports: true,
});
