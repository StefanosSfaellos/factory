const TOKEN = /(ghp_|glpat-)[A-Za-z0-9_-]{10,}/g

export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of [...secrets].filter((x) => x).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('[redacted]')
  }
  return out.replace(TOKEN, '[redacted]')
}
