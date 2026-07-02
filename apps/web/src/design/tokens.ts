export const fontFamilies = {
  serif: 'Newsreader',
  sans: 'Inter',
} as const

export const typeScale = {
  1: 12,
  2: 14,
  3: 16,
  4: 20,
  5: 24,
  6: 32,
  7: 40,
  8: 48,
  9: 60,
} as const

export const spacingScale = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
  9: 96,
} as const

export const designTokens = {
  fontFamilies,
  typeScale,
  spacingScale,
} as const
