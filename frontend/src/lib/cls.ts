/** Zero-dependency `clsx`: joins the truthy class fragments. */
export function cls(...parts: Array<string | false | null | undefined | 0>): string {
  return parts.filter(Boolean).join(' ');
}
