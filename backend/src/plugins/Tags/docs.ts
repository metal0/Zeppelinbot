import { trimPluginDescription } from "src/utils";
import { TemplateFunction } from "./types";

export function generateTemplateMarkdown(definitions: TemplateFunction[]): string {
  return definitions
    .map(def => {
      const usage = def.signature ?? `(${def.arguments.join(", ")})`;
      const exampl = def.examples ? def.examples.map(ex => `> ${ex}`).join("\n") : "";
      return trimPluginDescription(`
      ### ${def.name}
      \`{${def.name}${usage}}\`
      **${def.description}**
      ${exampl}`);
    })
    .join("\n\n");
}
