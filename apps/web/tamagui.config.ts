import { createTamagui } from 'tamagui'

import { fontFamilies, spacingScale, typeScale } from './src/design/tokens'

const sizeTokens = Object.fromEntries(
  Object.entries(typeScale).map(([key, value]) => [key, value]),
) as Record<keyof typeof typeScale | 'true', number>
sizeTokens.true = typeScale[3]

const spaceTokens = Object.fromEntries(
  Object.entries(spacingScale).map(([key, value]) => [key, value]),
) as Record<keyof typeof spacingScale | 'true', number>
spaceTokens.true = spacingScale[4]

const serifFont = {
  family: fontFamilies.serif,
  size: sizeTokens,
  lineHeight: {
    1: 16,
    2: 18,
    3: 22,
    4: 26,
    5: 32,
    6: 40,
    7: 50,
    8: 60,
    9: 74,
    true: 32,
  },
  weight: {
    4: '400',
    5: '500',
    6: '600',
    true: '500',
  },
  letterSpacing: {
    true: 0,
  },
}

const sansFont = {
  family: fontFamilies.sans,
  size: sizeTokens,
  lineHeight: {
    1: 16,
    2: 18,
    3: 22,
    4: 26,
    5: 32,
    6: 40,
    7: 50,
    8: 60,
    9: 74,
    true: 16,
  },
  weight: {
    4: '400',
    5: '500',
    6: '600',
    true: '400',
  },
  letterSpacing: {
    true: 0,
  },
}

export const config = createTamagui({
  tokens: {
    size: sizeTokens,
    space: spaceTokens,
    radius: {
      0: 0,
      1: 2,
      2: 4,
      3: 8,
      true: 4,
    },
    zIndex: {
      1: 1,
      2: 2,
      true: 1,
    },
    color: {
      ink: '#111111',
      paper: '#fbfaf8',
      muted: '#66615b',
      rule: '#d8d2ca',
      accent: '#8f2f1f',
      darkInk: '#f5f1ea',
      darkPaper: '#151515',
      darkMuted: '#beb7ad',
      darkRule: '#3b3834',
    },
  },
  fonts: {
    heading: serifFont,
    body: sansFont,
  },
  themes: {
    light: {
      background: '#fbfaf8',
      color: '#111111',
      muted: '#66615b',
      borderColor: '#d8d2ca',
      accent: '#8f2f1f',
    },
    dark: {
      background: '#151515',
      color: '#f5f1ea',
      muted: '#beb7ad',
      borderColor: '#3b3834',
      accent: '#e49a86',
    },
  },
  settings: {
    styleCompat: 'react-native',
  },
})

export type AppTamaguiConfig = typeof config

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppTamaguiConfig {}
}
