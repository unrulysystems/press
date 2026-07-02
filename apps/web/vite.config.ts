import { tamaguiAliases, tamaguiPlugin } from '@tamagui/vite-plugin'
import { one } from 'one/vite'

const makeTamaguiPlugin = tamaguiPlugin as unknown as (options: unknown) => unknown
const makeOnePlugin = one as unknown as (options: unknown) => unknown

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
