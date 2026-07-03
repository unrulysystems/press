import { tamaguiAliases, tamaguiPlugin } from '@tamagui/vite-plugin'
import { one } from 'one/vite'

import type { Plugin } from 'vite'

const makeTamaguiPlugin = tamaguiPlugin as unknown as (options: unknown) => unknown
const makeOnePlugin = one as unknown as (options: unknown) => unknown
const useGetModulePath = '/@tamagui/use-event/dist/esm/useGet.mjs'

function tamaguiUseEventReactImportPlugin(): Plugin {
  return {
    name: 'press:tamagui-use-event-react-import',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes(useGetModulePath)) {
        return null
      }
      const transformed = code
        .replace(
          'import * as React from "react";',
          'import { useCallback, useInsertionEffect, useLayoutEffect, useRef } from "react";',
        )
        .replace(
          'const useIsomorphicInsertionEffect = React.useInsertionEffect || React.useLayoutEffect;',
          'const useIsomorphicInsertionEffect = useInsertionEffect || useLayoutEffect;',
        )
        .replace('React.useRef(', 'useRef(')
        .replace('React.useCallback(', 'useCallback(')

      return {
        code: transformed,
        map: null,
      }
    },
  }
}

export default {
  resolve: {
    alias: [
      ...tamaguiAliases({
        rnwLite: 'without-animated',
        svg: true,
      }),
    ],
  },
  ssr: {
    external: ['@opentelemetry/semantic-conventions'],
    noExternal: true,
  },
  plugins: [
    tamaguiUseEventReactImportPlugin(),
    makeTamaguiPlugin({
      config: './tamagui.config.ts',
      components: ['tamagui'],
    }),
    makeOnePlugin({
      setupFile: {
        server: './src/setupServer.ts',
      },
      web: {
        defaultRenderMode: 'spa',
        inlineLayoutCSS: true,
      },
    }),
  ],
}
