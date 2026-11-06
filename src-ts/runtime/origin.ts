const standardSchemes = new Set<string>()

export function registerStandardSchemes(schemes: string[]): void {
  for (const scheme of schemes) if (/^[a-z][a-z0-9+.-]*$/.test(scheme)) standardSchemes.add(scheme + ':')
}

export function documentOrigin(value: string): string {
  const url = new URL(value)
  if (url.origin !== 'null') return url.origin
  return standardSchemes.has(url.protocol) && url.hostname && !url.username && !url.password
    ? url.protocol + '//' + url.host : 'null'
}
