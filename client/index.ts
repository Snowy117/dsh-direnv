/**
 * dsh-direnv — browser half (client plugin).
 *
 * Owns the user-facing surface of the plugin and nothing else: the right-column
 * `direnv` tab (status card, environment details, credential roster), the
 * composer placeholder shown while a workspace environment is still loading,
 * and the failure toast. Host authority stays on the host half — this half only
 * polls `GET /plugins/dsh-direnv/status.json` and never writes anything back.
 *
 * Three constraints shape the wiring below and none of them is visible in a
 * failing run (DESIGN.md §7.1):
 * - a tab type and its body are two registrations, and the body's keyed seat is
 *   keyed by the tab type's `id` — a `kind` key silently renders nothing;
 * - the body's registration has to be deferred through `slots.inject`, since
 *   the seat is not declared before the sidebar plugin mounts;
 * - the module table answers a fixed seed list rather than the profile's
 *   packages, so the whole half is bundled into one plain script, every element
 *   is a `createElement` call, and the two specifiers it names (`react` and the
 *   UI primitives) are pinned by the artifact scan in
 *   `test/client-contract.test.ts`.
 */

import { createNotifier, DirenvSessionHook } from './composer.ts'
import { PLUGIN_ID, TAB_KIND } from './constants.ts'
import type { ClientContext, Dispose } from './ctx.ts'
import { safeService } from './ctx.ts'
import { report } from './ctx.ts'
import type { DockProps } from './composer.ts'
import { createStatusHub } from './hub.ts'
import { createTranslate } from './messages.ts'
import type { PanelProps, TitleProps } from './panel.ts'
import { DirenvGlyph, DirenvPanel, DirenvTabTitle } from './panel.ts'
import { installPrimitives } from './primitives.ts'
import type { RequireFn } from './react.ts'
import { installReact } from './react.ts'

interface ModuleDefinition {
  id: string
  factory(require: RequireFn): ClientPlugin
}

interface ModuleLoader {
  load(definition: ModuleDefinition): void
}

interface ClientPlugin {
  name: string
  inject: readonly string[]
  apply(ctx: ClientContext): void
}

declare global {
  interface Window {
    /** The web shell's module table: the only module mechanism a client plugin gets. */
    __ModuleLoader__: ModuleLoader
  }
}

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory(load) {
    installReact(load)
    installPrimitives(load)
    return {
      name: PLUGIN_ID,
      // `slots` + `sidebarRightTabs` are the tab's two stages; `conversation`
      // carries the composer block and the toast. `locale` and `sessions` are
      // read opportunistically so a composition missing them still shows a
      // working tab in the detected browser language.
      inject: ['slots', 'sidebarRightTabs', 'conversation'],
      apply(ctx) {
        const disposers: Dispose[] = []
        const t = createTranslate(safeService(ctx, 'locale'), disposers)
        const hub = createStatusHub(ctx, t)

        disposers.push(
          ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => t('tab'),
            guide: [
              {
                id: PLUGIN_ID,
                order: 50,
                title: () => t('tab'),
                description: () => t('guide.description'),
                icon: DirenvGlyph,
              },
            ],
          }),
        )

        disposers.push(
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register<PanelProps>(
              {
                name: 'sidebar.right.pane.tab',
                key: PLUGIN_ID,
                inject: (sessionId: string): PanelProps => ({ sessionId, t, hub }),
              },
              DirenvPanel,
            ),
          ),
        )

        disposers.push(
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register<TitleProps>(
              {
                name: 'sidebar.right.pane.tab.title',
                key: PLUGIN_ID,
                inject: (): TitleProps => ({ t }),
              },
              DirenvTabTitle,
            ),
          ),
        )

        disposers.push(
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register<DockProps>(
              {
                name: 'conversation.input.dock',
                id: PLUGIN_ID,
                order: 90,
                inject: (sessionId: string): DockProps => ({
                  sessionId,
                  hub,
                  notify: createNotifier(ctx, sessionId),
                }),
              },
              DirenvSessionHook,
            ),
          ),
        )

        ctx.effect(() => () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch (error) {
              report(error)
            }
          }
          hub.dispose()
        })
      },
    }
  },
})
