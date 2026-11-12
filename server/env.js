import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const rest = value.slice(1);
      if (rest.endsWith(quote)) {
        value = rest.slice(0, -1);
      } else {
        const parts = [rest];
        let closed = false;
        while (index + 1 < lines.length) {
          index += 1;
          const nextLine = lines[index];
          if (nextLine.endsWith(quote)) {
            parts.push(nextLine.slice(0, -1));
            closed = true;
            break;
          }
          parts.push(nextLine);
        }
        value = parts.join("\n");
        if (!closed) {
          value = value.trim();
        }
      }
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
