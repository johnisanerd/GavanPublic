const DEFAULT_NAMES = ["foo", "bar", "bin", "baz"];

export function createSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateUniqueSlug(
  name: string,
  existingSlugs: string[]
): string {
  const slug = createSlug(name);

  // If empty slug, use default name
  if (!slug) {
    // Find first available default name
    for (const defaultName of DEFAULT_NAMES) {
      if (!existingSlugs.includes(defaultName)) {
        return defaultName;
      }
    }

    // All defaults taken, add numbers
    let counter = 2;
    while (existingSlugs.includes(`${DEFAULT_NAMES[0]}${counter}`)) {
      counter++;
    }
    return `${DEFAULT_NAMES[0]}${counter}`;
  }

  // If slug is unique, return it
  if (!existingSlugs.includes(slug)) {
    return slug;
  }

  // Add number suffix
  let counter = 2;
  while (existingSlugs.includes(`${slug}${counter}`)) {
    counter++;
  }
  return `${slug}${counter}`;
}
