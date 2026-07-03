// oxlint-disable-next-line import/no-unassigned-import -- One root layout owns global CSS.
import './root.css'

import { Slot } from 'one'
import { TamaguiProvider, Theme } from 'tamagui'

import { config } from '../tamagui.config'

export function Layout() {
  return (
    <html lang="en-US">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>press</title>
      </head>
      <body>
        <TamaguiProvider config={config} defaultTheme="light">
          <Theme name="light">
            <Slot />
          </Theme>
        </TamaguiProvider>
      </body>
    </html>
  )
}
