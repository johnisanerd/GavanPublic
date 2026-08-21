import { readFileSync } from "fs";

// Load .env.local manually (no dotenv dependency)
try {
  const envFile = readFileSync(new URL("../.env.local", import.meta.url), "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch { /* no .env.local */ }

import { Template } from "e2b";

const template = Template()
  .fromTemplate("claude-code-latest")
  .npmInstall(["@anthropic-ai/claude-code@latest"]);

console.log("Building aisle-crosser-agent template (remote, no Docker)...");

const result = await Template.build(template, {
  alias: "aisle-crosser-agent",
  cpuCount: 2,
  memoryMB: 1024,
  onBuildLogs: (log) => process.stdout.write(log.message || ""),
});

console.log("\nBuild complete!");
console.log("Template ID:", result.templateId);
console.log("Alias:", result.alias);
